import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { conflicto, noEncontrado, sinPermiso } from '../common/errores';
import { folio } from '../common/util';
import { ESTADOS_CON_REPARTIDOR } from '../config/reglas';
import { MensajePedido, Pedido, Usuario } from '../database/entities';
import { PushService } from '../nucleo/push.service';
import { RealtimeService } from '../nucleo/realtime.service';

const vista = (x: MensajePedido) => ({ id: x.id, pedidoId: x.pedidoId, autorId: x.autorId, autorRol: x.autorRol, texto: x.texto, creadoEn: x.creadoEn });

/**
 * Chat entre el cliente y su repartidor mientras el pedido va en camino ("ya llegué", "toque el timbre"...).
 * Soporte lo puede leer y escribir para resolver incidencias. Así nadie tiene que compartir su número.
 */
@Injectable()
export class ChatPedidoService {
  constructor(
    private readonly rt: RealtimeService,
    private readonly push: PushService,
    @InjectRepository(Pedido) private readonly pedidos: Repository<Pedido>,
    @InjectRepository(MensajePedido) private readonly mensajes: Repository<MensajePedido>,
  ) {}

  private async pedido(u: Usuario, id: string) {
    const p = await this.pedidos.findOneBy({ id });
    if (!p) throw noEncontrado('Pedido no encontrado');
    const soporte = u.rol === 'soporte' || u.rol === 'admin';
    if (!soporte && p.clienteId !== u.id && p.repartidorId !== u.id) throw sinPermiso('No participas en este pedido');
    return { p, soporte };
  }

  /** Los últimos 200 mensajes, del más viejo al más nuevo. */
  async listar(u: Usuario, id: string) {
    const { p } = await this.pedido(u, id);
    const filas = await this.mensajes.find({ where: { pedidoId: p.id }, order: { creadoEn: 'DESC' }, take: 200 });
    return filas.reverse().map(vista);
  }

  async enviar(u: Usuario, id: string, texto: string) {
    const { p, soporte } = await this.pedido(u, id);
    if (!p.clienteId) throw conflicto('CHAT_CERRADO', 'Los pedidos manuales no tienen chat');
    if (!soporte && !ESTADOS_CON_REPARTIDOR.includes(p.estado)) {
      throw conflicto('CHAT_CERRADO', 'El chat está disponible mientras el repartidor lleva el pedido');
    }
    const m = await this.mensajes.save(this.mensajes.create({ pedidoId: p.id, autorId: u.id, autorRol: u.rol, texto: texto.trim() }));
    const salida = vista(m);
    this.rt.emitir([`usuario:${p.clienteId}`, p.repartidorId && `usuario:${p.repartidorId}`, soporte && 'soporte'], 'pedido:mensaje', salida);
    const destino = u.id === p.clienteId ? p.repartidorId : u.id === p.repartidorId ? p.clienteId : null;
    const de = u.rol === 'cliente' ? 'el cliente' : u.rol === 'repartidor' ? 'tu repartidor' : 'soporte';
    const para = destino ? [destino] : [p.clienteId, p.repartidorId];
    void this.push.aUsuarios(para, `Mensaje de ${de} · ${folio('R', p.folioNum)}`, salida.texto.slice(0, 120), { pedidoId: p.id, tipo: 'chat' });
    return salida;
  }
}
