import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Not, Repository } from 'typeorm';
import { PaginaDto } from '../common/dtos';
import { conflicto, noEncontrado, sinPermiso } from '../common/errores';
import { metrosEntre, redondear } from '../common/util';
import { ESTADOS_CON_REPARTIDOR, EstadoPedido, REGLAS } from '../config/reglas';
import { EventoPedido, Pedido, Tienda, Usuario, Viaje } from '../database/entities';
import { EnvioService } from '../nucleo/envio.service';
import { RealtimeService } from '../nucleo/realtime.service';
import { PedidosService } from '../pedidos/pedidos.service';
import { DisponiblesDto, EntregaDto } from './repartidor.dto';

type Punto = { lat: number; lng: number };
const R = REGLAS.repartidor;

@Injectable()
export class RepartidorService {
  constructor(
    private readonly ds: DataSource,
    private readonly pedidosSvc: PedidosService,
    private readonly envio: EnvioService,
    private readonly rt: RealtimeService,
    @InjectRepository(Usuario) private readonly usuarios: Repository<Usuario>,
    @InjectRepository(Pedido) private readonly pedidos: Repository<Pedido>,
    @InjectRepository(Viaje) private readonly viajes: Repository<Viaje>,
    @InjectRepository(Tienda) private readonly tiendas: Repository<Tienda>,
  ) {}

  // ─────────────────────────── conexión y ubicación

  async cambiarDisponibilidad(rep: Usuario, disponible: boolean) {
    if (disponible && rep.estado !== 'activo') {
      throw conflicto('CUENTA_PENDIENTE', 'Tu cuenta está en revisión; podrás conectarte cuando soporte la apruebe');
    }
    if (!disponible && (await this.viajes.existsBy({ repartidorId: rep.id, estado: 'activo' }))) {
      throw conflicto('VIAJE_ACTIVO', 'Termina tu viaje antes de desconectarte');
    }
    await this.usuarios.update(rep.id, { disponible });
    return { disponible };
  }

  /** Guarda la ubicación y la reenvía a quienes siguen sus pedidos en curso. */
  async reportarUbicacion(repartidorId: string, u: Punto) {
    const ahora = new Date();
    await this.usuarios.update(repartidorId, { lat: u.lat, lng: u.lng, ubicacionEn: ahora });
    const enCurso = await this.pedidos.find({
      where: { repartidorId, estado: In(ESTADOS_CON_REPARTIDOR) },
      select: { id: true },
    });
    for (const p of enCurso) {
      this.rt.emitir([`pedido:${p.id}`], 'repartidor:ubicacion', { pedidoId: p.id, lat: u.lat, lng: u.lng, actualizadoEn: ahora });
    }
  }

  // ─────────────────────────── pedidos disponibles

  /**
   * Pedidos listos cerca del punto dado (PostGIS).
   * - Radio de 3 km; 6 km para pedidos con más de 5 minutos sin repartidor.
   * - Con viaje activo solo devuelve los "encadenables": tienda a ≤ 1.5 km de una parada pendiente
   *   y destino a ≤ 3 km de otro destino del viaje.
   */
  private async buscarDisponibles(m: EntityManager, punto: Punto, radioKm: number, viajeId: string | null, soloPedidoId: string | null = null) {
    const filas: { id: string; metros: number }[] = await m.query(
      `WITH yo AS (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS g)
       SELECT p.id, ST_Distance(t.ubicacion, yo.g) AS metros
       FROM pedidos p JOIN tiendas t ON t.id = p.tienda_id CROSS JOIN yo
       WHERE p.estado = 'listo_para_recoger'
         AND ($6::uuid IS NULL OR p.id = $6)
         AND ($6::uuid IS NOT NULL OR ST_DWithin(t.ubicacion, yo.g,
               CASE WHEN p.listo_en < now() - make_interval(mins => $4) THEN GREATEST($3::float8, $5::float8) ELSE $3::float8 END))
         AND ($7::uuid IS NULL OR (
               EXISTS (SELECT 1 FROM pedidos v JOIN tiendas vt ON vt.id = v.tienda_id
                       WHERE v.viaje_id = $7 AND v.estado IN ('asignado','en_tienda','en_camino','en_domicilio')
                         AND ((v.estado IN ('asignado','en_tienda') AND ST_DWithin(t.ubicacion, vt.ubicacion, $8))
                              OR ST_DWithin(t.ubicacion, v.destino_ubicacion, $8)))
           AND EXISTS (SELECT 1 FROM pedidos v
                       WHERE v.viaje_id = $7 AND v.estado IN ('asignado','en_tienda','en_camino','en_domicilio')
                         AND ST_DWithin(p.destino_ubicacion, v.destino_ubicacion, $9))))
       ORDER BY metros`,
      [punto.lng, punto.lat, radioKm * 1000, R.minutosAmpliar, R.radioAmpliadoKm * 1000, soloPedidoId, viajeId, R.encadenarTiendaM, R.encadenarDestinoM],
    );
    return filas;
  }

  private viajeActivo(m: EntityManager, repartidorId: string) {
    return m.findOneBy(Viaje, { repartidorId, estado: 'activo' });
  }

  /** Pedidos del viaje que cuentan para el máximo de 4 (los cancelados no). */
  private pedidosDelViaje(m: EntityManager, viajeId: string) {
    return m.find(Pedido, { where: { viajeId, estado: Not('cancelado') }, order: { creadoEn: 'ASC' } });
  }

  async disponibles(rep: Usuario, q: DisponiblesDto) {
    if (rep.estado !== 'activo') throw conflicto('CUENTA_PENDIENTE', 'Tu cuenta está en revisión');
    if (!rep.disponible) return []; // debe estar conectado para ver pedidos
    const m = this.ds.manager;
    const viaje = await this.viajeActivo(m, rep.id);
    if (viaje && (await this.pedidosDelViaje(m, viaje.id)).length >= R.maxPedidosPorViaje) return [];

    const filas = await this.buscarDisponibles(m, q, Math.min(q.radioKm ?? R.radioKm, R.radioKm), viaje?.id ?? null);
    if (!filas.length) return [];
    const pedidos = await this.pedidos.findBy({ id: In(filas.map((f) => f.id)) });
    const tiendas = await this.tiendas.findBy({ id: In(pedidos.map((p) => p.tiendaId)) });
    return filas.map((f) => {
      const p = pedidos.find((x) => x.id === f.id);
      return this.pedidosSvc.disponible(p, tiendas.find((t) => t.id === p.tiendaId), f.metros);
    });
  }

  /**
   * Tomar un pedido es atómico: se bloquea al repartidor (para no pasar de 4 pedidos con dos
   * peticiones simultáneas) y luego el pedido (si dos repartidores lo intentan, solo uno gana).
   */
  async tomar(rep: Usuario, pedidoId: string) {
    const pedido = await this.ds.transaction(async (m) => {
      const yo = await m.findOne(Usuario, { where: { id: rep.id }, lock: { mode: 'pessimistic_write' } });
      if (yo.estado !== 'activo') throw conflicto('CUENTA_PENDIENTE', 'Tu cuenta está en revisión');
      if (!yo.disponible) throw conflicto('REPARTIDOR_DESCONECTADO', 'Conéctate para tomar pedidos');

      let viaje = await this.viajeActivo(m, yo.id);
      if (viaje && (await this.pedidosDelViaje(m, viaje.id)).length >= R.maxPedidosPorViaje) {
        throw conflicto('VIAJE_LLENO', `Un viaje admite máximo ${R.maxPedidosPorViaje} pedidos`);
      }

      const p = await m.findOne(Pedido, { where: { id: pedidoId }, lock: { mode: 'pessimistic_write' } });
      if (!p) throw noEncontrado('Pedido no encontrado');
      if (p.estado !== 'listo_para_recoger') throw conflicto('PEDIDO_YA_TOMADO', 'El pedido ya no está disponible');

      if (viaje) {
        const encadenable = await this.buscarDisponibles(m, { lat: 0, lng: 0 }, 0, viaje.id, p.id);
        if (!encadenable.length) throw conflicto('NO_ENCADENABLE', 'Este pedido queda lejos de tu ruta actual');
      } else {
        viaje = await m.save(m.create(Viaje, { repartidorId: yo.id }));
      }

      Object.assign(p, { estado: 'asignado', repartidorId: yo.id, viajeId: viaje.id });
      await m.save(p);
      await m.insert(EventoPedido, { pedidoId: p.id, tipo: 'asignado', usuarioId: yo.id, rol: yo.rol, lat: yo.lat, lng: yo.lng });
      return m.findOneByOrFail(Pedido, { id: p.id });
    });
    void this.pedidosSvc.notificar(pedido);
    return this.viajeActual(await this.usuarios.findOneByOrFail({ id: rep.id }));
  }

  // ─────────────────────────── viaje

  async viajeActual(rep: Usuario) {
    const m = this.ds.manager;
    const viaje = await this.viajeActivo(m, rep.id);
    if (!viaje) return null;
    const pedidos = await this.pedidosDelViaje(m, viaje.id);
    const vistas = await this.pedidosSvc.vistas(pedidos, rep);
    const porRecoger = (e: EstadoPedido) => e === 'asignado' || e === 'en_tienda';

    return {
      id: viaje.id,
      estado: viaje.estado,
      maxPedidos: R.maxPedidosPorViaje,
      // Efectivo: paga el subtotal en cada tienda al recoger y cobra el total en cada domicilio.
      efectivoAPagarTiendas: redondear(pedidos.filter((p) => porRecoger(p.estado)).reduce((s, p) => s + p.subtotal, 0)),
      efectivoACobrar: redondear(pedidos.filter((p) => p.estado !== 'entregado').reduce((s, p) => s + p.total, 0)),
      gananciaEnvio: redondear(pedidos.reduce((s, p) => s + p.costoEnvio, 0)),
      paradas: this.ordenarParadas(vistas, rep),
      pedidos: vistas,
    };
  }

  /**
   * Orden sugerido de visita: primero las paradas ya hechas; después, desde la posición del
   * repartidor, siempre la parada pendiente más cercana. Un domicilio solo entra cuando su
   * pedido ya fue recogido.
   */
  private ordenarParadas(pedidos: any[], rep: Usuario) {
    const parada = (p: any, tipo: 'tienda' | 'domicilio', completada: boolean) => ({
      pedidoId: p.id,
      tipo,
      nombre: tipo === 'tienda' ? p.tienda.nombre : p.destino.nombre,
      direccion: tipo === 'tienda' ? p.tienda.direccion : p.destino.direccion,
      ubicacion: tipo === 'tienda' ? p.tienda.ubicacion : p.destino.ubicacion,
      completada,
    });
    const hechas = [];
    const pendientes: { p: any; tipo: 'tienda' | 'domicilio' }[] = [];
    const recogidos = new Set<string>();
    for (const p of pedidos) {
      const recogido = ['en_camino', 'en_domicilio', 'entregado'].includes(p.estado);
      if (recogido) recogidos.add(p.id);
      if (recogido) hechas.push(parada(p, 'tienda', true));
      else pendientes.push({ p, tipo: 'tienda' });
      if (p.estado === 'entregado') hechas.push(parada(p, 'domicilio', true));
      else pendientes.push({ p, tipo: 'domicilio' });
    }

    const ruta = [];
    let pos: Punto = rep.lat != null ? { lat: rep.lat, lng: rep.lng } : (pendientes[0]?.p.tienda.ubicacion ?? { lat: 0, lng: 0 });
    while (pendientes.length) {
      const candidatas = pendientes.filter((x) => x.tipo === 'tienda' || recogidos.has(x.p.id));
      const sig = candidatas.reduce((mejor, x) => {
        const d = metrosEntre(pos, parada(x.p, x.tipo, false).ubicacion);
        return !mejor || d < mejor.d ? { x, d } : mejor;
      }, null as { x: (typeof pendientes)[number]; d: number } | null).x;
      pendientes.splice(pendientes.indexOf(sig), 1);
      if (sig.tipo === 'tienda') recogidos.add(sig.p.id);
      const pa = parada(sig.p, sig.tipo, false);
      ruta.push(pa);
      pos = pa.ubicacion;
    }
    return [...hechas, ...ruta];
  }

  // ─────────────────────────── marcas

  private mio = (rep: Usuario) => (p: Pedido) => {
    if (p.repartidorId !== rep.id) throw sinPermiso('Este pedido no está asignado a ti');
  };

  /** Geocerca: las llegadas solo se aceptan a 150 m o menos del punto. */
  private async exigirCercania(desde: Punto, hasta: Punto, lugar: string) {
    const metros = await this.envio.metros(desde, hasta);
    if (metros > R.geocercaM) {
      throw conflicto('FUERA_DE_RANGO', `Estás a ${Math.round(metros)} m de ${lugar}; acércate a ${R.geocercaM} m o menos`);
    }
  }

  async llegadaTienda(rep: Usuario, id: string, ubicacion: Punto) {
    const p = await this.pedidosSvc.transicionar(id, {
      desde: ['asignado'], hacia: 'en_tienda', evento: 'llegada_tienda', actor: rep, ubicacion,
      validar: this.mio(rep),
      reglas: async (x, m) => {
        const t = await m.findOneByOrFail(Tienda, { id: x.tiendaId });
        await this.exigirCercania(ubicacion, t, 'la tienda');
      },
    });
    return this.pedidosSvc.vista(p, rep);
  }

  async salidaTienda(rep: Usuario, id: string, ubicacion: Punto) {
    const p = await this.pedidosSvc.transicionar(id, {
      desde: ['en_tienda'], hacia: 'en_camino', evento: 'salida_tienda', actor: rep, ubicacion, validar: this.mio(rep),
    });
    return this.pedidosSvc.vista(p, rep);
  }

  async llegadaCliente(rep: Usuario, id: string, ubicacion: Punto) {
    const p = await this.pedidosSvc.transicionar(id, {
      desde: ['en_camino'], hacia: 'en_domicilio', evento: 'llegada_cliente', actor: rep, ubicacion,
      validar: this.mio(rep),
      reglas: (x) => this.exigirCercania(ubicacion, { lat: x.destinoLat, lng: x.destinoLng }, 'el domicilio'),
    });
    return this.pedidosSvc.vista(p, rep);
  }

  /** Los pedidos de la app se entregan con el código de 4 dígitos que solo ve el cliente. */
  async entregar(rep: Usuario, id: string, dto: EntregaDto) {
    const p = await this.pedidosSvc.transicionar(id, {
      desde: ['en_domicilio'], hacia: 'entregado', evento: 'entregado', actor: rep, ubicacion: dto.ubicacion,
      validar: this.mio(rep),
      reglas: (x) => {
        if (x.codigoEntrega && dto.codigoEntrega !== x.codigoEntrega) {
          throw conflicto('CODIGO_INCORRECTO', 'El código de entrega no coincide; pídeselo al cliente');
        }
      },
      cambios: () => ({ entregadoEn: new Date(), evidenciaUrl: dto.evidenciaUrl ?? null }),
    });
    return this.pedidosSvc.vista(p, rep);
  }

  historial(rep: Usuario, q: PaginaDto) {
    return this.pedidosSvc.listar(rep, q, true);
  }
}
