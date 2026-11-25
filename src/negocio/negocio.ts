import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Actor, Roles, TiendaSel } from '../common/auth';
import { pagina, PaginaDto, RangoFechasDto, rangoFechas } from '../common/dtos';
import { conflicto, invalido, noEncontrado } from '../common/errores';
import { redondear, UuidPipe } from '../common/util';
import { REGLAS } from '../config/reglas';
import { textoMotivo } from '../config/catalogos';
import { CuponesService, vistaCupon } from '../cupones/cupones.service';
import { Cupon, Liquidacion, Movimiento, Tienda, Usuario, Zona } from '../database/entities';
import { FinanzasService } from '../finanzas/finanzas.service';
import { ConfiguracionService } from '../nucleo/configuracion.service';
import { PushService } from '../nucleo/push.service';
import { TiendasModule } from '../tiendas/tiendas.module';
import { TiendasService } from '../tiendas/tiendas.service';
import {
  CarteraConfigDto, ComisionesDto, ComisionTiendaDto, CuponDto, CuponUpdateDto, LiquidacionDto, ListarLiquidacionesDto, RecargosDto, SaldosDto, ZonaDto,
  ZonaUpdateDto,
} from './negocio.dto';

const ZONA = REGLAS.tienda.zonaHoraria;

@Injectable()
export class NegocioService {
  constructor(
    private readonly ds: DataSource,
    private readonly config: ConfiguracionService,
    private readonly finanzas: FinanzasService,
    private readonly tiendasSvc: TiendasService,
    private readonly push: PushService,
    @InjectRepository(Zona) private readonly zonas: Repository<Zona>,
    @InjectRepository(Cupon) private readonly cupones: Repository<Cupon>,
    @InjectRepository(Liquidacion) private readonly liquidaciones: Repository<Liquidacion>,
    @InjectRepository(Usuario) private readonly usuarios: Repository<Usuario>,
    @InjectRepository(Tienda) private readonly tiendas: Repository<Tienda>,
  ) {}

  // ───────── zonas de cobertura

  async listarZonas(soloActivas = false) {
    const filas = await this.ds.query(
      `SELECT id, nombre, activa, recargo::float8 AS recargo, ST_AsGeoJSON(poligono)::json AS geo, creado_en AS "creadoEn"
       FROM zonas ${soloActivas ? 'WHERE activa' : ''} ORDER BY nombre`,
    );
    return filas.map(({ geo, ...z }) => ({
      ...z,
      // GeoJSON viene [lng, lat] y cierra el anillo repitiendo el primer punto.
      puntos: geo.coordinates[0].slice(0, -1).map(([lng, lat]: number[]) => ({ lat, lng })),
    }));
  }

  private wkt(puntos: { lat: number; lng: number }[]) {
    const anillo = [...puntos, puntos[0]].map((p) => `${p.lng} ${p.lat}`).join(', ');
    return `SRID=4326;POLYGON((${anillo}))`;
  }

  private async validarPoligono(puntos: { lat: number; lng: number }[]) {
    const [{ valido }] = await this.ds.query(`SELECT ST_IsValid(ST_GeomFromEWKT($1)) AS valido`, [this.wkt(puntos)]);
    if (!valido) throw invalido('El polígono no es válido: revisa que sus lados no se crucen', 'puntos');
  }

  async crearZona(dto: ZonaDto) {
    await this.validarPoligono(dto.puntos);
    const [{ id }] = await this.ds.query(
      `INSERT INTO zonas (nombre, activa, recargo, poligono) VALUES ($1, $2, $3, ST_GeomFromEWKT($4)::geography) RETURNING id`,
      [dto.nombre.trim(), dto.activa ?? true, dto.recargo ?? 0, this.wkt(dto.puntos)],
    );
    return (await this.listarZonas()).find((z) => z.id === id);
  }

  async actualizarZona(id: string, dto: ZonaUpdateDto) {
    const z = await this.zonas.findOneBy({ id });
    if (!z) throw noEncontrado('Zona no encontrada');
    if (dto.puntos) {
      await this.validarPoligono(dto.puntos);
      await this.ds.query(`UPDATE zonas SET poligono = ST_GeomFromEWKT($2)::geography WHERE id = $1`, [id, this.wkt(dto.puntos)]);
    }
    const { puntos, ...resto } = dto;
    if (Object.keys(resto).length) await this.zonas.update(id, resto);
    return (await this.listarZonas()).find((x) => x.id === id);
  }

  async eliminarZona(id: string) {
    const r = await this.zonas.delete(id);
    if (!r.affected) throw noEncontrado('Zona no encontrada');
  }

  // ───────── configuración (comisiones y tarifas dinámicas)

  configuracion() {
    return this.config.todo();
  }

  guardarComisiones(admin: Usuario, dto: ComisionesDto) {
    return this.config.guardar('comisiones', { tiendaPct: dto.tiendaPct, envioPct: dto.envioPct }, admin.id);
  }

  async guardarCartera(admin: Usuario, dto: CarteraConfigDto) {
    // Los campos que no manda (versiones anteriores del panel) conservan su valor actual.
    const actual = await this.config.get('cartera');
    return this.config.guardar('cartera', { ...actual, ...dto }, admin.id);
  }

  guardarRecargos(admin: Usuario, dto: RecargosDto) {
    return this.config.guardar('recargos', JSON.parse(JSON.stringify(dto)), admin.id);
  }

  async comisionTienda(id: string, dto: ComisionTiendaDto) {
    const t = await this.tiendasSvc.porId(id);
    t.comisionPct = dto.comisionPct ?? null;
    await this.tiendas.save(t);
    return { tiendaId: t.id, comisionPct: t.comisionPct, general: (await this.config.get('comisiones')).tiendaPct };
  }

  // ───────── cupones

  private async conUsos(lista: Cupon[]) {
    if (!lista.length) return [];
    const usos = await this.ds.query(
      `SELECT cupon_id, count(*)::int AS n FROM pedidos WHERE cupon_id = ANY($1::uuid[]) AND estado NOT IN ('cancelado','rechazado') GROUP BY 1`,
      [lista.map((c) => c.id)],
    );
    return lista.map((c) => ({ ...vistaCupon(c), usos: usos.find((u) => u.cupon_id === c.id)?.n ?? 0 }));
  }

  async listarCupones(tiendaId?: string | null) {
    const where = tiendaId === undefined ? {} : { tiendaId };
    return this.conUsos(await this.cupones.find({ where, order: { creadoEn: 'DESC' } }));
  }

  /** Admin crea cupones de la plataforma o de una tienda; una tienda solo los suyos (sin envío gratis). */
  async crearCupon(actor: Usuario, dto: CuponDto, tiendaPropia?: string) {
    const codigo = dto.codigo.toUpperCase();
    if (await this.cupones.existsBy({ codigo })) throw conflicto('CUPON_DUPLICADO', 'Ya existe un cupón con ese código');
    if (tiendaPropia && dto.tipo === 'envio_gratis') throw invalido('El envío gratis solo lo puede dar PaPedir', 'tipo');
    if (dto.tipo === 'porcentaje' && dto.valor > 100) throw invalido('El porcentaje máximo es 100', 'valor');
    if (dto.inicio && dto.fin && new Date(dto.fin) <= new Date(dto.inicio)) throw invalido('fin debe ser posterior a inicio', 'fin');
    const tiendaId = tiendaPropia ?? dto.tiendaId ?? null;
    if (tiendaId) await this.tiendasSvc.porId(tiendaId);
    const c = await this.cupones.save(
      this.cupones.create({
        codigo, descripcion: dto.descripcion ?? null, tipo: dto.tipo, valor: dto.tipo === 'envio_gratis' ? 0 : dto.valor,
        maximoDescuento: dto.maximoDescuento ?? null, minimoCompra: dto.minimoCompra ?? 0, tiendaId,
        inicio: dto.inicio ? new Date(dto.inicio) : null, fin: dto.fin ? new Date(dto.fin) : null,
        usosMaximos: dto.usosMaximos ?? null, usosPorCliente: dto.usosPorCliente ?? 1, soloPrimerPedido: dto.soloPrimerPedido ?? false,
        activo: dto.activo ?? true, creadoPor: actor.id,
      }),
    );
    return (await this.conUsos([c]))[0];
  }

  async actualizarCupon(id: string, dto: CuponUpdateDto, tiendaPropia?: string) {
    const c = await this.cupones.findOneBy({ id, ...(tiendaPropia ? { tiendaId: tiendaPropia } : {}) });
    if (!c) throw noEncontrado('Cupón no encontrado');
    if (dto.descripcion !== undefined) c.descripcion = dto.descripcion;
    if (dto.fin !== undefined) c.fin = dto.fin ? new Date(dto.fin) : null;
    if (dto.usosMaximos !== undefined) c.usosMaximos = dto.usosMaximos;
    if (dto.activo !== undefined) c.activo = dto.activo;
    return (await this.conUsos([await this.cupones.save(c)]))[0];
  }

  async usuario(id: string) {
    const u = await this.usuarios.findOneBy({ id });
    if (!u) throw noEncontrado('Usuario no encontrado');
    return u;
  }

  // ───────── saldos y liquidaciones

  /** Carteras distintas de cero: quién debe a PaPedir (saldo < 0) y a quién le debe PaPedir (saldo > 0). */
  async saldos(q: SaldosDto) {
    const filas = await this.ds.query(
      `SELECT u.id, u.nombre, u.rol, sum(m.monto)::float8 AS saldo, max(m.creado_en) AS "ultimoMovimiento"
       FROM movimientos m JOIN usuarios u ON u.id = m.usuario_id
       WHERE ($1::text IS NULL OR u.rol = $1)
       GROUP BY u.id HAVING sum(m.monto) <> 0 ORDER BY abs(sum(m.monto)) DESC`,
      [q.rol ?? null],
    );
    const totalPorCobrar = redondear(-filas.filter((f) => f.saldo < 0).reduce((s, f) => s + f.saldo, 0));
    const totalPorPagar = redondear(filas.filter((f) => f.saldo > 0).reduce((s, f) => s + f.saldo, 0));
    return { totalPorCobrar, totalPorPagar, usuarios: filas.map((f) => ({ ...f, saldo: redondear(f.saldo) })) };
  }

  async liquidar(admin: Usuario, dto: LiquidacionDto) {
    const u = await this.usuarios.findOneBy({ id: dto.usuarioId });
    if (!u) throw noEncontrado('Usuario no encontrado');
    if (u.rol === 'soporte' || u.rol === 'admin') throw invalido('Las cuentas internas no tienen cartera', 'usuarioId');
    const liq = await this.ds.transaction(async (m) => {
      const l = await m.save(
        m.create(Liquidacion, {
          usuarioId: u.id, sentido: dto.sentido, monto: dto.monto, metodo: dto.metodo,
          referencia: dto.referencia ?? null, nota: dto.nota ?? null, registradoPor: admin.id,
        }),
      );
      await m.insert(Movimiento, {
        usuarioId: u.id, liquidacionId: l.id, tipo: 'liquidacion',
        // Cobro: el usuario pagó lo que debía (su saldo sube). Pago: PaPedir le entregó su saldo a favor (baja).
        monto: dto.sentido === 'cobro' ? dto.monto : -dto.monto,
        descripcion: dto.sentido === 'cobro' ? `Pago recibido (${dto.metodo})` : `Pago de PaPedir (${dto.metodo})`,
      });
      return l;
    });
    const saldo = await this.finanzas.saldo(u.id);
    void this.push.aUsuarios(
      [u.id], dto.sentido === 'cobro' ? 'Registramos tu pago' : 'PaPedir te hizo un pago',
      `$${dto.monto} por ${dto.metodo}. Saldo actual: $${saldo}`,
    );
    return { ...this.vistaLiquidacion(liq), saldo };
  }

  private vistaLiquidacion = (l: Liquidacion) => ({
    id: l.id, usuarioId: l.usuarioId, sentido: l.sentido, monto: l.monto, metodo: l.metodo, referencia: l.referencia, nota: l.nota,
    registradoPor: l.registradoPor, creadoEn: l.creadoEn, anuladaEn: l.anuladaEn, anuladaMotivo: l.anuladaMotivo,
  });

  async listarLiquidaciones(q: ListarLiquidacionesDto) {
    const [filas, total] = await this.liquidaciones.findAndCount({
      where: q.usuarioId ? { usuarioId: q.usuarioId } : {}, order: { creadoEn: 'DESC' }, skip: (q.page - 1) * q.limit, take: q.limit,
    });
    return pagina(filas.map(this.vistaLiquidacion), total, q);
  }

  // ───────── cancelaciones

  /** Por qué se cancelan y rechazan los pedidos (hora de Celaya). */
  async cancelaciones(q: RangoFechasDto) {
    const { desde, hasta } = rangoFechas(q);
    const filas = await this.ds.query(
      `SELECT coalesce(motivo_codigo, 'otro') AS codigo,
              count(*) FILTER (WHERE estado = 'cancelado')::int AS cancelados,
              count(*) FILTER (WHERE estado = 'rechazado')::int AS rechazados
       FROM pedidos
       WHERE estado IN ('cancelado','rechazado')
         AND creado_en >= ($1::date)::timestamp AT TIME ZONE '${ZONA}' AND creado_en < ($2::date + 1)::timestamp AT TIME ZONE '${ZONA}'
       GROUP BY 1 ORDER BY count(*) DESC`,
      [desde, hasta],
    );
    return { desde, hasta, motivos: filas.map((f) => ({ ...f, texto: textoMotivo(f.codigo) })) };
  }
}

@Controller()
export class NegocioController {
  constructor(
    private readonly svc: NegocioService,
    private readonly finanzas: FinanzasService,
    private readonly tiendasSvc: TiendasService,
    private readonly cuponesSvc: CuponesService,
  ) {}

  // Zonas
  @Get('zonas') zonasActivas() { return this.svc.listarZonas(true); }
  @Roles('admin') @Get('admin/zonas') zonas() { return this.svc.listarZonas(); }
  @Roles('admin') @Post('admin/zonas') crearZona(@Body() dto: ZonaDto) { return this.svc.crearZona(dto); }
  @Roles('admin') @Patch('admin/zonas/:id')
  actualizarZona(@Param('id', UuidPipe) id: string, @Body() dto: ZonaUpdateDto) { return this.svc.actualizarZona(id, dto); }
  @Roles('admin') @Delete('admin/zonas/:id') @HttpCode(204)
  eliminarZona(@Param('id', UuidPipe) id: string) { return this.svc.eliminarZona(id); }

  // Configuración
  @Roles('admin') @Get('admin/configuracion') configuracion() { return this.svc.configuracion(); }
  @Roles('admin') @Put('admin/configuracion/comisiones')
  comisiones(@Actor() u: Usuario, @Body() dto: ComisionesDto) { return this.svc.guardarComisiones(u, dto); }
  @Roles('admin') @Put('admin/configuracion/cartera')
  cartera(@Actor() u: Usuario, @Body() dto: CarteraConfigDto) { return this.svc.guardarCartera(u, dto); }
  @Roles('admin') @Put('admin/configuracion/recargos')
  recargos(@Actor() u: Usuario, @Body() dto: RecargosDto) { return this.svc.guardarRecargos(u, dto); }
  @Roles('admin') @Put('admin/tiendas/:id/comision')
  comisionTienda(@Param('id', UuidPipe) id: string, @Body() dto: ComisionTiendaDto) { return this.svc.comisionTienda(id, dto); }

  // Cupones (admin)
  @Roles('admin') @Get('admin/cupones') cupones() { return this.svc.listarCupones(); }
  @Roles('admin') @Post('admin/cupones') crearCupon(@Actor() u: Usuario, @Body() dto: CuponDto) { return this.svc.crearCupon(u, dto); }
  @Roles('admin') @Patch('admin/cupones/:id')
  actualizarCupon(@Param('id', UuidPipe) id: string, @Body() dto: CuponUpdateDto) { return this.svc.actualizarCupon(id, dto); }

  // Cupones (tienda, por sucursal)
  @Roles('tienda') @Get('tiendas/mia/cupones')
  async misCupones(@Actor() u: Usuario, @TiendaSel() t?: string) { return this.svc.listarCupones((await this.tiendasSvc.deUsuario(u.id, t)).id); }
  @Roles('tienda') @Post('tiendas/mia/cupones')
  async crearMiCupon(@Actor() u: Usuario, @Body() dto: CuponDto, @TiendaSel() t?: string) {
    return this.svc.crearCupon(u, dto, (await this.tiendasSvc.deUsuario(u.id, t)).id);
  }
  @Roles('tienda') @Patch('tiendas/mia/cupones/:id')
  async actualizarMiCupon(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: CuponUpdateDto, @TiendaSel() t?: string) {
    return this.svc.actualizarCupon(id, dto, (await this.tiendasSvc.deUsuario(u.id, t)).id);
  }
  /**
   * Cupones vigentes que el cliente puede usar en una tienda (de la tienda y de PaPedir).
   * Va después de las rutas tiendas/mia/cupones: si se declara antes, Express toma "mia" como :id.
   */
  @Get('tiendas/:id/cupones')
  async cuponesDeTienda(@Param('id', UuidPipe) id: string) {
    await this.tiendasSvc.detalle(id);
    return this.cuponesSvc.disponibles(id);
  }

  // Saldos y liquidaciones
  /** Mi cartera (cliente, tienda o repartidor). /saldo se conserva como alias. */
  @Roles('cliente', 'tienda', 'repartidor') @Get(['cartera', 'saldo'])
  saldo(@Actor() u: Usuario, @Query() q: PaginaDto) { return this.finanzas.estadoDeCuenta(u.id, u.rol, q); }
  @Roles('admin') @Get('admin/saldos') saldos(@Query() q: SaldosDto) { return this.svc.saldos(q); }
  @Roles('soporte', 'admin') @Get('admin/usuarios/:id/saldo')
  async saldoDe(@Param('id', UuidPipe) id: string, @Query() q: PaginaDto) {
    const u = await this.svc.usuario(id);
    return this.finanzas.estadoDeCuenta(id, u.rol, q);
  }
  @Roles('admin') @Get('admin/liquidaciones') liquidaciones(@Query() q: ListarLiquidacionesDto) { return this.svc.listarLiquidaciones(q); }
  @Roles('admin') @Post('admin/liquidaciones') liquidar(@Actor() u: Usuario, @Body() dto: LiquidacionDto) { return this.svc.liquidar(u, dto); }

  // Métricas de cancelación
  @Roles('soporte', 'admin') @Get('admin/cancelaciones')
  cancelaciones(@Query() q: RangoFechasDto) { return this.svc.cancelaciones(q); }
}

@Module({ imports: [TiendasModule], controllers: [NegocioController], providers: [NegocioService] })
export class NegocioModule {}
