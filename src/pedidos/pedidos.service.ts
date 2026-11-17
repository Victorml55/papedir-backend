import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomInt, randomUUID } from 'crypto';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { pagina } from '../common/dtos';
import { conflicto, invalido, noEncontrado, sinPermiso } from '../common/errores';
import { coords, folio, redondear } from '../common/util';
import { ESTADOS_FINALES, EstadoPedido, MOTIVOS, REGLAS } from '../config/reglas';
import { CuponesService } from '../cupones/cupones.service';
import { FinanzasService } from '../finanzas/finanzas.service';
import {
  Calificacion, Direccion, EventoPedido, GrupoOpciones, Opcion, OpcionElegida, Pedido, PedidoItem, Producto, Recargo, Tienda, Usuario,
  Vehiculo, Viaje,
} from '../database/entities';
import { EnvioService } from '../nucleo/envio.service';
import { PushService } from '../nucleo/push.service';
import { RealtimeService } from '../nucleo/realtime.service';
import {
  CalificacionDto, CotizarManualDto, CotizarPedidoDto, CrearPedidoDto, GrupoPedidosDto, ListarPedidosDto, MotivoCancelacionDto, PedidoManualDto,
} from './pedidos.dto';

export const vistaVehiculo = (v: Vehiculo | null | undefined) =>
  v ? { tipo: v.tipo, marca: v.marca, modelo: v.modelo, color: v.color, placa: v.placa } : null;

type Linea = { producto: Producto; cantidad: number; opciones: OpcionElegida[]; precioUnitario: number };

const ESTADOS: EstadoPedido[] = ['programado', 'creado', 'aceptado_tienda', 'listo_para_recoger', 'asignado', 'en_tienda', 'en_camino',
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
    private readonly cupones: CuponesService,
    private readonly finanzas: FinanzasService,
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

  /** Hora de entrega de un pedido programado: de 45 minutos a 7 días a partir de ahora. */
  private horaProgramada(texto?: string) {
    if (!texto) return null;
    const h = new Date(texto);
    const minutos = (h.getTime() - Date.now()) / 60000;
    if (minutos < REGLAS.pedido.programadoMinMinutos) {
      throw invalido(`Programa el pedido con al menos ${REGLAS.pedido.programadoMinMinutos} minutos de anticipación`, 'programadoPara');
    }
    if (minutos > REGLAS.pedido.programadoMaxDias * 1440) {
      throw invalido(`Solo puedes programar hasta ${REGLAS.pedido.programadoMaxDias} días antes`, 'programadoPara');
    }
    return h;
  }

  /** Valida el carrito con los precios vigentes y calcula subtotal, envío, cupón, propina y total. */
  private async preparar(cliente: Usuario, dto: CotizarPedidoDto) {
    const tienda = await this.tiendas.findOneBy({ id: dto.tiendaId });
    if (!tienda) throw noEncontrado('Tienda no encontrada');
    const dueno = await this.usuarios.findOneBy({ id: tienda.ownerId });
    const programadoPara = this.horaProgramada(dto.programadoPara);
    // Un pedido programado se valida contra el horario de la hora de entrega, no contra el de ahora.
    const [{ abierta }] = await this.ds.query(`SELECT tienda_abierta_ahora($1, $2) AS abierta`, [tienda.id, programadoPara ?? new Date()]);
    if (!abierta || dueno?.estado !== 'activo') {
      const pausa = !programadoPara && tienda.abierta && tienda.pausadaHasta && tienda.pausadaHasta > new Date();
      throw conflicto('TIENDA_CERRADA', programadoPara
        ? `${tienda.nombre} no abre a esa hora`
        : pausa ? `${tienda.nombre} no está recibiendo pedidos por el momento` : `${tienda.nombre} está cerrada`);
    }

    const direccion = await this.direcciones.findOneBy({ id: dto.direccionId, clienteId: cliente.id });
    if (!direccion) throw noEncontrado('Dirección no encontrada');

    const lineas = await this.lineas(tienda, dto.items);
    const subtotal = redondear(lineas.reduce((s, l) => s + l.precioUnitario * l.cantidad, 0));
    if (subtotal < REGLAS.pedido.minimoProductos) {
      throw conflicto('PEDIDO_MINIMO', `El pedido mínimo es de $${REGLAS.pedido.minimoProductos} en productos`);
    }
    const { distanciaKm, costoEnvio, recargos } = await this.envio.cotizar(tienda, direccion, programadoPara ?? new Date());
    const cupon = dto.cupon?.trim() ? await this.cupones.aplicar(dto.cupon, cliente.id, tienda, subtotal, costoEnvio) : null;
    const descuento = cupon?.descuento ?? 0;
    const propina = redondear(dto.propina ?? 0);
    const total = redondear(subtotal + costoEnvio + propina - descuento);
    this.validarMaximo(total);
    const montoTienda = redondear(subtotal - (cupon?.absorbe === 'tienda' ? descuento : 0));
    return { tienda, direccion, lineas, subtotal, costoEnvio, recargos, cupon, descuento, propina, total, montoTienda, distanciaKm, programadoPara };
  }

  /**
   * Valida productos, opciones e inventario del carrito.
   * El mismo producto con las mismas opciones se junta en una línea; con opciones distintas son líneas separadas.
   */
  private async lineas(tienda: Tienda, items: { productoId: string; cantidad: number; opciones?: string[] }[]): Promise<Linea[]> {
    const ids = [...new Set(items.map((i) => i.productoId))];
    const productos = await this.productos.findBy({ id: In(ids), tiendaId: tienda.id, eliminado: false });
    if (productos.length !== ids.length) throw invalido('Todos los productos deben ser de la misma tienda', 'items');
    const grupos = await this.ds.getRepository(GrupoOpciones).findBy({ productoId: In(ids) });
    const opciones = grupos.length ? await this.ds.getRepository(Opcion).findBy({ grupoId: In(grupos.map((g) => g.id)) }) : [];

    const porClave = new Map<string, Linea>();
    items.forEach((item, idx) => {
      const producto = productos.find((p) => p.id === item.productoId);
      if (!producto.disponible || producto.stock === 0) throw conflicto('PRODUCTO_AGOTADO', `${producto.nombre} está agotado`);
      const elegidas = [...new Set(item.opciones ?? [])];
      const suyos = grupos.filter((g) => g.productoId === producto.id).sort((a, b) => a.orden - b.orden);
      const elegidasOk = elegidas.map((id) => {
        const o = opciones.find((x) => x.id === id && suyos.some((g) => g.id === x.grupoId));
        if (!o) throw invalido(`Una opción elegida no pertenece a ${producto.nombre}; actualiza el menú`, `items.${idx}.opciones`);
        if (!o.disponible) throw conflicto('PRODUCTO_AGOTADO', `${producto.nombre}: "${o.nombre}" está agotado`);
        return o;
      });
      for (const g of suyos) {
        const n = elegidasOk.filter((o) => o.grupoId === g.id).length;
        if (n < g.minimo || n > g.maximo) {
          const regla = g.minimo === g.maximo ? `${g.minimo}` : g.minimo ? `de ${g.minimo} a ${g.maximo}` : `hasta ${g.maximo}`;
          throw invalido(`${producto.nombre}: en "${g.nombre}" elige ${regla}`, `items.${idx}.opciones`);
        }
      }
      const snapshot: OpcionElegida[] = elegidasOk
        .sort((a, b) => suyos.findIndex((g) => g.id === a.grupoId) - suyos.findIndex((g) => g.id === b.grupoId) || a.orden - b.orden)
        .map((o) => ({ grupo: suyos.find((g) => g.id === o.grupoId).nombre, nombre: o.nombre, precioExtra: o.precioExtra }));
      const clave = `${producto.id}|${elegidasOk.map((o) => o.id).sort().join(',')}`;
      const previa = porClave.get(clave);
      if (previa) previa.cantidad += item.cantidad;
      else {
        const precioUnitario = redondear(producto.precio + snapshot.reduce((s, o) => s + o.precioExtra, 0));
        porClave.set(clave, { producto, cantidad: item.cantidad, opciones: snapshot, precioUnitario });
      }
    });

    // Inventario: la suma de todas las líneas del mismo producto.
    for (const p of productos.filter((x) => x.stock != null)) {
      const pedidas = [...porClave.values()].filter((l) => l.producto.id === p.id).reduce((s, l) => s + l.cantidad, 0);
      if (pedidas > p.stock) throw conflicto('PRODUCTO_AGOTADO', `Solo quedan ${p.stock} de ${p.nombre}`);
    }
    return [...porClave.values()];
  }

  private validarMaximo(total: number) {
    if (total > REGLAS.pedido.maximoEfectivo) {
      throw conflicto('PEDIDO_MAXIMO_EFECTIVO', `El máximo para pago en efectivo es de $${REGLAS.pedido.maximoEfectivo}`);
    }
  }

  private cotizacion(
    c: { distanciaKm: number; subtotal: number; costoEnvio: number; total: number; recargos: Recargo[]; descuento?: number; propina?: number; cupon?: any; programadoPara?: Date | null },
    preparacionMin: number,
  ) {
    return {
      distanciaKm: c.distanciaKm,
      subtotal: c.subtotal,
      costoEnvio: c.costoEnvio,
      recargos: c.recargos,
      descuento: c.descuento ?? 0,
      cupon: c.cupon ? { codigo: c.cupon.cupon.codigo, descripcion: c.cupon.cupon.descripcion } : null,
      propina: c.propina ?? 0,
      total: c.total,
      metodoPago: 'efectivo' as const,
      programadoPara: c.programadoPara ?? null,
      tiempoEstimadoMin: preparacionMin + this.envio.minutosDeTraslado(c.distanciaKm),
    };
  }

  async cotizar(cliente: Usuario, dto: CotizarPedidoDto) {
    const c = await this.preparar(cliente, dto);
    return this.cotizacion(c, c.tienda.tiempoPreparacionMin);
  }

  /** Inserta un pedido de la app ya validado (dentro de una transacción). Revalida el cupón con bloqueo. */
  private async insertar(m: EntityManager, cliente: Usuario, c: Awaited<ReturnType<PedidosService['preparar']>>, notas: string | null, grupoId: string | null) {
    if (c.cupon) {
      const otra = await this.cupones.aplicar(c.cupon.cupon.codigo, cliente.id, c.tienda, c.subtotal, c.costoEnvio, m);
      if (otra.descuento !== c.descuento) throw conflicto('CUPON_INVALIDO', 'El cupón cambió; vuelve a cotizar');
    }
    const programado = !!c.programadoPara;
    const p = await m.save(
      m.create(Pedido, {
        estado: programado ? 'programado' : 'creado',
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
        recargos: c.recargos,
        propina: c.propina,
        descuento: c.descuento,
        cuponId: c.cupon?.cupon.id ?? null,
        descuentoAbsorbe: c.cupon?.absorbe ?? null,
        montoTienda: c.montoTienda,
        total: c.total,
        distanciaKm: c.distanciaKm,
        codigoEntrega: String(randomInt(0, 10000)).padStart(4, '0'),
        notas,
        grupoId,
        programadoPara: c.programadoPara,
        enviadoATiendaEn: programado ? null : new Date(),
      }),
    );
    await m.insert(
      PedidoItem,
      c.lineas.map((l) => ({
        pedidoId: p.id, productoId: l.producto.id, nombre: l.producto.nombre, cantidad: l.cantidad,
        precioUnitario: l.precioUnitario, opciones: l.opciones, // precio y opciones quedan fijos en el pedido
      })),
    );
    // Descuenta inventario de forma atómica: si otro pedido se llevó las últimas piezas, falla.
    const porProducto = new Map<string, number>();
    for (const l of c.lineas) if (l.producto.stock != null) porProducto.set(l.producto.id, (porProducto.get(l.producto.id) ?? 0) + l.cantidad);
    for (const [productoId, cantidad] of porProducto) {
      const [, filas] = await m.query(`UPDATE productos SET stock = stock - $2 WHERE id = $1 AND stock >= $2`, [productoId, cantidad]);
      if (!filas) {
        const prod = c.lineas.find((l) => l.producto.id === productoId).producto;
        throw conflicto('PRODUCTO_AGOTADO', `Ya no quedan suficientes ${prod.nombre}`);
      }
    }
    await m.insert(EventoPedido, {
      pedidoId: p.id, tipo: 'creado', usuarioId: cliente.id, rol: cliente.rol,
      detalle: programado ? `Programado para ${c.programadoPara.toISOString()}` : null,
    });
    return m.findOneByOrFail(Pedido, { id: p.id });
  }

  /** Avisa a la tienda de un pedido nuevo (o programado). */
  private async avisarTienda(pedido: Pedido, tienda: Tienda) {
    const vista = await this.vista(pedido, { id: null, rol: 'soporte' } as Usuario);
    this.rt.emitir([`tienda:${tienda.id}`, 'soporte'], 'pedido:nuevo', vista);
    if (pedido.estado === 'programado') {
      const hora = new Intl.DateTimeFormat('es-MX', { timeZone: REGLAS.tienda.zonaHoraria, dateStyle: 'medium', timeStyle: 'short' }).format(pedido.programadoPara);
      void this.push.aUsuarios([tienda.ownerId], 'Pedido programado', `${vista.folio} para ${hora}`, { pedidoId: pedido.id });
    } else {
      void this.push.aUsuarios([tienda.ownerId], 'Pedido nuevo', `${vista.folio} · $${pedido.montoTienda}. Tienes ${REGLAS.pedido.minutosParaAceptar} minutos para aceptarlo`, { pedidoId: pedido.id });
    }
    return vista;
  }

  async crear(cliente: Usuario, dto: CrearPedidoDto) {
    const c = await this.preparar(cliente, dto);
    const pedido = await this.ds.transaction((m) => this.insertar(m, cliente, c, dto.notas ?? null, null));
    await this.avisarTienda(pedido, c.tienda);
    return this.vista(pedido, cliente);
  }

  /** Carrito de varias tiendas: se valida todo y se crean los pedidos juntos (o ninguno). */
  async crearGrupo(cliente: Usuario, dto: GrupoPedidosDto) {
    const ids = dto.pedidos.map((x) => x.tiendaId);
    if (new Set(ids).size !== ids.length) throw invalido('Cada tienda va una sola vez en el carrito', 'pedidos');
    const preparados = [];
    for (const x of dto.pedidos) {
      preparados.push(await this.preparar(cliente, { ...x, direccionId: dto.direccionId, programadoPara: dto.programadoPara }));
    }
    const grupoId = randomUUID();
    const pedidos = await this.ds.transaction(async (m) => {
      const lista: Pedido[] = [];
      for (const c of preparados) lista.push(await this.insertar(m, cliente, c, dto.notas ?? null, grupoId));
      return lista;
    });
    for (const [i, p] of pedidos.entries()) await this.avisarTienda(p, preparados[i].tienda);
    return { grupoId, total: redondear(pedidos.reduce((s, p) => s + p.total, 0)), pedidos: await this.vistas(pedidos, cliente) };
  }

  /** Sucursal elegida (X-Tienda-Id) o la primera del dueño. */
  private async sucursal(usuario: Usuario, tiendaId?: string) {
    const tienda = tiendaId
      ? await this.tiendas.findOneBy({ id: tiendaId, ownerId: usuario.id })
      : await this.tiendas.findOne({ where: { ownerId: usuario.id }, order: { creadoEn: 'ASC' } });
    if (!tienda) throw noEncontrado(tiendaId ? 'Esa sucursal no es tuya' : 'Esta cuenta no tiene una tienda');
    return tienda;
  }

  private async tiendaAprobada(usuario: Usuario, tiendaId?: string) {
    const tienda = await this.sucursal(usuario, tiendaId);
    if (usuario.estado !== 'activo') throw conflicto('CUENTA_PENDIENTE', 'Tu tienda está en revisión');
    return tienda;
  }

  async cotizarManual(usuario: Usuario, dto: CotizarManualDto, tiendaId?: string) {
    const tienda = await this.tiendaAprobada(usuario, tiendaId);
    const e = await this.envio.cotizar(tienda, dto.ubicacion);
    const total = redondear(dto.montoACobrar + e.costoEnvio);
    this.validarMaximo(total);
    return this.cotizacion({ ...e, subtotal: dto.montoACobrar, total }, 0);
  }

  /** Pedido capturado por la tienda (ventas por fuera de la app). Nace listo para recoger. */
  async crearManual(usuario: Usuario, dto: PedidoManualDto, tiendaId?: string) {
    const tienda = await this.tiendaAprobada(usuario, tiendaId);
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
          montoTienda: dto.montoACobrar,
          costoEnvio: e.costoEnvio,
          recargos: e.recargos,
          total,
          distanciaKm: e.distanciaKm,
          notas: dto.notas ?? null,
          listoEn: new Date(),
          enviadoATiendaEn: new Date(),
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

  /** Rol tienda: con X-Tienda-Id, solo esa sucursal; sin header, todas las sucursales del dueño. */
  async listar(usuario: Usuario, q: ListarPedidosDto, soloEntregados = false, tiendaId?: string) {
    const qb = this.pedidos.createQueryBuilder('p');
    if (usuario.rol === 'cliente') qb.where('p.cliente_id = :id', { id: usuario.id });
    else if (usuario.rol === 'repartidor') qb.where('p.repartidor_id = :id', { id: usuario.id });
    else if (usuario.rol === 'tienda') {
      const ids = tiendaId
        ? [(await this.sucursal(usuario, tiendaId)).id]
        : (await this.tiendas.findBy({ ownerId: usuario.id })).map((t) => t.id);
      qb.where('p.tienda_id = ANY(:ids)', { ids: ids.length ? ids : ['00000000-0000-0000-0000-000000000000'] });
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
    const [tiendas, items, reps, califs, vehiculos] = await Promise.all([
      this.tiendas.findBy({ id: In([...new Set(lista.map((p) => p.tiendaId))]) }),
      this.items.find({ where: { pedidoId: In(ids) } }),
      idsRep.length ? this.usuarios.findBy({ id: In(idsRep) }) : [],
      this.calificaciones.findBy({ pedidoId: In(ids) }),
      idsRep.length ? this.ds.getRepository(Vehiculo).findBy({ repartidorId: In(idsRep) }) : [],
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
            opciones: i.opciones ?? [], importe: redondear(i.precioUnitario * i.cantidad),
          })),
        subtotal: p.subtotal,
        costoEnvio: p.costoEnvio,
        recargos: p.recargos ?? [],
        propina: p.propina,
        descuento: p.descuento,
        total: p.total,
        distanciaKm: p.distanciaKm,
        metodoPago: p.metodoPago,
        montoAPagarTienda: p.montoTienda,
        // Comisión de PaPedir: solo la ven la tienda, soporte y admin.
        comisionTienda: visor.rol === 'cliente' || visor.rol === 'repartidor' ? null : p.comisionTienda,
        grupoId: p.grupoId,
        programadoPara: p.programadoPara,
        motivoCancelacion: p.motivoCodigo,
        // El código de entrega solo lo ve el cliente dueño del pedido.
        codigoEntrega: visor.id === p.clienteId ? p.codigoEntrega : null,
        calificacion: c ? { tienda: c.tienda, repartidor: c.repartidor, comentario: c.comentario, creadoEn: c.creadoEn } : null,
        notas: p.notas,
        repartidor: r
          ? {
              id: r.id, nombre: r.nombre, telefono: activo ? r.telefono : null, ubicacion: activo ? coords(r.lat, r.lng) : null,
              fotoUrl: r.fotoUrl, calificacion: r.calificacion, vehiculo: vistaVehiculo(vehiculos.find((v) => v.repartidorId === r.id)),
            }
          : null,
        etaMin: this.eta(p, t, r),
        viajeId: p.viajeId,
        creadoEn: p.creadoEn,
        actualizadoEn: p.actualizadoEn,
      };
    });
  }

  /**
   * Minutos aproximados para que el pedido llegue al cliente; null si ya terminó.
   * Considera preparación, la posición del repartidor y la distancia; no el tráfico ni las otras paradas del viaje.
   */
  private eta(p: Pedido, t: Tienda, r: Usuario | undefined): number | null {
    const destino = { lat: p.destinoLat, lng: p.destinoLng };
    const repPos = r?.lat != null ? { lat: r.lat, lng: r.lng } : null;
    const entrega = this.envio.minutosDeTraslado(p.distanciaKm);
    switch (p.estado) {
      case 'programado':
        return Math.max(0, Math.ceil((p.programadoPara.getTime() - Date.now()) / 60000));
      case 'creado':
      case 'aceptado_tienda': {
        const transcurridos = (Date.now() - p.creadoEn.getTime()) / 60000;
        return Math.max(0, Math.ceil(t.tiempoPreparacionMin - transcurridos)) + entrega;
      }
      case 'listo_para_recoger':
        return entrega + 5; // tiempo para que un repartidor lo tome
      case 'asignado':
        return (repPos ? this.envio.minutosEntre(repPos, t) : 5) + entrega;
      case 'en_tienda':
        return entrega;
      case 'en_camino':
        return repPos ? this.envio.minutosEntre(repPos, destino) : entrega;
      case 'en_domicilio':
        return 0;
      default:
        return null;
    }
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
      propina: p.propina,
      montoAPagarTienda: p.montoTienda,
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
      // Un pedido cancelado o rechazado devuelve sus piezas al inventario.
      if ((t.hacia === 'cancelado' || t.hacia === 'rechazado') && p.origen === 'app') {
        await m.query(
          `UPDATE productos pr SET stock = pr.stock + i.cantidad
           FROM (SELECT producto_id, sum(cantidad)::int AS cantidad FROM pedido_items WHERE pedido_id = $1 GROUP BY 1) i
           WHERE pr.id = i.producto_id AND pr.stock IS NOT NULL`,
          [p.id],
        );
      }
      const viajeId = p.viajeId;
      repartidorAnterior = p.repartidorId;
      Object.assign(p, t.cambios?.(p) ?? {}, { estado: t.hacia });
      await m.save(p);
      await m.insert(EventoPedido, {
        pedidoId: p.id, tipo: t.evento, usuarioId: t.actor?.id ?? null, rol: t.actor?.rol ?? null,
        detalle: t.detalle ?? null, lat: t.ubicacion?.lat ?? null, lng: t.ubicacion?.lng ?? null,
      });
      if (t.hacia === 'entregado') await this.finanzas.registrarEntrega(m, p);
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
      if (p.estado === 'creado') return void (await this.avisarTienda(p, tienda)); // un programado llegó a la tienda

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

  /** Traduce código y/o texto del catálogo de motivos. Un código desconocido para ese rol es un error. */
  motivo(lista: keyof typeof MOTIVOS, dto: MotivoCancelacionDto) {
    const fila = dto.codigo ? MOTIVOS[lista].find(([c]) => c === dto.codigo) : null;
    if (dto.codigo && !fila) throw invalido(`Motivo desconocido: ${dto.codigo}`, 'codigo');
    return { codigo: fila?.[0] ?? 'otro', texto: dto.motivo?.trim() || fila[1] };
  }

  async rechazar(usuario: Usuario, id: string, dto: MotivoCancelacionDto) {
    const m = this.motivo('tienda', dto);
    const p = await this.transicionar(id, {
      desde: ['creado'], hacia: 'rechazado', evento: 'rechazado', actor: usuario, detalle: m.texto, validar: this.deMiTienda(usuario),
      cambios: () => ({ motivoCodigo: m.codigo }),
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

  /** Cliente: programado o recién creado. Tienda: antes de que un repartidor lo tome. Después, solo soporte. */
  async cancelar(usuario: Usuario, id: string, dto: MotivoCancelacionDto) {
    const esCliente = usuario.rol === 'cliente';
    const m = this.motivo(esCliente ? 'cliente' : 'tienda', dto);
    const p = await this.transicionar(id, {
      desde: esCliente ? ['programado', 'creado'] : ['programado', 'creado', 'aceptado_tienda', 'listo_para_recoger'],
      hacia: 'cancelado', evento: 'cancelado', actor: usuario, detalle: m.texto, cambios: () => ({ motivoCodigo: m.codigo }),
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
      if (p.repartidorId) {
        await m.query(
          `UPDATE usuarios SET calificacion = (SELECT round(avg(repartidor), 2) FROM calificaciones WHERE repartidor_id = $1) WHERE id = $1`,
          [p.repartidorId],
        );
      }
      await m.insert(EventoPedido, { pedidoId: id, tipo: 'calificado', usuarioId: cliente.id, rol: cliente.rol });
      return fila;
    });
    return { tienda: c.tienda, repartidor: c.repartidor, comentario: c.comentario, creadoEn: c.creadoEn };
  }

  // ─────────────────────────── repetir y reseñas

  /**
   * Arma el carrito de un pedido anterior con el menú de hoy. Lo que ya no se puede pedir
   * (eliminado, agotado u opciones que cambiaron) va en `omitidos` para avisarle al cliente.
   */
  async repetir(cliente: Usuario, id: string) {
    const p = await this.pedidos.findOneBy({ id });
    if (!p) throw noEncontrado('Pedido no encontrado');
    if (p.clienteId !== cliente.id) throw sinPermiso('El pedido no es tuyo');
    const tienda = await this.tiendas.findOneByOrFail({ id: p.tiendaId });
    const items = await this.items.find({ where: { pedidoId: p.id } });
    const productos = await this.productos.findBy({ id: In(items.map((i) => i.productoId)), tiendaId: tienda.id, eliminado: false });
    const grupos = productos.length ? await this.ds.getRepository(GrupoOpciones).findBy({ productoId: In(productos.map((x) => x.id)) }) : [];
    const opciones = grupos.length ? await this.ds.getRepository(Opcion).findBy({ grupoId: In(grupos.map((g) => g.id)) }) : [];

    const carrito = [];
    const omitidos = [];
    for (const i of items) {
      const prod = productos.find((x) => x.id === i.productoId);
      if (!prod) { omitidos.push({ nombre: i.nombre, motivo: 'Ya no está en el menú' }); continue; }
      if (!prod.disponible || prod.stock === 0) { omitidos.push({ nombre: i.nombre, motivo: 'Agotado' }); continue; }
      const suyos = grupos.filter((g) => g.productoId === prod.id);
      const ids = (i.opciones ?? []).map((o) => {
        const g = suyos.find((x) => x.nombre === o.grupo);
        return opciones.find((x) => g && x.grupoId === g.id && x.nombre === o.nombre && x.disponible)?.id;
      });
      const completas = ids.every(Boolean) && suyos.every((g) => {
        const n = ids.filter((oid) => opciones.find((x) => x.id === oid)?.grupoId === g.id).length;
        return n >= g.minimo && n <= g.maximo;
      });
      if (!completas) { omitidos.push({ nombre: i.nombre, motivo: 'Sus opciones cambiaron; elígelas de nuevo' }); continue; }
      const extras = ids.reduce((s, oid) => s + opciones.find((x) => x.id === oid).precioExtra, 0);
      carrito.push({ productoId: prod.id, nombre: prod.nombre, cantidad: i.cantidad, opciones: ids, precioUnitario: redondear(prod.precio + extras) });
    }
    const [{ abierta }] = await this.ds.query(`SELECT tienda_abierta_ahora($1) AS abierta`, [tienda.id]);
    return { tienda: { id: tienda.id, nombre: tienda.nombre, abiertaAhora: abierta }, items: carrito, omitidos };
  }

  /** La tienda responde públicamente a la reseña de un pedido (se puede editar). */
  async responderResena(usuario: Usuario, pedidoId: string, texto: string) {
    const c = await this.calificaciones.findOneBy({ pedidoId });
    if (!c) throw noEncontrado('Ese pedido no tiene reseña');
    if (!(await this.tiendas.existsBy({ id: c.tiendaId, ownerId: usuario.id }))) throw sinPermiso('La reseña no es de tu tienda');
    Object.assign(c, { respuesta: texto.trim(), respondidoEn: new Date() });
    await this.calificaciones.save(c);
    const p = await this.pedidos.findOneBy({ id: pedidoId });
    await this.push.aUsuarios([p?.clienteId], 'La tienda respondió tu reseña', c.respuesta.slice(0, 120), { pedidoId });
    return { pedidoId, respuesta: c.respuesta, respondidoEn: c.respondidoEn };
  }
}
