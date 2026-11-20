import { Controller, Delete, Get, HttpCode, Injectable, Module, Param, Post, Put, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { Actor, Publico, Roles } from '../common/auth';
import { pagina, PaginaDto } from '../common/dtos';
import { invalido, noEncontrado } from '../common/errores';
import { redondear, UuidPipe } from '../common/util';
import { MOTIVOS } from '../config/reglas';
import { Favorito, Notificacion, Producto, Tienda, Usuario } from '../database/entities';
import { TiendasModule } from '../tiendas/tiendas.module';
import { TiendasService, vistaProducto, vistaTienda } from '../tiendas/tiendas.service';

export class BuscarProductosDto extends PaginaDto {
  @IsString() @MinLength(2) @MaxLength(60) q: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-90) @Max(90) lat?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-180) @Max(180) lng?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.1) @Max(50) radioKm: number = 8;
}

export class ListarNotificacionesDto extends PaginaDto {
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() soloNoLeidas?: boolean;
}

@Injectable()
export class ClienteService {
  constructor(
    private readonly ds: DataSource,
    private readonly tiendasSvc: TiendasService,
    @InjectRepository(Favorito) private readonly favoritos: Repository<Favorito>,
    @InjectRepository(Tienda) private readonly tiendas: Repository<Tienda>,
    @InjectRepository(Producto) private readonly productos: Repository<Producto>,
    @InjectRepository(Notificacion) private readonly notificaciones: Repository<Notificacion>,
  ) {}

  // ───────── favoritos

  async misFavoritos(cliente: Usuario) {
    const favs = await this.favoritos.find({ where: { clienteId: cliente.id }, order: { creadoEn: 'DESC' } });
    const ts = await this.tiendas.findBy({ id: In(favs.map((f) => f.tiendaId)), eliminadaEn: IsNull() });
    const abiertas = await this.tiendasSvc.abiertasAhora(ts.map((t) => t.id));
    return favs.map((f) => ts.find((t) => t.id === f.tiendaId)).filter(Boolean).map((t) => vistaTienda(t, null, abiertas.get(t.id)));
  }

  async agregarFavorito(cliente: Usuario, tiendaId: string) {
    await this.tiendasSvc.porId(tiendaId);
    await this.favoritos.upsert({ clienteId: cliente.id, tiendaId }, ['clienteId', 'tiendaId']);
  }

  async quitarFavorito(cliente: Usuario, tiendaId: string) {
    await this.favoritos.delete({ clienteId: cliente.id, tiendaId });
  }

  // ───────── búsqueda de productos

  /** Productos por nombre o descripción en tiendas que reciben pedidos ahora; con lat/lng, las más cercanas primero. */
  async buscarProductos(q: BuscarProductosDto) {
    if ((q.lat == null) !== (q.lng == null)) throw invalido('lat y lng deben enviarse juntos', 'lat');
    const conUbicacion = q.lat != null;
    const params: any[] = [`%${q.q.trim().replace(/[%_]/g, '')}%`];
    const p = (v: any) => (params.push(v), `$${params.length}`);
    const punto = conUbicacion ? `ST_SetSRID(ST_MakePoint(${p(q.lng)}, ${p(q.lat)}), 4326)::geography` : null;
    const filtros = [
      `NOT pr.eliminado`, `(pr.nombre ILIKE $1 OR pr.descripcion ILIKE $1)`, `tienda_abierta_ahora(t.id)`, `u.estado = 'activo'`,
    ];
    if (conUbicacion) filtros.push(`ST_DWithin(t.ubicacion, ${punto}, ${p(q.radioKm * 1000)})`);
    const desde = `FROM productos pr JOIN tiendas t ON t.id = pr.tienda_id JOIN usuarios u ON u.id = t.owner_id WHERE ${filtros.join(' AND ')}`;
    const [{ total }] = await this.ds.query(`SELECT count(*)::int AS total ${desde}`, params);
    const filas = await this.ds.query(
      `SELECT pr.id, ${conUbicacion ? `ST_Distance(t.ubicacion, ${punto})` : 'NULL'} AS metros ${desde}
       ORDER BY metros NULLS LAST, (pr.nombre ILIKE $1) DESC, pr.nombre LIMIT ${p(q.limit)} OFFSET ${p((q.page - 1) * q.limit)}`,
      params,
    );
    const prods = await this.productos.findBy({ id: In(filas.map((f) => f.id)) });
    const ts = await this.tiendas.findBy({ id: In(prods.map((x) => x.tiendaId)) });
    const grupos = await this.tiendasSvc.gruposDe(prods.map((x) => x.id));
    const data = filas.map((f) => {
      const pr = prods.find((x) => x.id === f.id);
      const t = ts.find((x) => x.id === pr.tiendaId);
      return {
        producto: vistaProducto(pr, grupos.get(pr.id)),
        tienda: { id: t.id, nombre: t.nombre, imagenUrl: t.imagenUrl, distanciaKm: f.metros == null ? null : redondear(f.metros / 1000) },
      };
    });
    return pagina(data, total, q);
  }

  // ───────── bandeja de notificaciones

  async notificacionesDe(u: Usuario, q: ListarNotificacionesDto) {
    const where = { usuarioId: u.id, ...(q.soloNoLeidas ? { leidaEn: IsNull() } : {}) };
    const [filas, total] = await this.notificaciones.findAndCount({ where, order: { creadoEn: 'DESC' }, skip: (q.page - 1) * q.limit, take: q.limit });
    const noLeidas = await this.notificaciones.countBy({ usuarioId: u.id, leidaEn: IsNull() });
    const data = filas.map((n) => ({ id: n.id, titulo: n.titulo, cuerpo: n.cuerpo, datos: n.datos, leida: !!n.leidaEn, creadoEn: n.creadoEn }));
    return { ...pagina(data, total, q), noLeidas };
  }

  async marcarLeida(u: Usuario, id: string) {
    const r = await this.notificaciones.update({ id, usuarioId: u.id, leidaEn: IsNull() }, { leidaEn: new Date() });
    if (!r.affected && !(await this.notificaciones.existsBy({ id, usuarioId: u.id }))) throw noEncontrado('Notificación no encontrada');
  }

  async marcarTodas(u: Usuario) {
    await this.notificaciones.update({ usuarioId: u.id, leidaEn: IsNull() }, { leidaEn: new Date() });
  }
}

const motivos = (lista: readonly (readonly [string, string])[]) => lista.map(([codigo, texto]) => ({ codigo, texto }));

@Controller()
export class ClienteController {
  constructor(private readonly svc: ClienteService) {}

  @Roles('cliente') @Get('favoritos')
  favoritos(@Actor() u: Usuario) { return this.svc.misFavoritos(u); }

  @Roles('cliente') @Put('favoritos/:tiendaId') @HttpCode(204)
  agregar(@Actor() u: Usuario, @Param('tiendaId', UuidPipe) id: string) { return this.svc.agregarFavorito(u, id); }

  @Roles('cliente') @Delete('favoritos/:tiendaId') @HttpCode(204)
  quitar(@Actor() u: Usuario, @Param('tiendaId', UuidPipe) id: string) { return this.svc.quitarFavorito(u, id); }

  @Get('productos/buscar')
  buscar(@Query() q: BuscarProductosDto) { return this.svc.buscarProductos(q); }

  @Get('notificaciones')
  notificaciones(@Actor() u: Usuario, @Query() q: ListarNotificacionesDto) { return this.svc.notificacionesDe(u, q); }

  @Post('notificaciones/leer-todas') @HttpCode(204)
  leerTodas(@Actor() u: Usuario) { return this.svc.marcarTodas(u); }

  @Post('notificaciones/:id/leer') @HttpCode(204)
  leer(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.marcarLeida(u, id); }

  /** Motivos para cancelar o rechazar, por rol. Las apps los muestran como opciones. */
  @Publico() @Get('catalogos/motivos-cancelacion')
  motivos() {
    return { cliente: motivos(MOTIVOS.cliente), tienda: motivos(MOTIVOS.tienda), soporte: motivos(MOTIVOS.soporte) };
  }
}

@Module({ imports: [TiendasModule], controllers: [ClienteController], providers: [ClienteService] })
export class ClienteModule {}
