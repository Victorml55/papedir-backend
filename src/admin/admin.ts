import { Body, CallHandler, Controller, Delete, ExecutionContext, Get, HttpCode, Injectable, Logger, Module, NestInterceptor, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { concatMap, Observable } from 'rxjs';
import { AuthModule } from '../auth/auth.module';
import { Actor, Roles } from '../common/auth';
import { UuidPipe } from '../common/util';
import { Usuario } from '../database/entities';
import { MetricasDto } from '../soporte/soporte.dto';
import { TiendasModule } from '../tiendas/tiendas.module';
import {
  BitacoraDto, EditarUsuarioDto, EliminarUsuarioDto, ListaRepartidoresDto, ListaResenasDto, ListaTiendasDto, ModerarResenaDto,
  NotificacionDto, PasswordAdminDto, PausaTiendaDto, CrearTiendaAdminDto, EditarTiendaAdminDto, EliminarTiendaDto,
} from './admin.dto';
import { AdminService } from './admin.service';

/** Herramientas del panel que usan soporte y admin. */
@Roles('soporte', 'admin')
@Controller('soporte')
export class PanelSoporteController {
  constructor(private readonly svc: AdminService) {}

  @Get('tablero') tablero() { return this.svc.tablero(); }

  @Get('tiendas') tiendas(@Query() q: ListaTiendasDto) { return this.svc.tiendas(q); }

  @Get('tiendas/:id') tienda(@Param('id', UuidPipe) id: string) { return this.svc.tienda(id); }

  @Put('tiendas/:id/pausa')
  pausar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: PausaTiendaDto) { return this.svc.pausar(u, id, dto); }

  @Get('repartidores') repartidores(@Query() q: ListaRepartidoresDto) { return this.svc.repartidores(q); }

  @Get('mapa') mapa() { return this.svc.mapa(); }

  @Get('resenas') resenas(@Query() q: ListaResenasDto) { return this.svc.resenas(q); }

  @Patch('resenas/:pedidoId')
  moderar(@Actor() u: Usuario, @Param('pedidoId', UuidPipe) id: string, @Body() dto: ModerarResenaDto) { return this.svc.moderar(u, id, dto); }
}

/** Herramientas solo de admin. */
@Roles('admin')
@Controller('admin')
export class PanelAdminController {
  constructor(private readonly svc: AdminService) {}

  @Patch('usuarios/:id')
  editar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: EditarUsuarioDto) { return this.svc.editarUsuario(u, id, dto); }

  @Put('usuarios/:id/password') @HttpCode(204)
  password(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: PasswordAdminDto) { return this.svc.fijarPassword(u, id, dto.password); }

  @Delete('usuarios/:id') @HttpCode(204)
  eliminar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: EliminarUsuarioDto) { return this.svc.eliminarUsuario(u, id, dto.motivo); }

  @Post('tiendas')
  crearTienda(@Actor() u: Usuario, @Body() dto: CrearTiendaAdminDto) { return this.svc.crearTienda(u, dto); }

  @Patch('tiendas/:id')
  editarTienda(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: EditarTiendaAdminDto) { return this.svc.editarTienda(u, id, dto); }

  @Delete('tiendas/:id') @HttpCode(204)
  eliminarTienda(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: EliminarTiendaDto) { return this.svc.eliminarTienda(u, id, dto.motivo); }

  @Post('tiendas/:id/restaurar') @HttpCode(200)
  restaurarTienda(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.restaurarTienda(u, id); }

  @Get('metricas/series') series(@Query() q: MetricasDto) { return this.svc.series(q); }

  @Post('notificaciones') @HttpCode(200)
  notificar(@Actor() u: Usuario, @Body() dto: NotificacionDto) { return this.svc.notificar(u, dto); }

  @Get('bitacora') bitacora(@Query() q: BitacoraDto) { return this.svc.acciones(q); }
}

// ─────────────────────────── bitácora automática

/** Qué hizo, en palabras, según el método y la ruta. Lo que no está aquí se guarda como "MÉTODO ruta". */
const ACCIONES: [RegExp, string][] = [
  [/^POST \/soporte\/pedidos\/:id\/cancelar$/, 'Canceló un pedido'],
  [/^POST \/soporte\/pedidos\/:id\/completar$/, 'Marcó un pedido como entregado'],
  [/^POST \/soporte\/pedidos\/:id\/liberar$/, 'Liberó un pedido del repartidor'],
  [/^PATCH \/soporte\/pedidos\/:id\/ubicacion$/, 'Corrigió la dirección de un pedido'],
  [/^PATCH \/soporte\/tickets\/:id$/, 'Actualizó un ticket'],
  [/^POST \/tickets\/:id\/mensajes$/, 'Respondió un ticket'],
  [/^POST \/pedidos\/:id\/mensajes$/, 'Escribió en el chat de un pedido'],
  [/^POST \/soporte\/usuarios\/:id\/aprobar$/, 'Aprobó una cuenta'],
  [/^POST \/soporte\/usuarios\/:id\/rechazar$/, 'Regresó una solicitud de cuenta'],
  [/^POST \/soporte\/pedidos\/:id\/reembolso$/, 'Reembolsó a la cartera del cliente'],
  [/^POST \/soporte\/solicitudes-tienda\/:id\/aprobar$/, 'Aprobó una solicitud de tienda'],
  [/^POST \/soporte\/solicitudes-tienda\/:id\/rechazar$/, 'Rechazó una solicitud de tienda'],
  [/^PUT \/admin\/configuracion\/cartera$/, 'Cambió los límites de la cartera'],
  [/^POST \/soporte\/usuarios\/:id\/banear$/, 'Baneó una cuenta'],
  [/^POST \/soporte\/usuarios\/:id\/desbanear$/, 'Quitó el baneo a una cuenta'],
  [/^POST \/soporte\/usuarios\/:id\/desbloquear$/, 'Desbloqueó una cuenta'],
  [/^POST \/soporte\/documentos\/:id\/revisar$/, 'Revisó un documento'],
  [/^PUT \/soporte\/tiendas\/:id\/pausa$/, 'Pausó o reanudó una tienda'],
  [/^PATCH \/soporte\/resenas\/:pedidoId$/, 'Moderó una reseña'],
  [/^POST \/admin\/usuarios$/, 'Creó una cuenta del equipo'],
  [/^PATCH \/admin\/usuarios\/:id$/, 'Editó los datos de una cuenta'],
  [/^PUT \/admin\/usuarios\/:id\/password$/, 'Puso una contraseña temporal'],
  [/^POST \/admin\/tiendas$/, 'Dio de alta una tienda'],
  [/^PATCH \/admin\/tiendas\/:id$/, 'Editó los datos de una tienda'],
  [/^DELETE \/admin\/tiendas\/:id$/, 'Dio de baja una tienda'],
  [/^POST \/admin\/tiendas\/:id\/restaurar$/, 'Restauró una tienda'],
  [/^DELETE \/admin\/usuarios\/:id$/, 'Eliminó una cuenta'],
  [/^POST \/admin\/notificaciones$/, 'Envió una notificación general'],
  [/^POST \/admin\/liquidaciones$/, 'Registró un pago'],
  [/^PUT \/admin\/configuracion\/comisiones$/, 'Cambió las comisiones'],
  [/^PUT \/admin\/configuracion\/recargos$/, 'Cambió los recargos'],
  [/^PUT \/admin\/tiendas\/:id\/comision$/, 'Cambió la comisión de una tienda'],
  [/^POST \/admin\/zonas$/, 'Creó una zona'],
  [/^PATCH \/admin\/zonas\/:id$/, 'Editó una zona'],
  [/^DELETE \/admin\/zonas\/:id$/, 'Eliminó una zona'],
  [/^POST \/admin\/cupones$/, 'Creó un cupón'],
  [/^PATCH \/admin\/cupones\/:id$/, 'Editó un cupón'],
  [/^POST \/admin\/usuarios$/, 'Creó una cuenta'],
  [/^POST \/soporte\/usuarios\/:id\/direcciones$/, 'Agregó una dirección a un cliente'],
  [/^PATCH \/soporte\/usuarios\/:id\/direcciones\/:dir$/, 'Editó una dirección de un cliente'],
  [/^DELETE \/soporte\/usuarios\/:id\/direcciones\/:dir$/, 'Borró una dirección de un cliente'],
  [/^PUT \/soporte\/usuarios\/:id\/vehiculo$/, 'Editó el vehículo de un repartidor'],
  [/^POST \/soporte\/usuarios\/:id\/documentos$/, 'Subió un documento a nombre de una cuenta'],
  [/^POST \/soporte\/repartidores\/:id\/desconectar$/, 'Desconectó a un repartidor'],
  [/^POST \/soporte\/pedidos$/, 'Creó un pedido a nombre de un cliente'],
  [/^PATCH \/soporte\/pedidos\/:id$/, 'Editó un pedido'],
  [/^POST \/soporte\/pedidos\/:id\/asignar$/, 'Asignó un pedido a un repartidor'],
  [/^POST \/soporte\/pedidos\/:id\/avanzar$/, 'Avanzó el estado de un pedido'],
  [/^POST \/soporte\/tickets$/, 'Abrió un ticket a nombre de alguien'],
  [/^POST \/soporte\/tiendas\/:id\/categorias$/, 'Creó una categoría en el menú de una tienda'],
  [/^PATCH \/soporte\/categorias\/:id$/, 'Editó una categoría del menú'],
  [/^DELETE \/soporte\/categorias\/:id$/, 'Borró una categoría del menú'],
  [/^POST \/soporte\/tiendas\/:id\/productos$/, 'Creó un producto en el menú de una tienda'],
  [/^PATCH \/soporte\/productos\/:id$/, 'Editó un producto'],
  [/^DELETE \/soporte\/productos\/:id$/, 'Borró un producto'],
  [/^PUT \/soporte\/productos\/:id\/opciones$/, 'Editó las opciones de un producto'],
  [/^PUT \/soporte\/tiendas\/:id\/horario$/, 'Cambió el horario de una tienda'],
  [/^DELETE \/admin\/documentos\/:id$/, 'Borró un documento'],
  [/^DELETE \/admin\/tickets\/:id\/mensajes\/:mensaje$/, 'Borró un mensaje de un ticket'],
  [/^POST \/admin\/usuarios\/:id\/ajuste$/, 'Hizo un ajuste en una cartera'],
  [/^POST \/admin\/liquidaciones\/:id\/anular$/, 'Anuló una liquidación'],
  [/^PUT \/admin\/catalogos$/, 'Cambió los catálogos'],
  [/^DELETE \/admin\/resenas\/:pedidoId$/, 'Borró una reseña'],
];
/** Campos que nunca se guardan en la bitácora. */
const SECRETOS = /password|token|secret|codigo/i;

const resumir = (cuerpo: unknown): Record<string, unknown> | null => {
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) return null;
  const limpio = Object.fromEntries(
    Object.entries(cuerpo as Record<string, unknown>)
      .filter(([k]) => !SECRETOS.test(k))
      .map(([k, v]) => [k, typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v]),
  );
  return Object.keys(limpio).length ? limpio : null;
};

/** Guarda cada cambio exitoso que hace una cuenta de soporte o admin (no las consultas ni su propio perfil). */
@Injectable()
export class BitacoraInterceptor implements NestInterceptor {
  private readonly log = new Logger('Bitacora');
  constructor(private readonly svc: AdminService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    const u: Usuario | undefined = req?.usuario;
    if (!u || (u.rol !== 'soporte' && u.rol !== 'admin') || req.method === 'GET') return next.handle();
    const patron = String(req.route?.path ?? req.path).replace(/^\/api\/v1/, '');
    if (/^\/(auth|usuarios\/me)/.test(patron)) return next.handle();

    // Se espera a guardar la acción antes de responder: así quien consulte la bitácora justo después
    // (el panel o las pruebas) ya la ve. Si falla, solo se avisa en el log y la respuesta sale igual.
    return next.handle().pipe(
      concatMap((valor) => {
        const clave = `${req.method} ${patron}`;
        const id = req.params?.id ?? req.params?.pedidoId;
        return this.svc
          .registrarAccion({
            actorId: u.id,
            actorRol: u.rol,
            metodo: req.method,
            ruta: String(req.originalUrl ?? req.url).split('?')[0].replace(/^\/api\/v1/, ''),
            accion: ACCIONES.find(([r]) => r.test(clave))?.[1] ?? clave,
            recursoId: typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : null,
            detalle: resumir(req.body),
            estadoHttp: ctx.switchToHttp().getResponse()?.statusCode ?? 200,
          })
          .catch((e) => this.log.warn(`No se guardó la acción: ${e.message}`))
          .then(() => valor);
      }),
    );
  }
}

@Module({
  imports: [AuthModule, TiendasModule],
  controllers: [PanelSoporteController, PanelAdminController],
  providers: [AdminService, { provide: APP_INTERCEPTOR, useClass: BitacoraInterceptor }],
})
export class AdminModule {}
