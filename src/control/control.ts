import {
  Body, Controller, Delete, Get, HttpCode, Injectable, Module, OnModuleInit, Param, Patch, Post, Put, Query, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsBoolean, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min,
  ValidateNested,
} from 'class-validator';
import { DataSource } from 'typeorm';
import { AuthModule } from '../auth/auth.module';
import { Actor, Publico, Roles } from '../common/auth';
import { pagina, PaginaDto } from '../common/dtos';
import { AppError, conflicto, invalido, noEncontrado } from '../common/errores';
import { redondear, UuidPipe } from '../common/util';
import { aplicarCatalogo, CATALOGO, CATALOGO_BASE, Catalogos } from '../config/catalogos';
import { ESTADOS_FINALES, EstadoPedido, REGLAS } from '../config/reglas';
import {
  CategoriaProducto, Calificacion, Documento, EnvioPush, EventoPedido, Liquidacion, Mensaje, Movimiento, Pedido, Producto, Tienda, Usuario,
} from '../database/entities';
import { DireccionDto, DireccionesModule, DireccionesService } from '../direcciones/direcciones';
import { DocumentosModule, DocumentosService } from '../documentos/documentos';
import { FinanzasService } from '../finanzas/finanzas.service';
import { AlmacenService } from '../nucleo/almacen.service';
import { ConfiguracionService } from '../nucleo/configuracion.service';
import { PushService } from '../nucleo/push.service';
import { RealtimeService } from '../nucleo/realtime.service';
import { CotizarPedidoDto, CrearPedidoDto } from '../pedidos/pedidos.dto';
import { PedidosModule } from '../pedidos/pedidos.module';
import { PedidosService } from '../pedidos/pedidos.service';
import { VehiculoDto } from '../repartidor/repartidor.dto';
import { RepartidorModule } from '../repartidor/repartidor.module';
import { RepartidorService } from '../repartidor/repartidor.service';
import { TicketDto, TicketsModule, TicketsService } from '../tickets/tickets';
import { CategoriaDto, CategoriaUpdateDto, HorarioDto, OpcionesProductoDto, ProductoDto, ProductoUpdateDto } from '../tiendas/tiendas.dto';
import { TiendasModule } from '../tiendas/tiendas.module';
import { TiendasService } from '../tiendas/tiendas.service';
import { subidaArchivo } from '../uploads/uploads';

// ─────────────────────────── DTOs

class MotivoDto {
  @IsString() @IsNotEmpty() @MaxLength(500) motivo: string;
}

export class PedidoAdminDto extends CrearPedidoDto {
  /** Cliente a cuyo nombre se hace el pedido. Siempre en efectivo: la tarjeta la confirma el cliente en su app. */
  @IsUUID() clienteId: string;
}

export class CotizarAdminDto extends CotizarPedidoDto {
  @IsUUID() clienteId: string;
}

export class EditarPedidoDto {
  @IsOptional() @IsString() @MaxLength(300) notas?: string | null;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) destinoNombre?: string;
  @IsOptional() @Matches(/^[0-9]{10}$/, { message: 'destinoTelefono debe tener 10 dígitos' }) destinoTelefono?: string;
  @IsOptional() @IsString() @MaxLength(200) destinoReferencias?: string | null;
  /** Solo pedidos en efectivo que no han terminado: el total se ajusta solo. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(REGLAS.pedido.propinaMax) propina?: number;
  @IsString() @IsNotEmpty() @MaxLength(500) motivo: string;
}

export class AsignarDto {
  @IsUUID() repartidorId: string;
  @IsString() @IsNotEmpty() @MaxLength(500) motivo: string;
}

export class TicketAdminDto extends TicketDto {
  /** A nombre de quién se abre (por ejemplo, alguien que llamó por teléfono). */
  @IsUUID() usuarioId: string;
}

export class AjusteDto {
  /** + abona a su favor; − le carga. */
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(-100000) @Max(100000) monto: number;
  @IsString() @IsNotEmpty() @MaxLength(500) motivo: string;
}

export class DocumentoAdminDto {
  @IsString() @IsNotEmpty() tipo: string;
  /** "true" = queda aprobado al subirlo (soporte ya vio el original). */
  @IsOptional() @IsIn(['true', 'false']) aprobar?: 'true' | 'false';
}

const CODIGO = /^[a-z0-9_]{2,40}$/;
class MotivoCatDto {
  @Matches(CODIGO, { message: 'codigo: minúsculas, números y guion bajo' }) codigo: string;
  @IsString() @IsNotEmpty() @MaxLength(80) texto: string;
  @IsBoolean() activo: boolean;
}
class MotivosCatDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => MotivoCatDto) cliente: MotivoCatDto[];
  @IsArray() @ValidateNested({ each: true }) @Type(() => MotivoCatDto) tienda: MotivoCatDto[];
  @IsArray() @ValidateNested({ each: true }) @Type(() => MotivoCatDto) soporte: MotivoCatDto[];
  @IsArray() @ValidateNested({ each: true }) @Type(() => MotivoCatDto) sistema: MotivoCatDto[];
}
class CategoriaCatDto {
  @Matches(CODIGO, { message: 'codigo: minúsculas, números y guion bajo' }) codigo: string;
  @IsString() @IsNotEmpty() @MaxLength(40) nombre: string;
  @IsBoolean() activa: boolean;
}
class DocumentoCatDto {
  @Matches(CODIGO, { message: 'tipo: minúsculas, números y guion bajo' }) tipo: string;
  @IsString() @IsNotEmpty() @MaxLength(60) nombre: string;
  @IsBoolean() obligatorio: boolean;
}
class DocumentosCatDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => DocumentoCatDto) repartidor: DocumentoCatDto[];
  @IsArray() @ValidateNested({ each: true }) @Type(() => DocumentoCatDto) tienda: DocumentoCatDto[];
  @IsBoolean() exigirParaAprobar: boolean;
}
class LegalCatDto {
  @IsString() @Matches(/^[0-9A-Za-z.\-]{1,20}$/, { message: 'versionTerminos: por ejemplo 2026-12' }) versionTerminos: string;
}
export class CatalogosDto {
  @ValidateNested() @Type(() => MotivosCatDto) motivos: MotivosCatDto;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => CategoriaCatDto) categorias: CategoriaCatDto[];
  @ValidateNested() @Type(() => DocumentosCatDto) documentos: DocumentosCatDto;
  @ValidateNested() @Type(() => LegalCatDto) legal: LegalCatDto;
}

export class EnviosPushDto extends PaginaDto {}

/** Siguiente paso que soporte puede forzar a mano (lo demás tiene su propia acción: asignar, completar). */
const SIGUIENTE: Partial<Record<EstadoPedido, EstadoPedido>> = {
  programado: 'creado',
  creado: 'aceptado_tienda',
  aceptado_tienda: 'listo_para_recoger',
  asignado: 'en_tienda',
  en_tienda: 'en_camino',
  en_camino: 'en_domicilio',
};

// ─────────────────────────── servicio

@Injectable()
export class ControlService implements OnModuleInit {
  constructor(
    private readonly ds: DataSource,
    private readonly direcciones: DireccionesService,
    private readonly documentos: DocumentosService,
    private readonly pedidosSvc: PedidosService,
    private readonly repartidores: RepartidorService,
    private readonly tickets: TicketsService,
    private readonly tiendasSvc: TiendasService,
    private readonly finanzas: FinanzasService,
    private readonly config: ConfiguracionService,
    private readonly almacen: AlmacenService,
    private readonly push: PushService,
    private readonly rt: RealtimeService,
  ) {}

  /** Carga los catálogos guardados por admin (si los hay) al arrancar. */
  async onModuleInit() {
    try {
      aplicarCatalogo(await this.config.get('catalogos'));
    } catch {
      /* sin tabla todavía (antes de migrar): se quedan los valores base */
    }
  }

  async usuario(id: string, rol?: Usuario['rol']) {
    const u = await this.ds.getRepository(Usuario).findOneBy({ id });
    if (!u || u.estado === 'eliminado') throw noEncontrado('Cuenta no encontrada');
    if (rol && u.rol !== rol) throw invalido(`La cuenta no es de ${rol}`, 'id');
    return u;
  }

  // ───── clientes: direcciones

  async direccionesDe(clienteId: string) {
    await this.usuario(clienteId, 'cliente');
    return this.direcciones.listar(clienteId);
  }

  async guardarDireccion(clienteId: string, dto: DireccionDto, id?: string) {
    await this.usuario(clienteId, 'cliente');
    return this.direcciones.guardar(clienteId, dto, id);
  }

  async eliminarDireccion(clienteId: string, id: string) {
    await this.direcciones.eliminar(id, clienteId);
  }

  // ───── repartidores

  async guardarVehiculo(repartidorId: string, dto: VehiculoDto) {
    const rep = await this.usuario(repartidorId, 'repartidor');
    return this.repartidores.guardarVehiculo(rep, dto, true);
  }

  async subirDocumento(agente: Usuario, usuarioId: string, dto: DocumentoAdminDto, archivo: Express.Multer.File) {
    const u = await this.usuario(usuarioId);
    if (u.rol !== 'repartidor' && u.rol !== 'tienda') throw invalido('Solo tiendas y repartidores tienen documentos', 'id');
    if (!archivo) throw invalido('Falta el archivo', 'archivo');
    const doc = await this.documentos.subir(u, dto.tipo, archivo);
    return dto.aprobar === 'true' ? this.documentos.revisar(agente, doc.id, { aprobado: true }) : doc;
  }

  async eliminarDocumento(id: string) {
    const repo = this.ds.getRepository(Documento);
    const d = await repo.findOneBy({ id });
    if (!d) throw noEncontrado('Documento no encontrado');
    await repo.remove(d);
    await this.almacen.borrarPrivados([d.ruta]).catch(() => undefined);
  }

  // ───── pedidos

  private async cliente(id: string) {
    const c = await this.usuario(id, 'cliente');
    if (c.estado !== 'activo') throw conflicto('CUENTA_INACTIVA', `La cuenta de ${c.nombre} está ${c.estado}`);
    return c;
  }

  async cotizarPorCliente(dto: CotizarAdminDto) {
    const { clienteId, ...resto } = dto;
    return this.pedidosSvc.cotizar(await this.cliente(clienteId), { ...resto, metodoPago: 'efectivo' });
  }

  async crearPorCliente(agente: Usuario, dto: PedidoAdminDto) {
    const { clienteId, paymentIntentId: _pi, ...resto } = dto;
    const c = await this.cliente(clienteId);
    const vista = await this.pedidosSvc.crear(c, { ...resto, metodoPago: 'efectivo' });
    await this.ds.getRepository(EventoPedido).insert({
      pedidoId: vista.id, tipo: 'creado_por_soporte', usuarioId: agente.id, rol: agente.rol, detalle: `A nombre de ${c.nombre}`,
    });
    return vista;
  }

  async editarPedido(agente: Usuario, id: string, dto: EditarPedidoDto) {
    const p = await this.ds.transaction(async (m) => {
      const p = await m.findOne(Pedido, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!p) throw noEncontrado('Pedido no encontrado');
      const cambios: Partial<Pedido> = {};
      const nota: string[] = [];
      if (dto.notas !== undefined) (cambios.notas = dto.notas?.trim() || null), nota.push('notas');
      if (dto.destinoNombre) (cambios.destinoNombre = dto.destinoNombre.trim()), nota.push('nombre de entrega');
      if (dto.destinoTelefono) (cambios.destinoTelefono = dto.destinoTelefono), nota.push('teléfono de entrega');
      if (dto.destinoReferencias !== undefined) (cambios.destinoReferencias = dto.destinoReferencias?.trim() || null), nota.push('referencias');
      if (dto.propina !== undefined && dto.propina !== p.propina) {
        if (ESTADOS_FINALES.includes(p.estado)) throw conflicto('TRANSICION_INVALIDA', 'El pedido ya terminó; la propina no se puede cambiar');
        if (p.metodoPago === 'tarjeta') throw conflicto('PAGO_CON_TARJETA', 'Con tarjeta el cobro ya se hizo; la propina no se puede cambiar');
        cambios.total = redondear(p.total - p.propina + dto.propina);
        cambios.propina = dto.propina;
        nota.push(`propina $${p.propina} → $${dto.propina}`);
      }
      if (!nota.length) throw invalido('No hay cambios', 'motivo');
      await m.update(Pedido, p.id, cambios);
      await m.insert(EventoPedido, { pedidoId: p.id, tipo: 'editado_por_soporte', usuarioId: agente.id, rol: agente.rol, detalle: `${nota.join(', ')}: ${dto.motivo}` });
      return m.findOneByOrFail(Pedido, { id: p.id });
    });
    void this.pedidosSvc.notificar(p, null, true);
    return this.pedidosSvc.vista(p, agente);
  }

  async asignar(agente: Usuario, id: string, dto: AsignarDto) {
    const p = await this.repartidores.asignarPorSoporte(agente, id, dto.repartidorId, dto.motivo);
    return this.pedidosSvc.vista(p, agente);
  }

  /** Mueve el pedido al siguiente estado cuando la app de la tienda o del repartidor no lo registró. */
  async avanzar(agente: Usuario, id: string, motivo: string) {
    const actual = await this.ds.getRepository(Pedido).findOneBy({ id });
    if (!actual) throw noEncontrado('Pedido no encontrado');
    const hacia = SIGUIENTE[actual.estado];
    if (!hacia) {
      throw conflicto('TRANSICION_INVALIDA', actual.estado === 'listo_para_recoger'
        ? 'Para avanzar un pedido listo, asígnalo a un repartidor'
        : actual.estado === 'en_domicilio' ? 'Para terminarlo, márcalo como entregado' : `Un pedido ${actual.estado} no avanza`);
    }
    const p = await this.pedidosSvc.transicionar(id, {
      desde: [actual.estado], hacia, evento: 'avanzado_por_soporte', actor: agente, detalle: `${actual.estado} → ${hacia}: ${motivo}`,
      cambios: () => (hacia === 'listo_para_recoger' ? { listoEn: new Date() } : hacia === 'creado' ? { enviadoATiendaEn: new Date() } : {}),
    });
    return this.pedidosSvc.vista(p, agente);
  }

  // ───── tickets

  async crearTicket(dto: TicketAdminDto) {
    const u = await this.usuario(dto.usuarioId);
    if (u.rol === 'soporte' || u.rol === 'admin') throw invalido('Los tickets son de clientes, tiendas o repartidores', 'usuarioId');
    const { usuarioId: _u, ...resto } = dto;
    return this.tickets.crear(u, resto);
  }

  async borrarMensaje(ticketId: string, mensajeId: string) {
    const repo = this.ds.getRepository(Mensaje);
    const msg = await repo.findOneBy({ id: mensajeId, ticketId });
    if (!msg) throw noEncontrado('Mensaje no encontrado');
    await repo.remove(msg);
    this.rt.emitir([`ticket:${ticketId}`, 'soporte'], 'ticket:mensaje', { ticketId, eliminado: mensajeId });
  }

  // ───── menú de cualquier tienda (se reutilizan los métodos de la app Tienda con el dueño de la tienda)

  async dueno(tiendaId: string) {
    const t = await this.ds.getRepository(Tienda).findOneBy({ id: tiendaId });
    if (!t) throw noEncontrado('Tienda no encontrada');
    return t.ownerId;
  }

  async duenoDeCategoria(id: string) {
    const c = await this.ds.getRepository(CategoriaProducto).findOneBy({ id });
    if (!c) throw noEncontrado('Categoría no encontrada');
    return this.dueno(c.tiendaId);
  }

  async duenoDeProducto(id: string) {
    const p = await this.ds.getRepository(Producto).findOneBy({ id, eliminado: false });
    if (!p) throw noEncontrado('Producto no encontrado');
    return this.dueno(p.tiendaId);
  }

  async crearProducto(tiendaId: string, dto: ProductoDto) {
    const owner = await this.dueno(tiendaId);
    const c = await this.ds.getRepository(CategoriaProducto).findOneBy({ id: dto.categoriaId });
    if (!c || c.tiendaId !== tiendaId) throw invalido('La categoría no es de esta tienda', 'categoriaId');
    return this.tiendasSvc.crearProducto(owner, dto);
  }

  // ───── cartera

  async ajuste(agente: Usuario, usuarioId: string, dto: AjusteDto) {
    const u = await this.usuario(usuarioId);
    if (u.rol === 'soporte' || u.rol === 'admin') throw invalido('Las cuentas internas no tienen cartera', 'id');
    if (!redondear(dto.monto)) throw invalido('El monto no puede ser cero', 'monto');
    await this.validarTopeSoporte(agente, [dto.monto]);
    await this.ds.transaction((m) =>
      this.finanzas.abonar(m, [{ usuarioId: u.id, tipo: 'ajuste', monto: dto.monto, descripcion: `Ajuste de ${agente.nombre}: ${dto.motivo.trim()}` }]),
    );
    void this.push.aUsuarios([u.id], dto.monto > 0 ? 'Abono en tu cartera' : 'Cargo en tu cartera', `${dto.monto > 0 ? '+' : '−'}$${Math.abs(dto.monto)}: ${dto.motivo}`);
    return this.finanzas.estadoDeCuenta(u.id, u.rol, { page: 1, limit: 10 } as PaginaDto);
  }

  /** Soporte puede abonar o cargar a mano hasta el tope de Ajustes por movimiento; admin no tiene tope. */
  async validarTopeSoporte(agente: Usuario, montos: number[]) {
    if (agente.rol === 'admin') return;
    const tope = (await this.config.get('cartera')).ajusteMaxSoporte ?? REGLAS.cartera.ajusteMaxSoporte;
    const mayor = Math.max(0, ...montos.map((x) => Math.abs(x)));
    if (mayor > tope) throw new AppError(403, 'TOPE_SOPORTE', `Soporte puede mover hasta $${tope} por movimiento; pídele a un admin los montos mayores`);
  }

  /** Deshace una liquidación mal capturada con el movimiento contrario; la liquidación queda marcada como anulada. */
  async anularLiquidacion(agente: Usuario, id: string, motivo: string) {
    const liq = await this.ds.transaction(async (m) => {
      const l = await m.findOne(Liquidacion, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!l) throw noEncontrado('Liquidación no encontrada');
      if (l.anuladaEn) throw conflicto('LIQUIDACION_ANULADA', 'Esa liquidación ya se anuló');
      const original = await m.findOneBy(Movimiento, { liquidacionId: l.id });
      const monto = original ? -original.monto : l.sentido === 'cobro' ? -l.monto : l.monto;
      await this.finanzas.abonar(m, [{ usuarioId: l.usuarioId, liquidacionId: l.id, tipo: 'liquidacion', monto, descripcion: `Anulación de la liquidación del ${l.creadoEn.toLocaleDateString('es-MX')}: ${motivo.trim()}` }]);
      Object.assign(l, { anuladaEn: new Date(), anuladaMotivo: motivo.trim(), anuladaPor: agente.id });
      return m.save(l);
    });
    return { id: liq.id, anuladaEn: liq.anuladaEn, anuladaMotivo: liq.anuladaMotivo, saldo: await this.finanzas.saldo(liq.usuarioId) };
  }

  // ───── catálogos

  catalogosPublicos() {
    const motivos = (l: keyof Catalogos['motivos']) => CATALOGO.motivos[l].filter((m) => m.activo).map(({ codigo, texto }) => ({ codigo, texto }));
    return {
      categorias: CATALOGO.categorias.filter((c) => c.activa).map(({ codigo, nombre }) => ({ codigo, nombre })),
      motivos: { cliente: motivos('cliente'), tienda: motivos('tienda'), soporte: motivos('soporte') },
      documentos: { repartidor: CATALOGO.documentos.repartidor, tienda: CATALOGO.documentos.tienda },
      versionTerminos: CATALOGO.legal.versionTerminos,
    };
  }

  /**
   * Guarda los catálogos completos. Lo que ya existe en la base (los códigos originales) no se borra, solo se
   * desactiva, porque pedidos, tiendas y documentos guardados los siguen usando.
   */
  async guardarCatalogos(agente: Usuario, dto: CatalogosDto) {
    const unicos = (lista: string[], campo: string) => {
      const repetido = lista.find((c, i) => lista.indexOf(c) !== i);
      if (repetido) throw invalido(`Código repetido: ${repetido}`, campo);
    };
    const faltan = (base: string[], nuevos: string[], campo: string) => {
      const quitado = base.find((c) => !nuevos.includes(c));
      if (quitado) throw invalido(`"${quitado}" ya se usa; desactívalo en vez de quitarlo`, campo);
    };
    for (const l of ['cliente', 'tienda', 'soporte', 'sistema'] as const) {
      const codigos = dto.motivos[l].map((m) => m.codigo);
      unicos(codigos, `motivos.${l}`);
      faltan(CATALOGO_BASE.motivos[l].map((m) => m.codigo), codigos, `motivos.${l}`);
      if (l !== 'sistema' && !dto.motivos[l].some((m) => m.codigo === 'otro' && m.activo)) throw invalido('El motivo "otro" debe seguir activo', `motivos.${l}`);
    }
    const cats = dto.categorias.map((c) => c.codigo);
    unicos(cats, 'categorias');
    const enUso: { categoria: string }[] = await this.ds.query(`SELECT DISTINCT categoria FROM tiendas`);
    faltan([...new Set([...CATALOGO_BASE.categorias.map((c) => c.codigo), ...enUso.map((x) => x.categoria)])], cats, 'categorias');
    if (!dto.categorias.some((c) => c.activa)) throw invalido('Deja al menos una categoría activa', 'categorias');
    for (const rol of ['repartidor', 'tienda'] as const) {
      const tipos = dto.documentos[rol].map((d) => d.tipo);
      unicos(tipos, `documentos.${rol}`);
      faltan(CATALOGO_BASE.documentos[rol].map((d) => d.tipo), tipos, `documentos.${rol}`);
    }
    const nuevo: Catalogos = JSON.parse(JSON.stringify(dto));
    const antes = CATALOGO.legal.versionTerminos;
    await this.config.guardar('catalogos', nuevo, agente.id);
    aplicarCatalogo(nuevo);
    if (antes !== nuevo.legal.versionTerminos) {
      void this.push.aRoles(['cliente', 'tienda', 'repartidor'], 'Actualizamos los términos', 'Revisa y acepta los nuevos términos y el aviso de privacidad para seguir usando PaPedir');
    }
    return CATALOGO;
  }

  // ───── notificaciones enviadas

  async enviosPush(q: EnviosPushDto) {
    const [filas, total] = await this.ds.getRepository(EnvioPush).findAndCount({ order: { creadoEn: 'DESC' }, skip: (q.page - 1) * q.limit, take: q.limit });
    const ids = [...new Set(filas.map((f) => f.actorId).filter(Boolean))] as string[];
    const actores = ids.length ? await this.ds.getRepository(Usuario).findByIds(ids) : [];
    return pagina(
      filas.map((f) => ({ ...f, actor: f.actorId ? { id: f.actorId, nombre: actores.find((a) => a.id === f.actorId)?.nombre ?? null } : null })),
      total,
      q,
    );
  }

  // ───── reseñas

  /** Borra una reseña falsa: deja de contar en los promedios de la tienda y del repartidor. */
  async borrarResena(agente: Usuario, pedidoId: string, motivo: string) {
    await this.ds.transaction(async (m) => {
      const c = await m.findOneBy(Calificacion, { pedidoId });
      if (!c) throw noEncontrado('Reseña no encontrada');
      await m.remove(c);
      await m.query(`UPDATE tiendas SET calificacion = (SELECT round(avg(tienda), 2) FROM calificaciones WHERE tienda_id = $1) WHERE id = $1`, [c.tiendaId]);
      if (c.repartidorId) {
        await m.query(`UPDATE usuarios SET calificacion = (SELECT round(avg(repartidor), 2) FROM calificaciones WHERE repartidor_id = $1) WHERE id = $1`, [c.repartidorId]);
      }
      await m.insert(EventoPedido, { pedidoId, tipo: 'resena_eliminada', usuarioId: agente.id, rol: agente.rol, detalle: motivo.trim() });
    });
  }

}

// ─────────────────────────── rutas

/** Soporte y admin: operación del día a día. */
@Roles('soporte', 'admin')
@Controller('soporte')
export class ControlSoporteController {
  constructor(
    private readonly svc: ControlService,
    private readonly repartidores: RepartidorService,
    private readonly tiendas: TiendasService,
  ) {}

  // Clientes
  @Get('usuarios/:id/direcciones') direcciones(@Param('id', UuidPipe) id: string) { return this.svc.direccionesDe(id); }

  @Post('usuarios/:id/direcciones')
  crearDireccion(@Param('id', UuidPipe) id: string, @Body() dto: DireccionDto) { return this.svc.guardarDireccion(id, dto); }

  @Patch('usuarios/:id/direcciones/:dir')
  editarDireccion(@Param('id', UuidPipe) id: string, @Param('dir', UuidPipe) dir: string, @Body() dto: DireccionDto) { return this.svc.guardarDireccion(id, dto, dir); }

  @Delete('usuarios/:id/direcciones/:dir') @HttpCode(204)
  borrarDireccion(@Param('id', UuidPipe) id: string, @Param('dir', UuidPipe) dir: string) { return this.svc.eliminarDireccion(id, dir); }

  // Repartidores
  @Put('usuarios/:id/vehiculo')
  vehiculo(@Param('id', UuidPipe) id: string, @Body() dto: VehiculoDto) { return this.svc.guardarVehiculo(id, dto); }

  @Post('usuarios/:id/documentos') @UseInterceptors(subidaArchivo())
  documento(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: DocumentoAdminDto, @UploadedFile() archivo: Express.Multer.File) {
    return this.svc.subirDocumento(u, id, dto, archivo);
  }

  @Post('repartidores/:id/desconectar') @HttpCode(200)
  desconectar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: MotivoDto) { return this.repartidores.desconectarPorSoporte(u, id, dto.motivo); }

  // Pedidos
  @Post('pedidos/cotizar') @HttpCode(200)
  cotizar(@Body() dto: CotizarAdminDto) { return this.svc.cotizarPorCliente(dto); }

  @Post('pedidos')
  crearPedido(@Actor() u: Usuario, @Body() dto: PedidoAdminDto) { return this.svc.crearPorCliente(u, dto); }

  @Patch('pedidos/:id')
  editarPedido(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: EditarPedidoDto) { return this.svc.editarPedido(u, id, dto); }

  @Post('pedidos/:id/asignar') @HttpCode(200)
  asignar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: AsignarDto) { return this.svc.asignar(u, id, dto); }

  @Post('pedidos/:id/avanzar') @HttpCode(200)
  avanzar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: MotivoDto) { return this.svc.avanzar(u, id, dto.motivo); }

  // Tickets
  @Post('usuarios/:id/ajuste')
  ajuste(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: AjusteDto) { return this.svc.ajuste(u, id, dto); }

  @Post('tickets')
  crearTicket(@Body() dto: TicketAdminDto) { return this.svc.crearTicket(dto); }

  // Menú de cualquier tienda
  @Get('tiendas/:id/categorias')
  async categorias(@Param('id', UuidPipe) id: string) { return this.tiendas.misCategorias(await this.svc.dueno(id), id); }

  @Post('tiendas/:id/categorias')
  async crearCategoria(@Param('id', UuidPipe) id: string, @Body() dto: CategoriaDto) { return this.tiendas.crearCategoria(await this.svc.dueno(id), dto, id); }

  @Patch('categorias/:id')
  async editarCategoria(@Param('id', UuidPipe) id: string, @Body() dto: CategoriaUpdateDto) { return this.tiendas.actualizarCategoria(id, await this.svc.duenoDeCategoria(id), dto); }

  @Delete('categorias/:id') @HttpCode(204)
  async borrarCategoria(@Param('id', UuidPipe) id: string) { return this.tiendas.eliminarCategoria(id, await this.svc.duenoDeCategoria(id)); }

  @Get('tiendas/:id/productos')
  async productos(@Param('id', UuidPipe) id: string) { return this.tiendas.misProductos(await this.svc.dueno(id), id); }

  @Post('tiendas/:id/productos')
  crearProducto(@Param('id', UuidPipe) id: string, @Body() dto: ProductoDto) { return this.svc.crearProducto(id, dto); }

  @Patch('productos/:id')
  async editarProducto(@Param('id', UuidPipe) id: string, @Body() dto: ProductoUpdateDto) { return this.tiendas.actualizarProducto(id, await this.svc.duenoDeProducto(id), dto); }

  @Delete('productos/:id') @HttpCode(204)
  async borrarProducto(@Param('id', UuidPipe) id: string) { return this.tiendas.eliminarProducto(id, await this.svc.duenoDeProducto(id)); }

  @Put('productos/:id/opciones')
  async opciones(@Param('id', UuidPipe) id: string, @Body() dto: OpcionesProductoDto) { return this.tiendas.guardarOpciones(id, await this.svc.duenoDeProducto(id), dto); }

  @Get('tiendas/:id/horario')
  async horario(@Param('id', UuidPipe) id: string) { return this.tiendas.horario(await this.svc.dueno(id), id); }

  @Put('tiendas/:id/horario')
  async guardarHorario(@Param('id', UuidPipe) id: string, @Body() dto: HorarioDto) { return this.tiendas.guardarHorario(await this.svc.dueno(id), dto, id); }
}

/** Solo admin: lo que mueve dinero, borra o cambia reglas. */
@Roles('admin')
@Controller()
export class ControlAdminController {
  constructor(private readonly svc: ControlService) {}

  @Delete('admin/documentos/:id') @HttpCode(204)
  borrarDocumento(@Param('id', UuidPipe) id: string, @Body() _dto: MotivoDto) { return this.svc.eliminarDocumento(id); }

  @Delete('admin/tickets/:id/mensajes/:mensaje') @HttpCode(204)
  borrarMensaje(@Param('id', UuidPipe) id: string, @Param('mensaje', UuidPipe) mensaje: string, @Body() _dto: MotivoDto) { return this.svc.borrarMensaje(id, mensaje); }

  @Post('admin/usuarios/:id/ajuste')
  ajuste(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: AjusteDto) { return this.svc.ajuste(u, id, dto); }

  @Post('admin/liquidaciones/:id/anular') @HttpCode(200)
  anular(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: MotivoDto) { return this.svc.anularLiquidacion(u, id, dto.motivo); }

  @Get('admin/catalogos') catalogos() { return CATALOGO; }

  @Put('admin/catalogos')
  guardarCatalogos(@Actor() u: Usuario, @Body() dto: CatalogosDto) { return this.svc.guardarCatalogos(u, dto); }

  @Get('admin/notificaciones') envios(@Query() q: EnviosPushDto) { return this.svc.enviosPush(q); }

  @Delete('admin/resenas/:pedidoId') @HttpCode(204)
  borrarResena(@Actor() u: Usuario, @Param('pedidoId', UuidPipe) id: string, @Body() dto: MotivoDto) { return this.svc.borrarResena(u, id, dto.motivo); }
}

/** Catálogos vigentes para las apps (categorías, motivos, documentos y versión de términos). */
@Controller()
export class CatalogosController {
  constructor(private readonly svc: ControlService) {}

  @Publico() @Get('catalogos') catalogos() { return this.svc.catalogosPublicos(); }
}

@Module({
  imports: [AuthModule, DireccionesModule, DocumentosModule, PedidosModule, RepartidorModule, TicketsModule, TiendasModule],
  controllers: [ControlSoporteController, ControlAdminController, CatalogosController],
  providers: [ControlService],
  exports: [ControlService],
})
export class ControlModule {}

