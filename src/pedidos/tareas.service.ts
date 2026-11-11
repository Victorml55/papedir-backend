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
      await this.cancelarSinRespuesta();
      await this.avisarSinRepartidor();
      await this.cerrarTicketsResueltos();
    } catch (e) {
      this.log.error(e.message);
    }
  }

  /** La tienda tiene 5 minutos para aceptar o rechazar; si no, el pedido se cancela solo. */
  async cancelarSinRespuesta() {
    const vencidos = await this.ds.query(
      `SELECT id FROM pedidos WHERE estado = 'creado' AND creado_en < now() - make_interval(mins => $1)`,
      [REGLAS.pedido.minutosParaAceptar],
    );
    for (const { id } of vencidos) {
      await this.pedidos
        .transicionar(id, {
          desde: ['creado'], hacia: 'cancelado', evento: 'cancelado_automatico', actor: null,
          detalle: `La tienda no respondió en ${REGLAS.pedido.minutosParaAceptar} minutos`,
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
}
