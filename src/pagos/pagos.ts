import { Body, Controller, Get, HttpCode, Injectable, Module, Post } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsIn, IsString, Matches } from 'class-validator';
import { DataSource, Repository } from 'typeorm';
import { Actor, Roles, TiendaSel } from '../common/auth';
import { AppError, conflicto, invalido } from '../common/errores';
import { REGLAS } from '../config/reglas';
import { Suscripcion, Tienda, Usuario } from '../database/entities';
import { comisionDelPlan } from '../finanzas/finanzas.service';
import { ConfiguracionService } from '../nucleo/configuracion.service';
import { PagosService } from '../nucleo/pagos.service';
import { CotizarPedidoDto } from '../pedidos/pedidos.dto';
import { PedidosModule } from '../pedidos/pedidos.module';
import { PedidosService } from '../pedidos/pedidos.service';
import { TiendasModule } from '../tiendas/tiendas.module';
import { TiendasService } from '../tiendas/tiendas.service';

type CodigoPlan = 'basico' | 'pro' | 'premium';
const CODIGOS = REGLAS.planes.map((p) => p.codigo);

export class ElegirPlanDto {
  @IsIn(CODIGOS) plan: CodigoPlan;
}

export class ConfirmarPlanDto {
  @IsString() @Matches(/^pi_[A-Za-z0-9_]+$/, { message: 'paymentIntentId no es válido' }) paymentIntentId: string;
}

/**
 * Planes de suscripción de las tiendas: Básico (gratis), Pro y Premium (pago mensual con tarjeta).
 * Cada pago da 30 días; si se paga antes de que venza el mismo plan, los días se suman.
 * Al vencer, la tienda vuelve a Básico (tarea diaria).
 */
@Injectable()
export class PlanesService {
  constructor(
    private readonly ds: DataSource,
    private readonly pagos: PagosService,
    private readonly config: ConfiguracionService,
    private readonly tiendasSvc: TiendasService,
    @InjectRepository(Tienda) private readonly tiendas: Repository<Tienda>,
    @InjectRepository(Suscripcion) private readonly suscripciones: Repository<Suscripcion>,
  ) {}

  async planes() {
    const general = (await this.config.get('comisiones')).tiendaPct;
    return REGLAS.planes.map((p) => ({ ...p, comisionPct: p.comisionPct ?? general, beneficios: [...p.beneficios] }));
  }

  async miPlan(usuarioId: string, tiendaId?: string) {
    const t = await this.tiendasSvc.deUsuario(usuarioId, tiendaId);
    const vigente = t.plan !== 'basico' && !!t.planHasta && t.planHasta > new Date();
    const general = (await this.config.get('comisiones')).tiendaPct;
    const historial = await this.suscripciones.find({ where: { tiendaId: t.id }, order: { creadoEn: 'DESC' }, take: 12 });
    return {
      tiendaId: t.id,
      plan: vigente ? t.plan : 'basico',
      planHasta: vigente ? t.planHasta : null,
      comisionPct: t.comisionPct ?? comisionDelPlan(t) ?? general,
      pagos: historial.map((s) => ({ id: s.id, plan: s.plan, monto: s.monto, inicio: s.inicio, fin: s.fin, creadoEn: s.creadoEn })),
    };
  }

  /** Básico: cambia de inmediato. Pro o Premium: crea el cobro; la app lo confirma con flutter_stripe y llama a confirmar. */
  async elegir(usuario: Usuario, plan: CodigoPlan, tiendaId?: string) {
    const t = await this.tiendasSvc.deUsuario(usuario.id, tiendaId);
    if (plan === 'basico') {
      await this.tiendas.update(t.id, { plan: 'basico', planHasta: null });
      return { plan: 'basico', requierePago: false, ...(await this.miPlan(usuario.id, t.id)) };
    }
    if (usuario.estado !== 'activo') throw conflicto('CUENTA_PENDIENTE', 'Tu tienda está en revisión; podrás elegir un plan cuando soporte la apruebe');
    const info = REGLAS.planes.find((p) => p.codigo === plan);
    const intento = await this.pagos.crearIntento(info.precioMensual, `PaPedir · Plan ${info.nombre} · ${t.nombre}`, { tiendaId: t.id, plan }, false);
    return { plan, requierePago: true, monto: info.precioMensual, paymentIntentId: intento.id, clientSecret: intento.clientSecret, publishableKey: this.pagos.publicable };
  }

  async confirmar(usuarioId: string, paymentIntentId: string, tiendaId?: string) {
    const t = await this.tiendasSvc.deUsuario(usuarioId, tiendaId);
    const intento = await this.pagos.obtener(paymentIntentId);
    const plan = intento.metadata.plan as CodigoPlan;
    const info = REGLAS.planes.find((p) => p.codigo === plan);
    if (intento.metadata.tiendaId !== t.id || !info) throw invalido('Ese pago no corresponde a esta tienda', 'paymentIntentId');
    if (intento.estado !== 'succeeded') throw new AppError(402, 'PAGO_PENDIENTE', 'El pago no se ha completado; confirma la tarjeta en la app');
    if (!PagosService.coincide(intento, info.precioMensual)) throw conflicto('PAGO_NO_COINCIDE', 'El monto pagado no corresponde al plan');

    await this.ds.transaction(async (m) => {
      if (await m.existsBy(Suscripcion, { paymentIntentId })) throw conflicto('PAGO_USADO', 'Ese pago ya se aplicó');
      const actual = await m.findOne(Tienda, { where: { id: t.id }, lock: { mode: 'pessimistic_write' } });
      // Renovar el mismo plan antes de que venza suma los días; cambiar de plan empieza hoy.
      const inicio = actual.plan === plan && actual.planHasta && actual.planHasta > new Date() ? actual.planHasta : new Date();
      const fin = new Date(inicio.getTime() + REGLAS.pagos.diasPlan * 86400000);
      await m.insert(Suscripcion, { tiendaId: t.id, plan, monto: info.precioMensual, paymentIntentId, inicio, fin });
      await m.update(Tienda, t.id, { plan, planHasta: fin });
    });
    return this.miPlan(usuarioId, t.id);
  }
}

@Controller()
export class PagosController {
  constructor(
    private readonly planesSvc: PlanesService,
    private readonly pedidos: PedidosService,
    private readonly pagos: PagosService,
  ) {}

  /** Paso 1 del pago con tarjeta (rol cliente). Recibe el mismo cuerpo que POST /pedidos/cotizar. */
  @Roles('cliente') @Post('pagos/intento') @HttpCode(200)
  intento(@Actor() u: Usuario, @Body() dto: CotizarPedidoDto) { return this.pedidos.intentoDePago(u, dto); }

  @Get('pagos/config')
  configPagos() { return { publishableKey: this.pagos.publicable, moneda: REGLAS.pagos.moneda, maximoTarjeta: REGLAS.pagos.maximoTarjeta }; }

  @Get('planes')
  planes() { return this.planesSvc.planes(); }

  @Roles('tienda') @Get('tiendas/mia/plan')
  miPlan(@Actor() u: Usuario, @TiendaSel() t?: string) { return this.planesSvc.miPlan(u.id, t); }

  @Roles('tienda') @Post('tiendas/mia/plan') @HttpCode(200)
  elegir(@Actor() u: Usuario, @Body() dto: ElegirPlanDto, @TiendaSel() t?: string) { return this.planesSvc.elegir(u, dto.plan, t); }

  @Roles('tienda') @Post('tiendas/mia/plan/confirmar') @HttpCode(200)
  confirmar(@Actor() u: Usuario, @Body() dto: ConfirmarPlanDto, @TiendaSel() t?: string) {
    return this.planesSvc.confirmar(u.id, dto.paymentIntentId, t);
  }
}

@Module({ imports: [PedidosModule, TiendasModule], controllers: [PagosController], providers: [PlanesService] })
export class PagosModule {}
