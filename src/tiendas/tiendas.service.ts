import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';
import { pagina, PaginaDto, RangoFechasDto, rangoFechas } from '../common/dtos';
import { conflicto, invalido, noEncontrado } from '../common/errores';
import { redondear } from '../common/util';
import { REGLAS } from '../config/reglas';
import { CategoriaProducto, GrupoOpciones, HorarioTienda, Opcion, Producto, Tienda, Usuario } from '../database/entities';
import { RealtimeService } from '../nucleo/realtime.service';
import {
  BuscarTiendasDto, CategoriaDto, CategoriaUpdateDto, HorarioDto, OpcionesProductoDto, ProductoDto, ProductoUpdateDto,
  SucursalDto, TiendaUpdateDto,
} from './tiendas.dto';

const ZONA = REGLAS.tienda.zonaHoraria;
const hhmm = (t: string) => t.slice(0, 5);

export const vistaTienda = (t: Tienda, distanciaKm: number | null = null, abiertaAhora: boolean | null = null) => ({
  id: t.id,
  nombre: t.nombre,
  categoria: t.categoria,
  descripcion: t.descripcion,
  imagenUrl: t.imagenUrl,
  telefono: t.telefono,
  direccion: t.direccion,
  ubicacion: { lat: t.lat, lng: t.lng },
  abierta: t.abierta,
  // abierta + sin pausa + dentro de su horario: lo que decide si se le puede pedir ahora.
  abiertaAhora: abiertaAhora ?? t.abierta,
  pausadaHasta: t.pausadaHasta && t.pausadaHasta > new Date() ? t.pausadaHasta : null,
  usarHorario: t.usarHorario,
  plan: t.plan !== 'basico' && t.planHasta && t.planHasta > new Date() ? t.plan : 'basico',
  tiempoPreparacionMin: t.tiempoPreparacionMin,
  calificacion: t.calificacion,
  distanciaKm,
});

export const vistaTurno = (h: HorarioTienda) => ({ dia: h.dia, abre: hhmm(h.abre), cierra: hhmm(h.cierra) });
export const vistaCategoria = (c: CategoriaProducto) => ({ id: c.id, nombre: c.nombre, orden: c.orden });

type GrupoVista = { id: string; nombre: string; minimo: number; maximo: number; opciones: { id: string; nombre: string; precioExtra: number; disponible: boolean }[] };

export const vistaProducto = (p: Producto, grupos: GrupoVista[] = []) => ({
  id: p.id,
  tiendaId: p.tiendaId,
  categoriaId: p.categoriaId,
  nombre: p.nombre,
  descripcion: p.descripcion,
  precio: p.precio,
  imagenUrl: p.imagenUrl,
  imagenes: p.imagenes?.length ? p.imagenes : p.imagenUrl ? [p.imagenUrl] : [],
  disponible: p.disponible,
  stock: p.stock,
  // Lo que deben usar las apps para mostrar "Agotado": marcado sin existencia o con stock en 0.
  agotado: !p.disponible || p.stock === 0,
  grupos,
});

@Injectable()
export class TiendasService {
  constructor(
    private readonly ds: DataSource,
    private readonly rt: RealtimeService,
    @InjectRepository(Tienda) private readonly tiendas: Repository<Tienda>,
    @InjectRepository(CategoriaProducto) private readonly categorias: Repository<CategoriaProducto>,
    @InjectRepository(Producto) private readonly productos: Repository<Producto>,
    @InjectRepository(HorarioTienda) private readonly horarios: Repository<HorarioTienda>,
    @InjectRepository(GrupoOpciones) private readonly grupos: Repository<GrupoOpciones>,
    @InjectRepository(Opcion) private readonly opciones: Repository<Opcion>,
  ) {}

  // ───────── ¿abierta ahora? (función tienda_abierta_ahora de la base)

  async abiertasAhora(ids: string[]): Promise<Map<string, boolean>> {
    if (!ids.length) return new Map();
    const filas = await this.ds.query(`SELECT id, tienda_abierta_ahora(id) AS a FROM tiendas WHERE id = ANY($1::uuid[])`, [ids]);
    return new Map(filas.map((f) => [f.id, f.a]));
  }

  async vista(t: Tienda) {
    return vistaTienda(t, null, (await this.abiertasAhora([t.id])).get(t.id));
  }

  // ───────── consulta (cliente)

  /** Tiendas que reciben pedidos ahora; con lat/lng filtra por radio y ordena por cercanía (PostGIS). */
  async buscar(q: BuscarTiendasDto) {
    if ((q.lat == null) !== (q.lng == null)) throw invalido('lat y lng deben enviarse juntos', 'lat');
    const conUbicacion = q.lat != null;
    const params: any[] = [];
    const p = (v: any) => (params.push(v), `$${params.length}`);

    const punto = conUbicacion ? `ST_SetSRID(ST_MakePoint(${p(q.lng)}, ${p(q.lat)}), 4326)::geography` : null;
    const filtros = [`tienda_abierta_ahora(t.id)`, `u.estado = 'activo'`];
    if (conUbicacion) filtros.push(`ST_DWithin(t.ubicacion, ${punto}, ${p(q.radioKm * 1000)})`);
    if (q.q?.trim()) filtros.push(`t.nombre ILIKE ${p(`%${q.q.trim()}%`)}`);
    if (q.categoria) filtros.push(`t.categoria = ${p(q.categoria)}`);

    const desde = `FROM tiendas t JOIN usuarios u ON u.id = t.owner_id WHERE ${filtros.join(' AND ')}`;
    const [{ total }] = await this.ds.query(`SELECT count(*)::int AS total ${desde}`, params);
    const filas = await this.ds.query(
      `SELECT t.id, ${conUbicacion ? `ST_Distance(t.ubicacion, ${punto})` : 'NULL'} AS metros ${desde}
       ORDER BY (t.plan = 'premium' AND t.plan_hasta > now()) DESC, metros NULLS LAST, t.nombre LIMIT ${p(q.limit)} OFFSET ${p((q.page - 1) * q.limit)}`,
      params,
    );
    const porId = new Map((await this.tiendas.findBy({ id: In(filas.map((f) => f.id)) })).map((t) => [t.id, t]));
    const data = filas.map((f) => vistaTienda(porId.get(f.id), f.metros == null ? null : redondear(f.metros / 1000), true));
    return pagina(data, total, q);
  }

  /** Las tiendas dadas de baja solo las ve el panel (conEliminadas). */
  async porId(id: string, conEliminadas = false) {
    const t = await this.tiendas.findOneBy(conEliminadas ? { id } : { id, eliminadaEn: IsNull() });
    if (!t) throw noEncontrado('Tienda no encontrada');
    return t;
  }

  /** Detalle para el cliente: incluye el horario semanal. */
  async detalle(id: string, conEliminadas = false) {
    const t = await this.porId(id, conEliminadas);
    return { ...(await this.vista(t)), horario: await this.turnos(t.id) };
  }

  /** Menú para el cliente: categorías en orden, cada una con sus productos (los agotados incluidos) y sus opciones. */
  async menu(tiendaId: string, conEliminadas = false) {
    await this.porId(tiendaId, conEliminadas);
    const [cats, prods] = await Promise.all([
      this.categorias.find({ where: { tiendaId }, order: { orden: 'ASC', nombre: 'ASC' } }),
      this.productos.find({ where: { tiendaId, eliminado: false }, order: { nombre: 'ASC' } }),
    ]);
    const grupos = await this.gruposDe(prods.map((x) => x.id));
    return cats
      .map((c) => ({
        categoria: vistaCategoria(c),
        productos: prods.filter((x) => x.categoriaId === c.id).map((x) => vistaProducto(x, grupos.get(x.id))),
      }))
      .filter((g) => g.productos.length);
  }

  /** Reseñas de una tienda, de la más nueva a la más vieja, con el resumen de calificaciones. */
  async resenas(tiendaId: string, q: PaginaDto) {
    await this.porId(tiendaId);
    const filas = await this.ds.query(
      // Una reseña oculta por moderación conserva sus estrellas, pero no su texto ni la respuesta.
      `SELECT c.pedido_id AS "pedidoId", c.tienda AS calificacion,
              CASE WHEN c.oculta THEN NULL ELSE c.comentario END AS comentario,
              CASE WHEN c.oculta THEN NULL ELSE c.respuesta END AS respuesta, c.oculta,
              c.respondido_en AS "respondidoEn",
              c.creado_en AS "creadoEn", u.nombre, u.estado
       FROM calificaciones c JOIN pedidos p ON p.id = c.pedido_id LEFT JOIN usuarios u ON u.id = p.cliente_id
       WHERE c.tienda_id = $1 ORDER BY c.creado_en DESC LIMIT $2 OFFSET $3`,
      [tiendaId, q.limit, (q.page - 1) * q.limit],
    );
    const [r] = await this.ds.query(
      `SELECT count(*)::int AS total, round(avg(tienda), 2)::float8 AS promedio,
              count(*) FILTER (WHERE tienda = 5)::int AS "5", count(*) FILTER (WHERE tienda = 4)::int AS "4",
              count(*) FILTER (WHERE tienda = 3)::int AS "3", count(*) FILTER (WHERE tienda = 2)::int AS "2",
              count(*) FILTER (WHERE tienda = 1)::int AS "1"
       FROM calificaciones WHERE tienda_id = $1`,
      [tiendaId],
    );
    // Solo el nombre y la inicial del apellido del cliente.
    const autor = (nombre: string | null, estado: string | null) => {
      if (!nombre || estado === 'eliminado') return 'Cliente';
      const [n, a] = nombre.trim().split(/\s+/);
      return a ? `${n} ${a[0]}.` : n;
    };
    const data = filas.map(({ nombre, estado, ...x }) => ({ ...x, cliente: autor(nombre, estado) }));
    return {
      ...pagina(data, r.total, q),
      resumen: { promedio: r.promedio, total: r.total, porEstrellas: { 5: r['5'], 4: r['4'], 3: r['3'], 2: r['2'], 1: r['1'] } },
    };
  }

  /** Grupos de opciones con sus opciones, por producto. */
  async gruposDe(productoIds: string[]): Promise<Map<string, GrupoVista[]>> {
    const res = new Map<string, GrupoVista[]>();
    if (!productoIds.length) return res;
    const gs = await this.grupos.find({ where: { productoId: In(productoIds) }, order: { orden: 'ASC' } });
    const os = gs.length ? await this.opciones.find({ where: { grupoId: In(gs.map((g) => g.id)) }, order: { orden: 'ASC' } }) : [];
    for (const g of gs) {
      const lista = res.get(g.productoId) ?? [];
      lista.push({
        id: g.id, nombre: g.nombre, minimo: g.minimo, maximo: g.maximo,
        opciones: os.filter((o) => o.grupoId === g.id).map((o) => ({ id: o.id, nombre: o.nombre, precioExtra: o.precioExtra, disponible: o.disponible })),
      });
      res.set(g.productoId, lista);
    }
    return res;
  }

  // ───────── sucursales (rol tienda)

  /**
   * Sucursal con la que trabaja el usuario: la del header X-Tienda-Id (si es suya)
   * o, sin header, la más antigua. Así las apps que no manejan sucursales siguen funcionando.
   */
  async deUsuario(usuarioId: string, tiendaId?: string) {
    const t = tiendaId
      ? await this.tiendas.findOneBy({ id: tiendaId, ownerId: usuarioId, eliminadaEn: IsNull() })
      : await this.tiendas.findOne({ where: { ownerId: usuarioId, eliminadaEn: IsNull() }, order: { creadoEn: 'ASC' } });
    if (!t) throw noEncontrado(tiendaId ? 'Esa sucursal no es tuya o fue dada de baja' : 'Esta cuenta no tiene una tienda activa; escribe a soporte');
    return t;
  }

  async misSucursales(usuarioId: string) {
    const ts = await this.tiendas.find({ where: { ownerId: usuarioId, eliminadaEn: IsNull() }, order: { creadoEn: 'ASC' } });
    const abiertas = await this.abiertasAhora(ts.map((t) => t.id));
    return ts.map((t) => vistaTienda(t, null, abiertas.get(t.id)));
  }

  async crearSucursal(usuario: Usuario, dto: SucursalDto) {
    if (usuario.estado !== 'activo') throw conflicto('CUENTA_PENDIENTE', 'Tu tienda está en revisión; podrás agregar sucursales cuando soporte la apruebe');
    if ((await this.tiendas.countBy({ ownerId: usuario.id, eliminadaEn: IsNull() })) >= REGLAS.tienda.maxSucursales) {
      throw conflicto('LIMITE_SUCURSALES', `Puedes tener máximo ${REGLAS.tienda.maxSucursales} sucursales`);
    }
    const origen = dto.copiarMenuDe ? await this.deUsuario(usuario.id, dto.copiarMenuDe) : null;
    const t = await this.ds.transaction(async (m) => {
      const nueva = await m.save(
        m.create(Tienda, {
          ownerId: usuario.id, nombre: dto.nombre.trim(), categoria: dto.categoria, descripcion: dto.descripcion ?? null,
          telefono: dto.telefono ?? null, direccion: dto.direccion, lat: dto.ubicacion.lat, lng: dto.ubicacion.lng,
          tiempoPreparacionMin: dto.tiempoPreparacionMin ?? 20, abierta: false,
        }),
      );
      if (origen) await this.copiarMenu(m, origen.id, nueva.id);
      return nueva;
    });
    this.rt.unir(usuario.id, `tienda:${t.id}`);
    return this.vista(t);
  }

  /** Copia categorías, productos (sin inventario) y opciones de una sucursal a otra. */
  private async copiarMenu(m: EntityManager, desde: string, hacia: string) {
    const cats = await m.findBy(CategoriaProducto, { tiendaId: desde });
    const mapaCat = new Map<string, string>();
    for (const c of cats) mapaCat.set(c.id, (await m.save(m.create(CategoriaProducto, { tiendaId: hacia, nombre: c.nombre, orden: c.orden }))).id);
    const prods = await m.findBy(Producto, { tiendaId: desde, eliminado: false });
    for (const p of prods) {
      const nuevo = await m.save(
        m.create(Producto, {
          tiendaId: hacia, categoriaId: p.categoriaId ? mapaCat.get(p.categoriaId) : null, nombre: p.nombre, descripcion: p.descripcion,
          precio: p.precio, imagenUrl: p.imagenUrl, imagenes: p.imagenes, disponible: p.disponible, stock: null,
        }),
      );
      for (const g of await m.find(GrupoOpciones, { where: { productoId: p.id }, order: { orden: 'ASC' } })) {
        const ng = await m.save(m.create(GrupoOpciones, { productoId: nuevo.id, nombre: g.nombre, minimo: g.minimo, maximo: g.maximo, orden: g.orden }));
        const os = await m.findBy(Opcion, { grupoId: g.id });
        if (os.length) {
          await m.insert(Opcion, os.map((o) => ({ grupoId: ng.id, nombre: o.nombre, precioExtra: o.precioExtra, disponible: o.disponible, orden: o.orden })));
        }
      }
    }
  }

  async actualizarMia(usuario: Usuario, dto: TiendaUpdateDto, tiendaId?: string) {
    const t = await this.deUsuario(usuario.id, tiendaId);
    if (dto.abierta && usuario.estado !== 'activo') {
      throw conflicto('CUENTA_PENDIENTE', 'Tu tienda está en revisión; podrás abrir cuando soporte la apruebe');
    }
    const { ubicacion, ...resto } = dto;
    Object.assign(t, resto);
    if (ubicacion) Object.assign(t, { lat: ubicacion.lat, lng: ubicacion.lng });
    return this.vista(await this.tiendas.save(t));
  }

  // ───────── horario y pausa

  private async turnos(tiendaId: string) {
    return (await this.horarios.find({ where: { tiendaId }, order: { dia: 'ASC', abre: 'ASC' } })).map(vistaTurno);
  }

  async horario(usuarioId: string, tiendaId?: string) {
    const t = await this.deUsuario(usuarioId, tiendaId);
    return { usarHorario: t.usarHorario, turnos: await this.turnos(t.id), abiertaAhora: (await this.abiertasAhora([t.id])).get(t.id) };
  }

  /** Reemplaza el horario completo. Con usarHorario = true, fuera de los turnos la tienda no recibe pedidos. */
  async guardarHorario(usuarioId: string, dto: HorarioDto, tiendaId?: string) {
    const t = await this.deUsuario(usuarioId, tiendaId);
    dto.turnos.forEach((x, i) => {
      if (x.abre === x.cierra) throw invalido('Un turno no puede abrir y cerrar a la misma hora', `turnos.${i}.cierra`);
    });
    if (dto.usarHorario && !dto.turnos.length) throw invalido('Agrega al menos un turno para usar el horario', 'turnos');
    await this.ds.transaction(async (m) => {
      await m.delete(HorarioTienda, { tiendaId: t.id });
      if (dto.turnos.length) await m.insert(HorarioTienda, dto.turnos.map((x) => ({ tiendaId: t.id, dia: x.dia, abre: x.abre, cierra: x.cierra })));
      await m.update(Tienda, t.id, { usarHorario: dto.usarHorario });
    });
    return this.horario(usuarioId, t.id);
  }

  async pausar(usuarioId: string, minutos: number, tiendaId?: string) {
    const t = await this.deUsuario(usuarioId, tiendaId);
    t.pausadaHasta = new Date(Date.now() + minutos * 60000);
    return this.vista(await this.tiendas.save(t));
  }

  async quitarPausa(usuarioId: string, tiendaId?: string) {
    const t = await this.deUsuario(usuarioId, tiendaId);
    t.pausadaHasta = null;
    return this.vista(await this.tiendas.save(t));
  }

  // ───────── reporte de ventas

  /**
   * Ventas de la sucursal por fecha de creación del pedido (hora de Celaya).
   * ventas = lo que la tienda cobró al repartidor en pedidos entregados (productos menos sus cupones); el envío no cuenta.
   * ventasNetas = ventas − comisión de PaPedir.
   */
  async reporte(usuarioId: string, q: RangoFechasDto, tiendaId?: string) {
    const t = await this.deUsuario(usuarioId, tiendaId);
    const { desde, hasta } = rangoFechas(q);
    const base = `FROM pedidos p WHERE p.tienda_id = $1
      AND p.creado_en >= ($2::date)::timestamp AT TIME ZONE '${ZONA}'
      AND p.creado_en < ($3::date + 1)::timestamp AT TIME ZONE '${ZONA}'`;
    const params = [t.id, desde, hasta];
    const [resumen] = await this.ds.query(
      `SELECT count(*) FILTER (WHERE estado = 'entregado')::int AS entregados,
              count(*) FILTER (WHERE estado = 'cancelado')::int AS cancelados,
              count(*) FILTER (WHERE estado = 'rechazado')::int AS rechazados,
              count(*) FILTER (WHERE estado NOT IN ('entregado','cancelado','rechazado'))::int AS en_curso,
              coalesce(sum(monto_tienda) FILTER (WHERE estado = 'entregado'), 0)::float8 AS ventas,
              coalesce(sum(comision_tienda) FILTER (WHERE estado = 'entregado'), 0)::float8 AS comisiones,
              coalesce(sum(descuento) FILTER (WHERE estado = 'entregado' AND descuento_absorbe = 'tienda'), 0)::float8 AS descuentos,
              count(*) FILTER (WHERE estado = 'entregado' AND origen = 'manual')::int AS manuales
       ${base}`,
      params,
    );
    const porDia = await this.ds.query(
      `SELECT to_char((creado_en AT TIME ZONE '${ZONA}')::date, 'YYYY-MM-DD') AS fecha, count(*)::int AS pedidos,
              sum(monto_tienda)::float8 AS ventas
       ${base} AND estado = 'entregado' GROUP BY 1 ORDER BY 1`,
      params,
    );
    const porHora = await this.ds.query(
      `SELECT extract(hour FROM creado_en AT TIME ZONE '${ZONA}')::int AS hora, count(*)::int AS pedidos
       ${base} AND estado = 'entregado' GROUP BY 1 ORDER BY 1`,
      params,
    );
    const productos = await this.ds.query(
      `SELECT i.producto_id AS "productoId", max(i.nombre) AS nombre, sum(i.cantidad)::int AS cantidad,
              sum(i.cantidad * i.precio_unitario)::float8 AS importe
       FROM pedido_items i JOIN pedidos p ON p.id = i.pedido_id
       WHERE p.id IN (SELECT p.id ${base} AND estado = 'entregado')
       GROUP BY i.producto_id ORDER BY cantidad DESC, importe DESC LIMIT 10`,
      params,
    );
    const [calif] = await this.ds.query(
      `SELECT round(avg(c.tienda), 2)::float8 AS promedio, count(*)::int AS total
       FROM calificaciones c JOIN pedidos p ON p.id = c.pedido_id WHERE p.id IN (SELECT p.id ${base})`,
      params,
    );
    return {
      tiendaId: t.id,
      desde,
      hasta,
      resumen: {
        pedidosEntregados: resumen.entregados,
        pedidosManuales: resumen.manuales,
        cancelados: resumen.cancelados,
        rechazados: resumen.rechazados,
        enCurso: resumen.en_curso,
        ventas: redondear(resumen.ventas),
        descuentosCupones: redondear(resumen.descuentos),
        comisionPlataforma: redondear(resumen.comisiones),
        ventasNetas: redondear(resumen.ventas - resumen.comisiones),
        ticketPromedio: resumen.entregados ? redondear(resumen.ventas / resumen.entregados) : 0,
        calificacionPromedio: calif.promedio,
        calificaciones: calif.total,
      },
      porDia: porDia.map((d) => ({ fecha: d.fecha, pedidos: d.pedidos, ventas: redondear(d.ventas) })),
      porHora,
      productosMasVendidos: productos.map((x) => ({ ...x, importe: redondear(x.importe) })),
    };
  }

  // ───────── categorías y productos (rol tienda)

  async misCategorias(usuarioId: string, tiendaId?: string) {
    const t = await this.deUsuario(usuarioId, tiendaId);
    return (await this.categorias.find({ where: { tiendaId: t.id }, order: { orden: 'ASC', nombre: 'ASC' } })).map(vistaCategoria);
  }

  async crearCategoria(usuarioId: string, dto: CategoriaDto, tiendaId?: string) {
    const t = await this.deUsuario(usuarioId, tiendaId);
    return vistaCategoria(await this.categorias.save(this.categorias.create({ tiendaId: t.id, nombre: dto.nombre.trim(), orden: dto.orden ?? 0 })));
  }

  /** Categoría de cualquier sucursal del usuario (el id ya dice de cuál es). */
  private async categoriaPropia(id: string, usuarioId: string) {
    const c = await this.categorias
      .createQueryBuilder('c')
      .innerJoin(Tienda, 't', 't.id = c.tiendaId')
      .where('c.id = :id AND t.ownerId = :usuarioId', { id, usuarioId })
      .getOne();
    if (!c) throw noEncontrado('Categoría no encontrada');
    return c;
  }

  async actualizarCategoria(id: string, usuarioId: string, dto: CategoriaUpdateDto) {
    const c = await this.categoriaPropia(id, usuarioId);
    if (dto.nombre !== undefined) c.nombre = dto.nombre.trim();
    if (dto.orden !== undefined) c.orden = dto.orden;
    return vistaCategoria(await this.categorias.save(c));
  }

  async eliminarCategoria(id: string, usuarioId: string) {
    const c = await this.categoriaPropia(id, usuarioId);
    if (await this.productos.existsBy({ categoriaId: c.id, eliminado: false })) {
      throw conflicto('CATEGORIA_CON_PRODUCTOS', 'Mueve o elimina los productos de la categoría antes de borrarla');
    }
    await this.categorias.remove(c);
  }

  async misProductos(usuarioId: string, tiendaId?: string) {
    const t = await this.deUsuario(usuarioId, tiendaId);
    const prods = await this.productos.find({ where: { tiendaId: t.id, eliminado: false }, order: { nombre: 'ASC' } });
    const grupos = await this.gruposDe(prods.map((x) => x.id));
    return prods.map((x) => vistaProducto(x, grupos.get(x.id)));
  }

  /** imagenUrl e imagenes se mantienen sincronizados: la principal es la primera de la lista. */
  private fotos(dto: { imagenUrl?: string | null; imagenes?: string[] }) {
    if (dto.imagenes !== undefined) return { imagenes: dto.imagenes, imagenUrl: dto.imagenes[0] ?? null };
    if (dto.imagenUrl !== undefined) return { imagenes: dto.imagenUrl ? [dto.imagenUrl] : [], imagenUrl: dto.imagenUrl ?? null };
    return {};
  }

  async crearProducto(usuarioId: string, dto: ProductoDto) {
    const c = await this.categoriaPropia(dto.categoriaId, usuarioId).catch(() => {
      throw invalido('La categoría no existe en tu tienda', 'categoriaId');
    });
    const { imagenes, imagenUrl, ...resto } = dto;
    const p = await this.productos.save(
      this.productos.create({ ...resto, stock: dto.stock ?? null, imagenes: [], tiendaId: c.tiendaId, ...this.fotos({ imagenes, imagenUrl }) }),
    );
    return vistaProducto(p);
  }

  private async productoPropio(id: string, usuarioId: string) {
    const p = await this.productos
      .createQueryBuilder('p')
      .innerJoin(Tienda, 't', 't.id = p.tiendaId')
      .where('p.id = :id AND NOT p.eliminado AND t.ownerId = :usuarioId', { id, usuarioId })
      .getOne();
    if (!p) throw noEncontrado('Producto no encontrado');
    return p;
  }

  async actualizarProducto(id: string, usuarioId: string, dto: ProductoUpdateDto) {
    const p = await this.productoPropio(id, usuarioId);
    if (dto.categoriaId && dto.categoriaId !== p.categoriaId) {
      const c = await this.categoriaPropia(dto.categoriaId, usuarioId).catch(() => null);
      if (!c || c.tiendaId !== p.tiendaId) throw invalido('La categoría no existe en la sucursal del producto', 'categoriaId');
    }
    const { imagenes, imagenUrl, ...resto } = dto;
    Object.assign(p, resto, this.fotos({ imagenes, imagenUrl }));
    await this.productos.save(p);
    return vistaProducto(p, (await this.gruposDe([p.id])).get(p.id));
  }

  async eliminarProducto(id: string, usuarioId: string) {
    const p = await this.productoPropio(id, usuarioId);
    await this.productos.update(p.id, { eliminado: true, disponible: false });
  }

  /**
   * Reemplaza todas las opciones del producto (tamaños, extras, salsas...).
   * Las opciones nuevas reciben ids nuevos; los pedidos anteriores guardan su propia copia.
   */
  async guardarOpciones(id: string, usuarioId: string, dto: OpcionesProductoDto) {
    const p = await this.productoPropio(id, usuarioId);
    dto.grupos.forEach((g, i) => {
      if (g.minimo > g.maximo) throw invalido('minimo no puede ser mayor que maximo', `grupos.${i}.minimo`);
      if (g.maximo > g.opciones.length) throw invalido('maximo no puede ser mayor que el número de opciones', `grupos.${i}.maximo`);
    });
    await this.ds.transaction(async (m) => {
      await m.delete(GrupoOpciones, { productoId: p.id });
      for (const [i, g] of dto.grupos.entries()) {
        const grupo = await m.save(m.create(GrupoOpciones, { productoId: p.id, nombre: g.nombre.trim(), minimo: g.minimo, maximo: g.maximo, orden: i }));
        await m.insert(
          Opcion,
          g.opciones.map((o, j) => ({ grupoId: grupo.id, nombre: o.nombre.trim(), precioExtra: o.precioExtra ?? 0, disponible: o.disponible ?? true, orden: j })),
        );
      }
    });
    return vistaProducto(p, (await this.gruposDe([p.id])).get(p.id));
  }
}
