import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomInt } from 'crypto';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { pagina } from '../common/dtos';
import { conflicto, invalido, noEncontrado, sinPermiso } from '../common/errores';
import { coords, folio, redondear } from '../common/util';
import { ESTADOS_FINALES, EstadoPedido, REGLAS } from '../config/reglas';
import {
  Calificacion, Direccion, EventoPedido, Pedido, PedidoItem, Producto, Tienda, Usuario, Viaje,
} from '../database/entities';
import { EnvioService } from '../nucleo/envio.service';
import { PushService } from '../nucleo/push.service';
import { RealtimeService } from '../nucleo/realtime.service';
import { CalificacionDto, CotizarManualDto, CotizarPedidoDto, CrearPedidoDto, ListarPedidosDto, PedidoManualDto } from './pedidos.dto';

const ESTADOS: EstadoPedido[] = ['creado', 'aceptado_tienda', 'listo_para_recoger', 'asignado', 'en_tienda', 'en_camino',
  'en_domicilio', 'entregado', 'cancelado', 'rechazado'];

export interface Transicion {
  desde: EstadoPedido[];
  hacia: EstadoPedido;
  evento: string;
  actor: Usuario | null; // null = el sistema
  /** Permisos: ¿este usuario puede tocar este pedido? Corre antes de revisar el estado. */
  validar?: (p: Pedido, m: EntityManager) => void | Promise<void>;
  /** Reglas de negocio (geocerca, código...). Corren después de confirmar que el estado es válido. */
  reglas?: (p: Pedido, m: EntityManager) => void | Promise<void>;
  cambios?: (p: Pedido) => Partial<Pedido>;
  detalle?: string;
  ubicacion?: { lat: number; lng: number };
  /** true = solo evento de tiempo real, sin push (correcciones que no cambian el estado). */
  sinPush?: boolean;
}

/** Texto de la notificación push al cliente según el nuevo estado. */
const AVISO_CLIENTE: Partial<Record<EstadoPedido, string>> = {
  aceptado_tienda: 'La tienda aceptó tu pedido y lo está preparando',
  rechazado: 'La tienda no pudo tomar tu pedido',
  en_camino: 'Tu pedido va en camino',
  en_domicilio: 'Tu repartidor llegó. Ten a la mano tu código de entrega',
  entregado: 'Pedido entregado. ¡Buen provecho!',
  cancelado: 'Tu pedido fue cancelado',
};

@Injectable()
export class PedidosService {
  constructor(
    private readonly ds: DataSource,
    private readonly envio: EnvioService,
    private readonly rt: RealtimeService,
    private readonly push: PushService,
    @InjectRepository(Pedido) private readonly pedidos: Repository<Pedido>,
    @InjectRepository(PedidoItem) private readonly items: Repository<PedidoItem>,
    @InjectRepository(EventoPedido) private readonly eventos: Repository<EventoPedido>,
    @InjectRepository(Tienda) private readonly tiendas: Repository<Tienda>,
    @InjectRepository(Producto) private readonly productos: Repository<Producto>,
    @InjectRepository(Direccion) private readonly direcciones: Repository<Direccion>,
    @InjectRepository(Usuario) private readonly usuarios: Repository<Usuario>,
    @InjectRepository(Calificacion) private readonly calificaciones: Repository<Calificacion>,
  ) {}

  // ─────────────────────────── cotizar y crear

  /** Valida el carrito con los precios vigentes y calcula subtotal, envío y total. */
  private async preparar(cliente: Usuario, dto: CotizarPedidoDto) {
    const tienda = await this.tiendas.findOneBy({ id: dto.tiendaId });
    if (!tienda) throw noEncontrado('Tienda no encontrada');
    const dueno = await this.usuarios.findOneBy({ id: tienda.ownerId });
    if (!tienda.abierta || dueno?.estado !== 'activo') throw conflicto('TIENDA_CERRADA', `${tienda.nombre} está cerrada`);

    const direccion = await this.direcciones.findOneBy({ id: dto.direccionId, clienteId: cliente.id });
    if (!direccion) throw noEncontrado('Dirección no encontrada');

    // Si un producto viene repetido, se suman sus cantidades.
    const cantidades = new Map<string, number>();
    for (const i of dto.items) cantidades.set(i.productoId, (cantidades.get(i.productoId) ?? 0) + i.cantidad);
    const productos = await this.productos.findBy({ id: In([...cantidades.keys()]), tiendaId: tienda.id, eliminado: false });
    if (productos.length !== cantidades.size) throw invalido('Todos los productos deben ser de la misma tienda', 'items');
    const agotado = productos.find((p) => !p.disponible);
    if (agotado) throw conflicto('PRODUCTO_AGOTADO', `${agotado.nombre} está agotado`);

    const lineas = productos.map((p) => ({ producto: p, cantidad: cantidades.get(p.id) }));
    const subtotal = redondear(lineas.reduce((s, l) => s + l.producto.precio * l.cantidad, 0));
    if (subtotal < REGLAS.pedido.minimoProductos) {
      throw conflicto('PEDIDO_MINIMO', `El pedido mínimo es de $${REGLAS.pedido.minimoProductos} en productos`);
    }
    const { distanciaKm, costoEnvio } = await this.envio.cotizar(tienda, direccion);
    const total = redondear(subtotal + costoEnvio);
    this.validarMaximo(total);
    return { tienda, direccion, lineas, subtotal, costoEnvio, total, distanciaKm };
  }

  private validarMaximo(total: number) {
    if (total > REGLAS.pedido.maximoEfectivo) {
      throw conflicto('PEDIDO_MAXIMO_EFECTIVO', `El máximo para pago en efectivo es de $${REGLAS.pedido.maximoEfectivo}`);
    }
  }

  private cotizacion(c: { distanciaKm: number; subtotal: number; costoEnvio: number; total: number }, preparacionMin: number) {
    return {
      distanciaKm: c.distanciaKm,
      subtotal: c.subtotal,
      costoEnvio: c.costoEnvio,
      total: c.total,
      metodoPago: 'efectivo' as const,
      tiempoEstimadoMin: preparacionMin + this.envio.minutosDeTraslado(c.distanciaKm),
    };
  }

  async cotizar(cliente: Usuario, dto: CotizarPedidoDto) {
    const c = await this.preparar(cliente, dto);
    return this.cotizacion(c, c.tienda.tiempoPreparacionMin);
  }

  async crear(cliente: Usuario, dto: CrearPedidoDto) {
    const c = await this.preparar(cliente, dto);
    const pedido = await this.ds.transaction(async (m) => {
      const p = await m.save(
        m.create(Pedido, {
          estado: 'creado',
          origen: 'app',
          tiendaId: c.tienda.id,
          clienteId: cliente.id,
          destinoNombre: cliente.nombre,
          destinoTelefono: cliente.telefono ?? '',
          destinoDireccion: c.direccion.texto,
          destinoReferencias: c.direccion.referencias,
          destinoLat: c.direccion.lat,
          destinoLng: c.direccion.lng,
          subtotal: c.subtotal,
          costoEnvio: c.costoEnvio,
          total: c.total,
          distanciaKm: c.distanciaKm,
          codigoEntrega: String(randomInt(0, 10000)).padStart(4, '0'),
          notas: dto.notas ?? null,
        }),
      );
      await m.insert(
        PedidoItem,
        c.lineas.map((l) => ({
          pedidoId: p.id, productoId: l.producto.id, nombre: l.producto.nombre, cantidad: l.cantidad,
          precioUnitario: l.producto.precio, // el precio queda fijo en el pedido
        })),
      );
      await m.insert(EventoPedido, { pedidoId: p.id, tipo: 'creado', usuarioId: cliente.id, rol: cliente.rol });
      return m.findOneByOrFail(Pedido, { id: p.id });
    });

    const vista = await this.vista(pedido, cliente);
    this.rt.emitir([`tienda:${c.tienda.id}`, 'soporte'], 'pedido:nuevo', { ...vista, codigoEntrega: null });
    void this.push.aUsuarios([c.tienda.ownerId], 'Pedido nuevo', `${vista.folio} · $${pedido.total}. Tienes 5 minutos para aceptarlo`, { pedidoId: pedido.id });
    return vista;
  }

  private async tiendaAprobada(usuario: Usuario) {
    const tienda = await this.tiendas.findOneBy({ ownerId: usuario.id });
    if (!tienda) throw noEncontrado('Esta cuenta no tiene una tienda');
    if (usuario.estado !== 'activo') throw conflicto('CUENTA_PENDIENTE', 'Tu tienda está en revisión');
    return tienda;
  }

  async cotizarManual(usuario: Usuario, dto: CotizarManualDto) {
    const tienda = await this.tiendaAprobada(usuario);
    const e = await this.envio.cotizar(tienda, dto.ubicacion);
    const total = redondear(dto.montoACobrar + e.costoEnvio);
    this.validarMaximo(total);
    return this.cotizacion({ ...e, subtotal: dto.montoACobrar, total }, 0);
  }

  /** Pedido capturado por la tienda (ventas por fuera de la app). Nace listo para recoger. */
  async crearManual(usuario: Usuario, dto: PedidoManualDto) {
    const tienda = await this.tiendaAprobada(usuario);
    const e = await this.envio.cotizar(tienda, dto.destino.ubicacion);
    const total = redondear(dto.montoACobrar + e.costoEnvio);
    this.validarMaximo(total);

    const pedido = await this.ds.transaction(async (m) => {
      const p = await m.save(
        m.create(Pedido, {
          estado: 'listo_para_recoger',
          origen: 'manual',
          tiendaId: tienda.id,
          destinoNombre: dto.destino.nombre,
          destinoTelefono: dto.destino.telefono,
          destinoDireccion: dto.destino.direccion,
          destinoReferencias: dto.destino.referencias ?? null,
          destinoLat: dto.destino.ubicacion.lat,
          destinoLng: dto.destino.ubicacion.lng,
          descripcion: dto.descripcion,
          subtotal: dto.montoACobrar,
          costoEnvio: e.costoEnvio,
          total,
          distanciaKm: e.distanciaKm,
          notas: dto.notas ?? null,
          listoEn: new Date(),
        }),
      );
      await m.insert(EventoPedido, [
        { pedidoId: p.id, tipo: 'creado', usuarioId: usuario.id, rol: usuario.rol, detalle: 'Pedido manual' },
        { pedidoId: p.id, tipo: 'listo_para_recoger', usuarioId: usuario.id, rol: usuario.rol },
      ]);
      return m.findOneByOrFail(Pedido, { id: p.id });
    });
    void this.notificar(pedido);
    return this.vista(pedido, usuario);
  }

  // ─────────────────────────── consultas

  async listar(usuario: Usuario, q: ListarPedidosDto, soloEntregados = false) {
    const qb = this.pedidos.createQueryBuilder('p');
    if (usuario.rol === 'cliente') qb.where('p.cliente_id = :id', { id: usuario.id });
    else if (usuario.rol === 'repartidor') qb.where('p.repartidor_id = :id', { id: usuario.id });
    else if (usuario.rol === 'tienda') {
      const tienda = await this.tiendas.findOneBy({ ownerId: usuario.id });
      qb.where('p.tienda_id = :id', { id: tienda?.id ?? null });
    } else qb.where('TRUE');

    const estados = soloEntregados ? ['entregado'] : this.estadosDe(q.estado);
    if (estados.length) qb.andWhere('p.estado IN (:...estados)', { estados });
    const [filas, total] = await qb.orderBy('p.creado_en', 'DESC').skip((q.page - 1) * q.limit).take(q.limit).getManyAndCount();
    return pagina(await this.vistas(filas, usuario), total, q);
  }

  estadosDe(texto?: string): EstadoPedido[] {
    const lista = (texto ?? '').split(',').map((e) => e.trim()).filter(Boolean);
    const malo = lista.find((e) => !ESTADOS.includes(e as EstadoPedido));
    if (malo) throw invalido(`Estado desconocido: ${malo}`, 'estado');
    return lista as EstadoPedido[];
  }

  /** Devuelve el pedido solo si el usuario participa en él (o es soporte/admin). */
  async accesible(id: string, usuario: Usuario) {
    const p = await this.pedidos.findOneBy({ id });
    if (!p) throw noEncontrado('Pedido no encontrado');
    await this.exigirAcceso(p, usuario);
    return p;
  }

  private async exigirAcceso(p: Pedido, u: Usuario) {
    if (u.rol === 'soporte' || u.rol === 'admin') return;
    if (u.rol === 'cliente' && p.clienteId === u.id) return;
    if (u.rol === 'repartidor' && (p.repartidorId === u.id || p.estado === 'listo_para_recoger')) return;
    if (u.rol === 'tienda' && (await this.tiendas.existsBy({ id: p.tiendaId, ownerId: u.id }))) return;
    throw sinPermiso('No participas en este pedido');
  }

  async detalle(usuario: Usuario, id: string) {
    return this.vista(await this.accesible(id, usuario), usuario);
  }

  async bitacora(usuario: Usuario, id: string) {
    const p = await this.accesible(id, usuario);
    const filas = await this.eventos.find({ where: { pedidoId: p.id }, order: { creadoEn: 'ASC' } });
    return filas.map((e) => ({
      id: e.id, tipo: e.tipo, usuarioId: e.usuarioId, rol: e.rol, detalle: e.detalle,
      ubicacion: coords(e.lat, e.lng), creadoEn: e.creadoEn,
    }));
  }

  // ─────────────────────────── vistas (JSON del contrato)

  async vista(p: Pedido, visor: Usuario) {
    return (await this.vistas([p], visor))[0];
  }

  async vistas(lista: Pedido[], visor: Usuario) {
    if (!lista.length) return [];
    const ids = lista.map((p) => p.id);
    const idsRep = [...new Set(lista.map((p) => p.repartidorId).filter(Boolean))];
    const [tiendas, items, reps, califs] = await Promise.all([
      this.tiendas.findBy({ id: In([...new Set(lista.map((p) => p.tiendaId))]) }),
      this.items.find({ where: { pedidoId: In(ids) } }),
      idsRep.length ? this.usuarios.findBy({ id: In(idsRep) }) : [],
      this.calificaciones.findBy({ pedidoId: In(ids) }),
    ]);

    return lista.map((p) => {
      const t = tiendas.find((x) => x.id === p.tiendaId);
      const r = reps.find((x) => x.id === p.repartidorId);
      const c = califs.find((x) => x.pedidoId === p.id);
      const activo = !ESTADOS_FINALES.includes(p.estado);
      // El repartidor solo ve teléfonos de sus pedidos activos.
      const verTelefonos = visor.rol !== 'repartidor' || (p.repartidorId === visor.id && activo);
      return {
        id: p.id,
        folio: folio('R', p.folioNum),
        estado: p.estado,
        origen: p.origen,
        tienda: {
          id: t.id, nombre: t.nombre, telefono: verTelefonos ? t.telefono : null, direccion: t.direccion,
          ubicacion: { lat: t.lat, lng: t.lng },
        },
        clienteId: p.clienteId,
        destino: {
          nombre: p.destinoNombre,
          telefono: verTelefonos ? p.destinoTelefono : null,
          direccion: p.destinoDireccion,
          referencias: p.destinoReferencias,
          ubicacion: { lat: p.destinoLat, lng: p.destinoLng },
        },
        descripcion: p.descripcion,
        items: items
          .filter((i) => i.pedidoId === p.id)
          .map((i) => ({
            productoId: i.productoId, nombre: i.nombre, cantidad: i.cantidad, precioUnitario: i.precioUnitario,
            importe: redondear(i.precioUnitario * i.cantidad),
          })),
        subtotal: p.subtotal,
        costoEnvio: p.costoEnvio,
        total: p.total,
        distanciaKm: p.distanciaKm,
        metodoPago: p.metodoPago,
        montoAPagarTienda: p.subtotal,
        // El código de entrega solo lo ve el cliente dueño del pedido.
        codigoEntrega: visor.id === p.clienteId ? p.codigoEntrega : null,
        calificacion: c ? { tienda: c.tienda, repartidor: c.repartidor, comentario: c.comentario, creadoEn: c.creadoEn } : null,
        notas: p.notas,
        repartidor: r
          ? { id: r.id, nombre: r.nombre, telefono: activo ? r.telefono : null, ubicacion: activo ? coords(r.lat, r.lng) : null }
          : null,
        viajeId: p.viajeId,
        creadoEn: p.creadoEn,
        actualizadoEn: p.actualizadoEn,
      };
    });
  }

  /** Lo que ve un repartidor antes de tomar el pedido (sin datos personales del cliente). */
  disponible(p: Pedido, t: Tienda, metrosATienda: number | null = null) {
    return {
      id: p.id,
      folio: folio('R', p.folioNum),
      tienda: { id: t.id, nombre: t.nombre, telefono: null, direccion: t.direccion, ubicacion: { lat: t.lat, lng: t.lng } },
      destinoUbicacion: { lat: p.destinoLat, lng: p.destinoLng },
      destinoDireccion: p.destinoDireccion,
      distanciaATiendaKm: metrosATienda == null ? null : redondear(metrosATienda / 1000),
      distanciaEntregaKm: p.distanciaKm,
      costoEnvio: p.costoEnvio,
      montoAPagarTienda: p.subtotal,
      totalACobrar: p.total,
    };
  }

  // ─────────────────────────── máquina de estados

  /**
   * Único camino para cambiar el estado de un pedido. Dentro de una transacción:
   * bloquea el pedido, valida, cambia el estado, escribe la bitácora y cierra el viaje si ya terminó.
   * Al confirmar, avisa por tiempo real y push.
   */
  async transicionar(id: string, t: Transicion): Promise<Pedido> {
    let repartidorAnterior: string | null = null;
    const pedido = await this.ds.transaction(async (m) => {
      const p = await m.findOne(Pedido, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!p) throw noEncontrado('Pedido no encontrado');
      await t.validar?.(p, m);
      if (!t.desde.includes(p.estado)) {
        throw conflicto('TRANSICION_INVALIDA', `No se puede hacer esto con un pedido en estado "${p.estado}"`);
      }
      await t.reglas?.(p, m);
      const viajeId = p.viajeId;
      repartidorAnterior = p.repartidorId;
      Object.assign(p, t.cambios?.(p) ?? {}, { estado: t.hacia });
      await m.save(p);
      await m.insert(EventoPedido, {
        pedidoId: p.id, tipo: t.evento, usuarioId: t.actor?.id ?? null, rol: t.actor?.rol ?? null,
        detalle: t.detalle ?? null, lat: t.ubicacion?.lat ?? null, lng: t.ubicacion?.lng ?? null,
      });
      if (viajeId) await this.cerrarViajeSiTermino(m, viajeId);
      return m.findOneByOrFail(Pedido, { id: p.id });
    });
    void this.notificar(pedido, repartidorAnterior, t.sinPush);
    return pedido;
  }

  /** Un viaje termina cuando ya no le quedan pedidos por entregar. */
  private async cerrarViajeSiTermino(m: EntityManager, viajeId: string) {
    const pendientes = await m.countBy(Pedido, { viajeId, estado: In(['asignado', 'en_tienda', 'en_camino', 'en_domicilio']) });
    if (!pendientes) await m.update(Viaje, { id: viajeId, estado: 'activo' }, { estado: 'finalizado', finalizadoEn: new Date() });
  }

  /** Eventos de Socket.IO y notificaciones push tras un cambio de estado. Nunca lanza errores. */
  async notificar(p: Pedido, repartidorAnterior: string | null = null, sinPush = false) {
    try {
      const tienda = await this.tiendas.findOneBy({ id: p.tiendaId });
      const f = folio('R', p.folioNum);
      const datos = { pedidoId: p.id, estado: p.estado };
      this.rt.emitir(
        [`pedido:${p.id}`, `tienda:${p.tiendaId}`, 'soporte', p.clienteId && `usuario:${p.clienteId}`,
          p.repartidorId && `usuario:${p.repartidorId}`, repartidorAnterior && `usuario:${repartidorAnterior}`],
        'pedido:actualizado',
        { ...datos, actualizadoEn: p.actualizadoEn },
      );
      if (sinPush) return;

      if (AVISO_CLIENTE[p.estado]) void this.push.aUsuarios([p.clienteId], `Pedido ${f}`, AVISO_CLIENTE[p.estado], datos);

      if (p.estado === 'listo_para_recoger') {
        this.rt.emitir(['repartidores'], 'pedido:disponible', this.disponible(p, tienda));
        const cerca = await this.ds.query(
          `SELECT u.id FROM usuarios u
           WHERE u.rol = 'repartidor' AND u.estado = 'activo' AND u.disponible
             AND ST_DWithin(u.ubicacion, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)`,
          [tienda.lng, tienda.lat, REGLAS.repartidor.radioKm * 1000],
        );
        void this.push.aUsuarios(cerca.map((c) => c.id), 'Pedido disponible', `${tienda.nombre} · envío $${p.costoEnvio}`, datos);
        if (repartidorAnterior) void this.push.aUsuarios([repartidorAnterior], `Pedido ${f}`, 'Soporte reasignó este pedido', datos);
      }
      if (p.estado === 'asignado') this.rt.emitir(['repartidores'], 'pedido:tomado', { pedidoId: p.id });
      if (p.estado === 'en_tienda') void this.push.aUsuarios([tienda.ownerId], `Pedido ${f}`, 'El repartidor llegó por el pedido', datos);
      if (p.estado === 'cancelado') {
        this.rt.emitir(['repartidores'], 'pedido:tomado', { pedidoId: p.id }); // por si seguía en el mapa
        void this.push.aUsuarios([tienda.ownerId, repartidorAnterior], `Pedido ${f}`, 'El pedido fue cancelado', datos);
      }
    } catch {
      /* avisar es secundario: el cambio de estado ya quedó guardado */
    }
  }

  // ─────────────────────────── acciones de tienda y cliente

  private deMiTienda = (usuario: Usuario) => async (p: Pedido, m: EntityManager) => {
    if (!(await m.existsBy(Tienda, { id: p.tiendaId, ownerId: usuario.id }))) throw sinPermiso('El pedido no es de tu tienda');
  };

  async aceptar(usuario: Usuario, id: string) {
    const p = await this.transicionar(id, {
      desde: ['creado'], hacia: 'aceptado_tienda', evento: 'aceptado_tienda', actor: usuario, validar: this.deMiTienda(usuario),
    });
    return this.vista(p, usuario);
  }

  async rechazar(usuario: Usuario, id: string, motivo: string) {
    const p = await this.transicionar(id, {
      desde: ['creado'], hacia: 'rechazado', evento: 'rechazado', actor: usuario, detalle: motivo, validar: this.deMiTienda(usuario),
    });
    return this.vista(p, usuario);
  }

  async marcarListo(usuario: Usuario, id: string) {
    const p = await this.transicionar(id, {
      desde: ['aceptado_tienda'], hacia: 'listo_para_recoger', evento: 'listo_para_recoger', actor: usuario,
      validar: this.deMiTienda(usuario), cambios: () => ({ listoEn: new Date() }),
    });
    return this.vista(p, usuario);
  }

  /** Cliente: solo en `creado`. Tienda: antes de que un repartidor lo tome. Después, solo soporte. */
  async cancelar(usuario: Usuario, id: string, motivo: string) {
    const esCliente = usuario.rol === 'cliente';
    const p = await this.transicionar(id, {
      desde: esCliente ? ['creado'] : ['creado', 'aceptado_tienda', 'listo_para_recoger'],
      hacia: 'cancelado', evento: 'cancelado', actor: usuario, detalle: motivo,
      validar: esCliente
        ? (x) => { if (x.clienteId !== usuario.id) throw sinPermiso('El pedido no es tuyo'); }
        : this.deMiTienda(usuario),
    });
    return this.vista(p, usuario);
  }

  async calificar(cliente: Usuario, id: string, dto: CalificacionDto) {
    const p = await this.pedidos.findOneBy({ id });
    if (!p) throw noEncontrado('Pedido no encontrado');
    if (p.clienteId !== cliente.id) throw sinPermiso('El pedido no es tuyo');
    const limite = REGLAS.pedido.horasParaCalificar * 3600000;
    if (p.estado !== 'entregado') throw conflicto('CALIFICACION_INVALIDA', 'Solo puedes calificar pedidos entregados');
    if (Date.now() - (p.entregadoEn ?? p.actualizadoEn).getTime() > limite) {
      throw conflicto('CALIFICACION_INVALIDA', `Solo puedes calificar dentro de las ${REGLAS.pedido.horasParaCalificar} horas siguientes a la entrega`);
    }
    if (await this.calificaciones.existsBy({ pedidoId: id })) throw conflicto('CALIFICACION_INVALIDA', 'Ya calificaste este pedido');

    const c = await this.ds.transaction(async (m) => {
      const fila = await m.save(
        m.create(Calificacion, {
          pedidoId: id, tiendaId: p.tiendaId, repartidorId: p.repartidorId, tienda: dto.tienda, repartidor: dto.repartidor,
          comentario: dto.comentario ?? null,
        }),
      );
      await m.query(
        `UPDATE tiendas SET calificacion = (SELECT round(avg(tienda), 2) FROM calificaciones WHERE tienda_id = $1) WHERE id = $1`,
        [p.tiendaId],
      );
      await m.insert(EventoPedido, { pedidoId: id, tipo: 'calificado', usuarioId: cliente.id, rol: cliente.rol });
      return fila;
    });
    return { tienda: c.tienda, repartidor: c.repartidor, comentario: c.comentario, creadoEn: c.creadoEn };
  }
}
