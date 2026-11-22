import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, IsNotEmpty, ValidateNested } from 'class-validator';
import { DataSource, In } from 'typeorm';
import { Actor, Roles } from '../common/auth';
import { conflicto, invalido, noEncontrado } from '../common/errores';
import { folio, redondear, UuidPipe } from '../common/util';
import { REGLAS } from '../config/reglas';
import { ControlModule, ControlService } from '../control/control';
import { EventoPedido, Movimiento, Pedido, Resolucion, Tienda, Usuario } from '../database/entities';
import { FinanzasService } from '../finanzas/finanzas.service';
import { ConfiguracionService } from '../nucleo/configuracion.service';
import { PushService } from '../nucleo/push.service';
import { PedidosModule } from '../pedidos/pedidos.module';
import { PedidosService } from '../pedidos/pedidos.service';

export type Culpable = 'cliente' | 'tienda' | 'repartidor' | 'plataforma';
const CULPABLES: Culpable[] = ['cliente', 'tienda', 'repartidor', 'plataforma'];

export class AccionDto {
  @IsUUID() usuarioId: string;
  /** Positivo abona a su cartera, negativo le carga. */
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(-100000) @Max(100000) monto: number;
  @IsString() @IsNotEmpty() @MaxLength(160) concepto: string;
}

export class ResolverDto {
  @IsIn(CULPABLES) culpable: Culpable;
  @IsString() @IsNotEmpty() @MaxLength(500) nota: string;
  /** Lo que se acordó por teléfono o chat cuando ninguna sugerencia convenció. */
  @IsOptional() @IsString() @MaxLength(1000) acuerdo?: string;
  @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => AccionDto) acciones: AccionDto[];
}

export class ReintentarReembolsoDto {
  @IsIn(['tarjeta', 'cartera']) destino: 'tarjeta' | 'cartera';
}

type Participante = { usuarioId: string; rol: 'cliente' | 'tienda' | 'repartidor'; nombre: string };
type Accion = Participante & { monto: number; concepto: string };

@Injectable()
export class ResolucionesService {
  constructor(
    private readonly ds: DataSource,
    private readonly finanzas: FinanzasService,
    private readonly config: ConfiguracionService,
    private readonly push: PushService,
    private readonly pedidosSvc: PedidosService,
    private readonly control: ControlService,
  ) {}

  private async contexto(id: string) {
    const p = await this.ds.getRepository(Pedido).findOneBy({ id });
    if (!p) throw noEncontrado('Pedido no encontrado');
    const tienda = await this.ds.getRepository(Tienda).findOneBy({ id: p.tiendaId });
    const ids = [p.clienteId, tienda?.ownerId, p.repartidorId].filter(Boolean) as string[];
    const usuarios = await this.ds.getRepository(Usuario).findBy({ id: In(ids) });
    const nombre = (uid: string | null | undefined) => usuarios.find((u) => u.id === uid)?.nombre ?? '';
    const participantes: Participante[] = [];
    if (p.clienteId) participantes.push({ usuarioId: p.clienteId, rol: 'cliente', nombre: nombre(p.clienteId) });
    if (tienda) participantes.push({ usuarioId: tienda.ownerId, rol: 'tienda', nombre: tienda.nombre });
    if (p.repartidorId) participantes.push({ usuarioId: p.repartidorId, rol: 'repartidor', nombre: nombre(p.repartidorId) });

    const movs = await this.ds.getRepository(Movimiento).findBy({ pedidoId: p.id, tipo: In(['compensacion_repartidor', 'cargo_cancelacion']) });
    const compensacion = redondear(movs.filter((m) => m.tipo === 'compensacion_repartidor').reduce((s, m) => s + Number(m.monto), 0));
    const yaHuboCargo = movs.some((m) => m.tipo === 'cargo_cancelacion');
    const aceptado = await this.ds.getRepository(EventoPedido).existsBy({ pedidoId: p.id, tipo: 'aceptado_tienda' });
    return { p, tienda, participantes, compensacion, yaHuboCargo, aceptado };
  }

  /**
   * Compensaciones que se sugieren según de quién fue la culpa. Soporte puede editarlas, quitarlas
   * o agregar las que acuerde con las personas.
   */
  private async sugerencias(ctx: Awaited<ReturnType<ResolucionesService['contexto']>>): Promise<Record<Culpable, Accion[]>> {
    const { p, participantes, compensacion, yaHuboCargo, aceptado } = ctx;
    const cartera = await this.config.get('cartera');
    const disculpa = cartera.creditoDisculpa ?? REGLAS.cartera.creditoDisculpa;
    const de = (rol: Participante['rol']) => participantes.find((x) => x.rol === rol);
    const cliente = de('cliente');
    const tienda = de('tienda');
    const rep = de('repartidor');
    const envio = p.costoEnvio;
    const linea = (x: Participante | undefined, monto: number, concepto: string): Accion[] =>
      x && redondear(monto) ? [{ ...x, monto: redondear(monto), concepto }] : [];
    // El repartidor fue a la tienda pero el pedido se canceló antes de que lo recogiera: viaje en falso.
    const viajeEnFalso = !compensacion && !!rep;

    return {
      cliente: [
        ...(compensacion
          ? linea(cliente, -compensacion, 'Pedido que no recibió: lo que se le pagó al repartidor')
          : [...linea(rep, envio, 'Viaje en falso'), ...(viajeEnFalso ? linea(cliente, -envio, 'Viaje del repartidor que no se completó') : [])]),
        ...(aceptado && !yaHuboCargo && !compensacion
          ? [...linea(cliente, -cartera.cargoCancelacion, 'Cargo por cancelación: la tienda ya lo preparaba'), ...linea(tienda, cartera.cargoCancelacion, 'Compensación por pedido preparado')]
          : []),
      ],
      tienda: [
        ...linea(cliente, disculpa, 'Crédito de disculpa'),
        ...(compensacion
          ? linea(tienda, -compensacion, 'Lo que se le pagó al repartidor por la cancelación')
          : [...linea(rep, envio, 'Viaje en falso'), ...(viajeEnFalso ? linea(tienda, -envio, 'Viaje del repartidor que no se completó') : [])]),
        ...linea(tienda, -disculpa, 'Crédito de disculpa al cliente'),
      ],
      repartidor: [
        ...linea(cliente, disculpa, 'Crédito de disculpa'),
        ...linea(rep, -compensacion, 'Se revierte la compensación automática'),
      ],
      plataforma: [
        ...linea(cliente, disculpa, 'Crédito de disculpa'),
        ...(viajeEnFalso ? linea(rep, envio, 'Viaje en falso') : []),
      ],
    };
  }

  async ver(id: string) {
    const ctx = await this.contexto(id);
    const r = await this.ds.getRepository(Resolucion).findOneBy({ pedidoId: id });
    const tope = (await this.config.get('cartera')).ajusteMaxSoporte ?? REGLAS.cartera.ajusteMaxSoporte;
    let resolucion = null;
    if (r) {
      const quien = await this.ds.getRepository(Usuario).findOneBy({ id: r.resueltoPor });
      resolucion = { culpable: r.culpable, nota: r.nota, acuerdo: r.acuerdo, acciones: r.acciones, resueltoPor: { id: r.resueltoPor, nombre: quien?.nombre ?? '' }, creadoEn: r.creadoEn };
    }
    return {
      resolucion,
      compensacionRepartidor: ctx.compensacion,
      participantes: ctx.participantes,
      sugerencias: await this.sugerencias(ctx),
      topeSoporte: tope,
    };
  }

  async resolver(agente: Usuario, id: string, dto: ResolverDto) {
    const ctx = await this.contexto(id);
    const { p } = ctx;
    if (p.estado !== 'cancelado' && p.estado !== 'rechazado') throw conflicto('TRANSICION_INVALIDA', 'Solo se resuelven pedidos cancelados o rechazados');
    const acciones: Accion[] = dto.acciones.map((a, i) => {
      const x = ctx.participantes.find((y) => y.usuarioId === a.usuarioId);
      if (!x) throw invalido('Solo se puede abonar o cargar a quienes participaron en el pedido', `acciones.${i}.usuarioId`);
      if (!redondear(a.monto)) throw invalido('El monto no puede ser cero', `acciones.${i}.monto`);
      return { ...x, monto: redondear(a.monto), concepto: a.concepto.trim() };
    });
    await this.control.validarTopeSoporte(agente, acciones.map((a) => a.monto));
    const f = folio('R', p.folioNum);

    await this.ds.transaction(async (m) => {
      if (await m.existsBy(Resolucion, { pedidoId: p.id })) throw conflicto('YA_RESUELTO', 'Esta cancelación ya se resolvió');
      await m.insert(Resolucion, { pedidoId: p.id, culpable: dto.culpable, nota: dto.nota.trim(), acuerdo: dto.acuerdo?.trim() || null, acciones, resueltoPor: agente.id });
      await this.finanzas.abonar(m, acciones.map((a) => ({
        usuarioId: a.usuarioId, tiendaId: a.rol === 'tienda' ? p.tiendaId : null, pedidoId: p.id, tipo: 'resolucion' as const,
        monto: a.monto, descripcion: `${a.concepto} (pedido ${f})`,
      })));
      const textos: Record<Culpable, string> = { cliente: 'del cliente', tienda: 'de la tienda', repartidor: 'del repartidor', plataforma: 'de PaPedir' };
      await m.insert(EventoPedido, {
        pedidoId: p.id, tipo: 'cancelacion_resuelta', usuarioId: agente.id, rol: agente.rol,
        detalle: `Culpa ${textos[dto.culpable]}. ${dto.nota.trim()}${dto.acuerdo?.trim() ? ` · Acuerdo: ${dto.acuerdo.trim()}` : ''}`.slice(0, 1000),
      });
    });

    for (const a of acciones) {
      void this.push.aUsuarios([a.usuarioId], a.monto > 0 ? 'Abono en tu cartera' : 'Cargo en tu cartera', `${a.monto > 0 ? '+' : '−'}$${Math.abs(a.monto)}: ${a.concepto} (${f})`, { pedidoId: p.id });
    }
    return this.ver(id);
  }
}

/** Veces que una cuenta tuvo la culpa de una cancelación resuelta por soporte (para la ficha). */
export async function cancelacionesAtribuidas(ds: DataSource, u: Pick<Usuario, 'id' | 'rol'>) {
  if (u.rol !== 'cliente' && u.rol !== 'tienda' && u.rol !== 'repartidor') return null;
  const condicion = u.rol === 'cliente' ? 'p.cliente_id = $1' : u.rol === 'repartidor' ? 'p.repartidor_id = $1' : 't.owner_id = $1';
  const [r] = await ds.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE r.creado_en > now() - interval '30 days')::int AS "ultimos30"
     FROM resoluciones r JOIN pedidos p ON p.id = r.pedido_id JOIN tiendas t ON t.id = p.tienda_id
     WHERE r.culpable = $2 AND ${condicion}`,
    [u.id, u.rol],
  );
  return r as { total: number; ultimos30: number };
}

@Roles('soporte', 'admin')
@Controller('soporte')
export class ResolucionesController {
  constructor(private readonly svc: ResolucionesService, private readonly pedidos: PedidosService) {}

  @Get('pedidos/:id/resolucion') ver(@Param('id', UuidPipe) id: string) { return this.svc.ver(id); }

  @Post('pedidos/:id/resolucion') @HttpCode(200)
  resolver(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: ResolverDto) { return this.svc.resolver(u, id, dto); }

  @Post('pedidos/:id/reembolso/reintentar') @HttpCode(200)
  reintentar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: ReintentarReembolsoDto) {
    return this.pedidos.reintentarReembolso(u, id, dto.destino);
  }
}

@Module({
  imports: [ControlModule, PedidosModule],
  controllers: [ResolucionesController],
  providers: [ResolucionesService],
  exports: [ResolucionesService],
})
export class ResolucionesModule {}
