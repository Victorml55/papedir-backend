import { Injectable } from '@nestjs/common';
import type { Namespace } from 'socket.io';

/**
 * Punto único para emitir eventos de Socket.IO desde cualquier servicio.
 * El gateway (src/realtime) registra aquí el servidor al arrancar.
 * Salas: usuario:{id} · tienda:{tiendaId} · repartidores · soporte · pedido:{id} · ticket:{id}
 */
@Injectable()
export class RealtimeService {
  servidor: Namespace | null = null;

  emitir(salas: (string | null | undefined)[], evento: string, payload: unknown) {
    const destino = salas.filter(Boolean) as string[];
    if (!this.servidor || !destino.length) return;
    this.servidor.to(destino).emit(evento, payload);
  }

  /** Desconecta todos los sockets de un usuario (por ejemplo, al banearlo). */
  desconectar(usuarioId: string) {
    this.servidor?.in(`usuario:${usuarioId}`).disconnectSockets(true);
  }
}
