import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { pagina } from '../common/dtos';
import { conflicto, invalido, noEncontrado } from '../common/errores';
import { redondear } from '../common/util';
import { CategoriaProducto, Producto, Tienda, Usuario } from '../database/entities';
import { BuscarTiendasDto, CategoriaDto, CategoriaUpdateDto, ProductoDto, ProductoUpdateDto, TiendaUpdateDto } from './tiendas.dto';

export const vistaTienda = (t: Tienda, distanciaKm: number | null = null) => ({
  id: t.id,
  nombre: t.nombre,
  categoria: t.categoria,
  descripcion: t.descripcion,
  imagenUrl: t.imagenUrl,
  telefono: t.telefono,
  direccion: t.direccion,
  ubicacion: { lat: t.lat, lng: t.lng },
  abierta: t.abierta,
  tiempoPreparacionMin: t.tiempoPreparacionMin,
  calificacion: t.calificacion,
  distanciaKm,
});

export const vistaCategoria = (c: CategoriaProducto) => ({ id: c.id, nombre: c.nombre, orden: c.orden });

export const vistaProducto = (p: Producto) => ({
  id: p.id,
  tiendaId: p.tiendaId,
  categoriaId: p.categoriaId,
  nombre: p.nombre,
  descripcion: p.descripcion,
  precio: p.precio,
  imagenUrl: p.imagenUrl,
  disponible: p.disponible,
});

@Injectable()
export class TiendasService {
  constructor(
    private readonly ds: DataSource,
    @InjectRepository(Tienda) private readonly tiendas: Repository<Tienda>,
    @InjectRepository(CategoriaProducto) private readonly categorias: Repository<CategoriaProducto>,
    @InjectRepository(Producto) private readonly productos: Repository<Producto>,
  ) {}

  // ───────── consulta (cliente)

  /** Tiendas abiertas y aprobadas; con lat/lng filtra por radio y ordena por cercanía (PostGIS). */
  async buscar(q: BuscarTiendasDto) {
    if ((q.lat == null) !== (q.lng == null)) throw invalido('lat y lng deben enviarse juntos', 'lat');
    const conUbicacion = q.lat != null;
    const params: any[] = [];
    const p = (v: any) => (params.push(v), `$${params.length}`);

    const punto = conUbicacion ? `ST_SetSRID(ST_MakePoint(${p(q.lng)}, ${p(q.lat)}), 4326)::geography` : null;
    const filtros = [`t.abierta`, `u.estado = 'activo'`];
    if (conUbicacion) filtros.push(`ST_DWithin(t.ubicacion, ${punto}, ${p(q.radioKm * 1000)})`);
    if (q.q?.trim()) filtros.push(`t.nombre ILIKE ${p(`%${q.q.trim()}%`)}`);
    if (q.categoria) filtros.push(`t.categoria = ${p(q.categoria)}`);

    const desde = `FROM tiendas t JOIN usuarios u ON u.id = t.owner_id WHERE ${filtros.join(' AND ')}`;
    const [{ total }] = await this.ds.query(`SELECT count(*)::int AS total ${desde}`, params);
    const filas = await this.ds.query(
      `SELECT t.id, ${conUbicacion ? `ST_Distance(t.ubicacion, ${punto})` : 'NULL'} AS metros ${desde}
       ORDER BY metros NULLS LAST, t.nombre LIMIT ${p(q.limit)} OFFSET ${p((q.page - 1) * q.limit)}`,
      params,
    );
    const porId = new Map((await this.tiendas.findBy({ id: In(filas.map((f) => f.id)) })).map((t) => [t.id, t]));
    const data = filas.map((f) => vistaTienda(porId.get(f.id), f.metros == null ? null : redondear(f.metros / 1000)));
    return pagina(data, total, q);
  }

  async porId(id: string) {
    const t = await this.tiendas.findOneBy({ id });
    if (!t) throw noEncontrado('Tienda no encontrada');
    return t;
  }

  /** Menú para el cliente: categorías en orden, cada una con sus productos (los agotados incluidos). */
  async menu(tiendaId: string) {
    await this.porId(tiendaId);
    const [cats, prods] = await Promise.all([
      this.categorias.find({ where: { tiendaId }, order: { orden: 'ASC', nombre: 'ASC' } }),
      this.productos.find({ where: { tiendaId, eliminado: false }, order: { nombre: 'ASC' } }),
    ]);
    return cats
      .map((c) => ({ categoria: vistaCategoria(c), productos: prods.filter((x) => x.categoriaId === c.id).map(vistaProducto) }))
      .filter((g) => g.productos.length);
  }

  // ───────── gestión (rol tienda)

  async deUsuario(usuarioId: string) {
    const t = await this.tiendas.findOneBy({ ownerId: usuarioId });
    if (!t) throw noEncontrado('Esta cuenta no tiene una tienda');
    return t;
  }

  async actualizarMia(usuario: Usuario, dto: TiendaUpdateDto) {
    const t = await this.deUsuario(usuario.id);
    if (dto.abierta && usuario.estado !== 'activo') {
      throw conflicto('CUENTA_PENDIENTE', 'Tu tienda está en revisión; podrás abrir cuando soporte la apruebe');
    }
    const { ubicacion, ...resto } = dto;
    Object.assign(t, resto);
    if (ubicacion) Object.assign(t, { lat: ubicacion.lat, lng: ubicacion.lng });
    return vistaTienda(await this.tiendas.save(t));
  }

  async misCategorias(usuarioId: string) {
    const t = await this.deUsuario(usuarioId);
    return (await this.categorias.find({ where: { tiendaId: t.id }, order: { orden: 'ASC', nombre: 'ASC' } })).map(vistaCategoria);
  }

  async crearCategoria(usuarioId: string, dto: CategoriaDto) {
    const t = await this.deUsuario(usuarioId);
    return vistaCategoria(await this.categorias.save(this.categorias.create({ tiendaId: t.id, nombre: dto.nombre.trim(), orden: dto.orden ?? 0 })));
  }

  private async categoriaPropia(id: string, usuarioId: string) {
    const t = await this.deUsuario(usuarioId);
    const c = await this.categorias.findOneBy({ id, tiendaId: t.id });
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

  async misProductos(usuarioId: string) {
    const t = await this.deUsuario(usuarioId);
    return (await this.productos.find({ where: { tiendaId: t.id, eliminado: false }, order: { nombre: 'ASC' } })).map(vistaProducto);
  }

  async crearProducto(usuarioId: string, dto: ProductoDto) {
    const c = await this.categoriaPropia(dto.categoriaId, usuarioId).catch(() => {
      throw invalido('La categoría no existe en tu tienda', 'categoriaId');
    });
    return vistaProducto(await this.productos.save(this.productos.create({ ...dto, tiendaId: c.tiendaId })));
  }

  private async productoPropio(id: string, usuarioId: string) {
    const t = await this.deUsuario(usuarioId);
    const p = await this.productos.findOneBy({ id, tiendaId: t.id, eliminado: false });
    if (!p) throw noEncontrado('Producto no encontrado');
    return p;
  }

  async actualizarProducto(id: string, usuarioId: string, dto: ProductoUpdateDto) {
    const p = await this.productoPropio(id, usuarioId);
    if (dto.categoriaId && dto.categoriaId !== p.categoriaId) {
      await this.categoriaPropia(dto.categoriaId, usuarioId).catch(() => {
        throw invalido('La categoría no existe en tu tienda', 'categoriaId');
      });
    }
    Object.assign(p, dto);
    return vistaProducto(await this.productos.save(p));
  }

  async eliminarProducto(id: string, usuarioId: string) {
    const p = await this.productoPropio(id, usuarioId);
    await this.productos.update(p.id, { eliminado: true, disponible: false });
  }
}
