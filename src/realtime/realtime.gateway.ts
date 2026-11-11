import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { OnGatewayConnection, OnGatewayInit, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { Repository } from 'typeorm';
import { Tienda, Usuario } from '../database/entities';
import { RealtimeService } from '../nucleo/realtime.service';
import { PedidosService } from '../pedidos/pedidos.service';
import { RepartidorService } from '../repartidor/repartidor.service';
import { TicketsService } from '../tickets/tickets';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ok = { ok: true };
const fallo = (error: string) => ({ ok: false, error });

/**
 * Tiempo real (contrato de eventos en ACUERDOS.md, sección 5).
 * Conexión: namespace /realtime con { auth: { token: accessToken } }.
 * El socket solo avisa: los datos completos se piden por REST.
 */
@WebSocketGateway({ namespace: '/realtime', cors: { origin: true, credentials: true } })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly log = new Logger('Realtime');

  constructor(
    private readonly rt: RealtimeService,
    private readonly jwt: JwtService,
    private readonly repartidor: RepartidorService,
    private readonly pedidos: PedidosService,
    private readonly tickets: TicketsService,
    @InjectRepository(Usuario) private readonly usuarios: Repository<Usuario>,
    @InjectRepository(Tienda) private readonly tiendas: Repository<Tienda>,
  ) {}

  afterInit(servidor: Namespace) {
    this.rt.servidor = servidor;
  }

  /** Valida el token y une al usuario a sus salas según su rol. */
  async handleConnection(socket: Socket) {
    try {
      const token = socket.handshake.auth?.token ?? String(socket.handshake.headers.authorization ?? '').replace(/^Bearer /, '');
      const { sub } = await this.jwt.verifyAsync(token);
      const u = await this.usuarios.findOneBy({ id: sub });
      if (!u || u.estado === 'baneado') throw new Error('cuenta inválida');

      socket.data.usuarioId = u.id;
      await socket.join(`usuario:${u.id}`);
      if (u.rol === 'repartidor') await socket.join('repartidores');
      if (u.rol === 'soporte' || u.rol === 'admin') await socket.join('soporte');
      if (u.rol === 'tienda') {
        const t = await this.tiendas.findOneBy({ ownerId: u.id });
        if (t) await socket.join(`tienda:${t.id}`);
      }
    } catch {
      socket.emit('error', { error: 'NO_AUTENTICADO', message: 'Token inválido o expirado' });
      socket.disconnect(true);
    }
  }

  /** Carga al usuario en cada evento: así un baneo o cambio de rol aplica de inmediato. */
  private async actor(socket: Socket) {
    const u = socket.data.usuarioId && (await this.usuarios.findOneBy({ id: socket.data.usuarioId }));
    return u && u.estado !== 'baneado' ? u : null;
  }

  /** App Repartidor: cada 10 s mientras esté conectado o con viaje activo. */
  @SubscribeMessage('repartidor:ubicacion')
  async ubicacion(socket: Socket, body: { lat: number; lng: number }) {
    const u = await this.actor(socket);
    if (u?.rol !== 'repartidor') return fallo('SIN_PERMISO');
    const { lat, lng } = body ?? ({} as any);
    if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180) return fallo('VALIDACION');
    // Como mucho una ubicación cada 2 segundos por socket.
    if (Date.now() - (socket.data.ultimaUbicacion ?? 0) < 2000) return ok;
    socket.data.ultimaUbicacion = Date.now();
    await this.repartidor.reportarUbicacion(u.id, { lat, lng });
    return ok;
  }

  /** Cliente y tienda: recibir la ubicación del repartidor en la pantalla de seguimiento. */
  @SubscribeMessage('pedido:seguir')
  async seguir(socket: Socket, body: { pedidoId: string }) {
    const u = await this.actor(socket);
    if (!u || !UUID.test(body?.pedidoId ?? '')) return fallo('VALIDACION');
    try {
      await this.pedidos.accesible(body.pedidoId, u);
    } catch {
      return fallo('SIN_PERMISO');
    }
    await socket.join(`pedido:${body.pedidoId}`);
    return ok;
  }

  @SubscribeMessage('pedido:dejar')
  async dejar(socket: Socket, body: { pedidoId: string }) {
    if (UUID.test(body?.pedidoId ?? '')) await socket.leave(`pedido:${body.pedidoId}`);
    return ok;
  }

  /** Al abrir el chat de un ticket. */
  @SubscribeMessage('ticket:unirse')
  async unirse(socket: Socket, body: { ticketId: string }) {
    const u = await this.actor(socket);
    if (!u || !UUID.test(body?.ticketId ?? '')) return fallo('VALIDACION');
    try {
      await this.tickets.accesible(body.ticketId, u);
    } catch {
      return fallo('SIN_PERMISO');
    }
    await socket.join(`ticket:${body.ticketId}`);
    return ok;
  }

  @SubscribeMessage('ticket:salir')
  async salir(socket: Socket, body: { ticketId: string }) {
    if (UUID.test(body?.ticketId ?? '')) await socket.leave(`ticket:${body.ticketId}`);
    return ok;
  }
}
