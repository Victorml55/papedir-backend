import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { folio } from '../common/util';
import { REGLAS } from '../config/reglas';
import { PushService } from '../nucleo/push.service';
import { RealtimeService } from '../nucleo/realtime.service';
import { PedidosService } from './pedidos.service';

/** Reglas que dependen del tiempo. Corren cada 30 segundos dentro del mismo proceso de la API. */
@Injectable()
export class TareasService {
  private readonly log = new Logger('Tareas');

  constructor(
    private readonly ds: DataSource,
    private readonly pedidos: PedidosService,
    private readonly rt: RealtimeService,
    private readonly push: PushService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async ejecutar() {
    try {
      await this.liberarProgramados();
      await this.cancelarSinRespuesta();
      await this.avisarSinRepartidor();
      await this.cerrarTicketsResueltos();
    } catch (e) {
      this.log.error(e.message);
    }
  }

  /**
   * Un pedido programado se manda a la tienda con anticipación (preparación + traslado + margen) para
   * que llegue a la hora pedida. Si la tienda está cerrada en ese momento, se cancela.
   */
  async liberarProgramados() {
    const listos = await this.ds.query(
      `SELECT p.id, tienda_abierta_ahora(p.tienda_id) AS abierta
       FROM pedidos p JOIN tiendas t ON t.id = p.tienda_id
       WHERE p.estado = 'programado'
         AND p.programado_para - make_interval(mins => t.tiempo_preparacion_min + ceil(p.distancia_km * $1)::int + 5 + $2) <= now()`,
      [REGLAS.envio.minPorKm, REGLAS.pedido.margenProgramadoMin],
    );
    for (const { id, abierta } of listos) {
      await this.pedidos
        .transicionar(id, abierta
          ? { desde: ['programado'], hacia: 'creado', evento: 'enviado_a_tienda', actor: null, cambios: () => ({ enviadoATiendaEn: new Date() }) }
          : {
              desde: ['programado'], hacia: 'cancelado', evento: 'cancelado_automatico', actor: null,
              detalle: 'La tienda no abrió para el pedido programado', cambios: () => ({ motivoCodigo: 'tienda_cerrada' }),
            })
        .catch(() => null); // lo canceló el cliente justo ahora
    }
    return listos.length;
  }

  /** La tienda tiene 5 minutos para aceptar o rechazar; si no, el pedido se cancela solo. */
  async cancelarSinRespuesta() {
    const vencidos = await this.ds.query(
      `SELECT id FROM pedidos WHERE estado = 'creado' AND coalesce(enviado_a_tienda_en, creado_en) < now() - make_interval(mins => $1)`,
      [REGLAS.pedido.minutosParaAceptar],
    );
    for (const { id } of vencidos) {
      await this.pedidos
        .transicionar(id, {
          desde: ['creado'], hacia: 'cancelado', evento: 'cancelado_automatico', actor: null,
          detalle: `La tienda no respondió en ${REGLAS.pedido.minutosParaAceptar} minutos`, cambios: () => ({ motivoCodigo: 'tienda_no_respondio' }),
        })
        .catch(() => null); // la tienda respondió justo a tiempo
    }
    return vencidos.length;
  }

  /** Un pedido con 15 minutos listo y sin repartidor se avisa a soporte (una sola vez). */
  async avisarSinRepartidor() {
    const filas = await this.ds.query(
      `UPDATE pedidos SET soporte_avisado = true
       WHERE estado = 'listo_para_recoger' AND NOT soporte_avisado AND listo_en < now() - make_interval(mins => $1)
       RETURNING id, folio_num`,
      [REGLAS.repartidor.minutosAvisoSoporte],
    );
    // En PostgreSQL, UPDATE ... RETURNING devuelve [filas, cantidad] a través de TypeORM.
    const pedidos = Array.isArray(filas[0]) ? filas[0] : filas;
    for (const p of pedidos) {
      this.rt.emitir(['soporte'], 'pedido:sin_repartidor', { pedidoId: p.id, folio: folio('R', p.folio_num) });
      void this.push.aRoles(['soporte', 'admin'], 'Pedido sin repartidor', `${folio('R', p.folio_num)} lleva ${REGLAS.repartidor.minutosAvisoSoporte} min esperando`);
    }
    return pedidos.length;
  }

  /** Un ticket resuelto sin respuesta en 48 horas se cierra solo. */
  async cerrarTicketsResueltos() {
    await this.ds.query(
      `UPDATE tickets SET estado = 'cerrado', actualizado_en = now()
       WHERE estado = 'resuelto' AND resuelto_en < now() - make_interval(hours => $1)`,
      [REGLAS.ticket.horasCierreAutomatico],
    );
  }

  /** La bandeja de notificaciones conserva 60 días. Una vez al día, de madrugada. */
  @Cron('0 15 4 * * *', { timeZone: REGLAS.tienda.zonaHoraria })
  async limpiarNotificaciones() {
    await this.ds.query(`DELETE FROM notificaciones WHERE creado_en < now() - make_interval(days => $1)`, [REGLAS.notificaciones.diasConservar]);
  }
}
