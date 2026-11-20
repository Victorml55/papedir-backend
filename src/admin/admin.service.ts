import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { DataSource, In, IsNull, Not } from 'typeorm';
import { AuthService, vistaUsuario } from '../auth/auth.service';
import { MetricasDto } from '../soporte/soporte.dto';
import { pagina } from '../common/dtos';
import { conflicto, invalido, noEncontrado, sinPermiso } from '../common/errores';
import { folio } from '../common/util';
import { ESTADOS_CON_REPARTIDOR, ESTADOS_FINALES, REGLAS } from '../config/reglas';
import { AccionInterna, Calificacion, Pedido, RefreshToken, Tienda, Usuario, Viaje } from '../database/entities';
import { BitacoraCuentasService } from '../nucleo/bitacora-cuentas.service';
import { ConfiguracionService } from '../nucleo/configuracion.service';
import { PushService } from '../nucleo/push.service';
import { RealtimeService } from '../nucleo/realtime.service';
import { TiendasService } from '../tiendas/tiendas.service';
import {
  BitacoraDto, EditarUsuarioDto, ListaRepartidoresDto, ListaResenasDto, ListaTiendasDto, ModerarResenaDto, NotificacionDto, PausaTiendaDto,
  CrearTiendaAdminDto,
  EditarTiendaAdminDto,
} from './admin.dto';

/** Inicio del día de hoy en hora de Celaya, como timestamptz. */
const HOY = `(date_trunc('day', now() AT TIME ZONE 'America/Mexico_City') AT TIME ZONE 'America/Mexico_City')`;
/** Un repartidor está conectado si está disponible y mandó su ubicación en los últimos 5 minutos. */
const CONECTADO = `(u.disponible AND u.ubicacion_en > now() - interval '5 minutes')`;
const SI = (v?: string) => (v == null ? null : v === 'si');

@Injectable()
export class AdminService {
  constructor(
    private readonly ds: DataSource,
    private readonly auth: AuthService,
    private readonly tiendasSvc: TiendasService,
    private readonly bitacora: BitacoraCuentasService,
    private readonly config: ConfiguracionService,
    private readonly push: PushService,
    private readonly rt: RealtimeService,
  ) {}

  // ─────────────────────────── tablero de inicio

  async tablero() {
    const [c] = await this.ds.query(`
      SELECT
        (SELECT count(*) FROM pedidos WHERE estado NOT IN ('entregado','cancelado','rechazado','programado'))::int AS "pedidosEnCurso",
        (SELECT count(*) FROM pedidos WHERE estado = 'programado')::int AS "pedidosProgramados",
        (SELECT count(*) FROM pedidos WHERE creado_en >= ${HOY})::int AS "pedidosHoy",
        (SELECT coalesce(sum(total), 0) FROM pedidos WHERE estado = 'entregado' AND entregado_en >= ${HOY})::float8 AS "ventasHoy",
        (SELECT coalesce(sum(total), 0) FROM pedidos WHERE estado = 'entregado'
           AND entregado_en >= ${HOY} - interval '1 day' AND entregado_en < now() - interval '1 day')::float8 AS "ventasAyerMismaHora",
        (SELECT count(*) FROM tickets WHERE estado = 'abierto')::int AS "ticketsSinAtender",
        (SELECT count(*) FROM tickets WHERE estado = 'en_atencion')::int AS "ticketsEnAtencion",
        (SELECT count(*) FROM usuarios WHERE estado = 'pendiente_aprobacion')::int AS "cuentasPorAprobar",
        (SELECT count(*) FROM documentos WHERE estado = 'pendiente')::int AS "documentosPorRevisar",
        (SELECT count(*) FROM usuarios u WHERE u.rol = 'repartidor' AND u.estado = 'activo' AND ${CONECTADO})::int AS "repartidoresConectados",
        (SELECT count(*) FROM tiendas t JOIN usuarios u ON u.id = t.owner_id WHERE u.estado = 'activo' AND tienda_abierta_ahora(t.id))::int AS "tiendasAbiertas"`);

    const porEstado = await this.ds.query(
      `SELECT estado, count(*)::int AS total FROM pedidos WHERE estado NOT IN ('entregado','cancelado','rechazado') GROUP BY estado`,
    );

    // Lo que necesita a alguien ya, de lo más urgente a lo menos.
    const alertas = [
      ...(await this.ds.query(
        `SELECT 'sin_repartidor' AS tipo, id AS "pedidoId", folio_num AS "folioNum", listo_en AS desde
         FROM pedidos WHERE estado = 'listo_para_recoger' AND repartidor_id IS NULL AND listo_en < now() - interval '15 minutes'
         ORDER BY listo_en LIMIT 10`,
      )),
      ...(await this.ds.query(
        `SELECT 'tienda_sin_responder' AS tipo, id AS "pedidoId", folio_num AS "folioNum", coalesce(enviado_a_tienda_en, creado_en) AS desde
         FROM pedidos WHERE estado = 'creado' AND coalesce(enviado_a_tienda_en, creado_en) < now() - interval '3 minutes'
         ORDER BY desde LIMIT 10`,
      )),
      ...(await this.ds.query(
        `SELECT 'reembolso_fallido' AS tipo, id AS "pedidoId", folio_num AS "folioNum", actualizado_en AS desde
         FROM pedidos WHERE pago_estado = 'reembolso_fallido' ORDER BY actualizado_en DESC LIMIT 10`,
      )),
      ...(await this.ds.query(
        `SELECT 'ticket_esperando' AS tipo, id AS "ticketId", folio_num AS "folioNum", creado_en AS desde
         FROM tickets WHERE estado = 'abierto' AND creado_en < now() - interval '30 minutes' ORDER BY creado_en LIMIT 10`,
      )),
    ].map(({ folioNum, ...a }) => ({ ...a, folio: folio(a.tipo === 'ticket_esperando' ? 'T' : 'R', folioNum) }));

    return { ...c, porEstado, alertas };
  }

  // ─────────────────────────── tiendas

  async tiendas(q: ListaTiendasDto) {
    const params: any[] = [];
    const p = (v: any) => (params.push(v), `$${params.length}`);
    const filtros = ['true'];
    if (q.q?.trim()) {
      const t = p(`%${q.q.trim()}%`);
      filtros.push(`(t.nombre ILIKE ${t} OR u.nombre ILIKE ${t} OR u.email ILIKE ${t})`);
    }
    if (q.estado) filtros.push(`u.estado = ${p(q.estado)}`);
    if (q.plan === 'basico') filtros.push(`(t.plan = 'basico' OR t.plan_hasta IS NULL OR t.plan_hasta <= now())`);
    else if (q.plan) filtros.push(`t.plan = ${p(q.plan)} AND t.plan_hasta > now()`);
    if (SI(q.abierta) != null) filtros.push(`${SI(q.abierta) ? '' : 'NOT '}tienda_abierta_ahora(t.id)`);
    filtros.push(SI(q.eliminadas) ? 't.eliminada_en IS NOT NULL' : 't.eliminada_en IS NULL');

    const desde = `FROM tiendas t JOIN usuarios u ON u.id = t.owner_id WHERE ${filtros.join(' AND ')}`;
    const [{ total }] = await this.ds.query(`SELECT count(*)::int AS total ${desde}`, params);
    const filas = await this.ds.query(
      `SELECT t.id, t.nombre, t.categoria, t.imagen_url AS "imagenUrl", t.direccion, t.telefono,
              CASE WHEN t.plan_hasta > now() THEN t.plan ELSE 'basico' END AS plan, t.plan_hasta AS "planHasta",
              t.calificacion::float8 AS calificacion, t.abierta, t.pausada_hasta AS "pausadaHasta", tienda_abierta_ahora(t.id) AS "abiertaAhora",
              t.comision_pct::float8 AS "comisionPct", t.creado_en AS "creadoEn",
              t.eliminada_en AS "eliminadaEn", t.eliminada_motivo AS "eliminadaMotivo",
              json_build_object('id', u.id, 'nombre', u.nombre, 'email', u.email, 'telefono', u.telefono, 'estado', u.estado) AS "dueno",
              (SELECT count(*) FROM pedidos x WHERE x.tienda_id = t.id AND x.estado = 'entregado' AND x.entregado_en >= now() - interval '30 days')::int AS "pedidos30d",
              (SELECT coalesce(sum(x.subtotal), 0) FROM pedidos x WHERE x.tienda_id = t.id AND x.estado = 'entregado' AND x.entregado_en >= now() - interval '30 days')::float8 AS "ventas30d",
              (SELECT count(*) FROM calificaciones c WHERE c.tienda_id = t.id)::int AS "resenas"
       ${desde} ORDER BY t.nombre LIMIT ${p(q.limit)} OFFSET ${p((q.page - 1) * q.limit)}`,
      params,
    );
    return pagina(filas, total, q);
  }

  async tienda(id: string) {
    const t = await this.ds.getRepository(Tienda).findOneBy({ id });
    if (!t) throw noEncontrado('Tienda no encontrada');
    const dueno = await this.ds.getRepository(Usuario).findOneByOrFail({ id: t.ownerId });
    const [base, menu, sucursales, pedidos, resenas, suscripciones, [cifras]] = await Promise.all([
      this.tiendasSvc.detalle(id, true),
      this.tiendasSvc.menu(id, true),
      this.ds.query(`SELECT id, nombre, direccion FROM tiendas WHERE owner_id = $1 AND id <> $2 ORDER BY nombre`, [t.ownerId, id]),
      this.ds.query(
        `SELECT id, folio_num AS "folioNum", estado, total::float8 AS total, metodo_pago AS "metodoPago", destino_nombre AS cliente, creado_en AS "creadoEn"
         FROM pedidos WHERE tienda_id = $1 ORDER BY creado_en DESC LIMIT 10`,
        [id],
      ),
      this.resenas({ tiendaId: id, page: 1, limit: 10 } as ListaResenasDto),
      this.ds.query(
        `SELECT plan, monto::float8 AS monto, inicio, fin, creado_en AS "creadoEn" FROM suscripciones WHERE tienda_id = $1 ORDER BY creado_en DESC LIMIT 6`,
        [id],
      ),
      this.ds.query(
        `SELECT count(*) FILTER (WHERE estado = 'entregado')::int AS entregados,
                count(*) FILTER (WHERE estado = 'rechazado')::int AS rechazados,
                count(*) FILTER (WHERE estado = 'cancelado')::int AS cancelados,
                coalesce(sum(subtotal) FILTER (WHERE estado = 'entregado'), 0)::float8 AS ventas,
                round(avg(extract(epoch FROM (listo_en - creado_en)) / 60) FILTER (WHERE listo_en IS NOT NULL))::int AS "preparacionMin"
         FROM pedidos WHERE tienda_id = $1 AND creado_en >= now() - interval '30 days'`,
        [id],
      ),
    ]);
    const general = (await this.config.todo()).comisiones.tiendaPct;
    return {
      ...base,
      pausadaHasta: t.pausadaHasta && t.pausadaHasta > new Date() ? t.pausadaHasta : null,
      eliminadaEn: t.eliminadaEn,
      eliminadaMotivo: t.eliminadaMotivo,
      tiempoPreparacionMin: t.tiempoPreparacionMin,
      dueno: { ...vistaUsuario(dueno) },
      comision: { propia: t.comisionPct, general, aplicada: t.comisionPct ?? general },
      ultimos30Dias: cifras,
      sucursales,
      menu,
      pedidos: pedidos.map(({ folioNum, ...x }) => ({ ...x, folio: folio('R', folioNum) })),
      resenas: resenas.data,
      suscripciones,
    };
  }

  /** Pausar una tienda: deja de recibir pedidos hasta la hora indicada, sin banear la cuenta. */
  async pausar(actor: Usuario, id: string, dto: PausaTiendaDto) {
    const t = await this.ds.getRepository(Tienda).findOneBy({ id });
    if (!t) throw noEncontrado('Tienda no encontrada');
    const hasta = dto.minutos ? new Date(Date.now() + dto.minutos * 60_000) : null;
    await this.ds.getRepository(Tienda).update(id, { pausadaHasta: hasta });
    await this.bitacora.registrar(t.ownerId, hasta ? 'tienda_pausada' : 'tienda_reanudada', actor, `${t.nombre}: ${dto.motivo}`);
    const hora = hasta?.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
    void this.push.aUsuarios(
      [t.ownerId],
      hasta ? `${t.nombre} quedó en pausa` : `${t.nombre} vuelve a recibir pedidos`,
      hasta ? `Soporte la pausó hasta las ${hora}. Motivo: ${dto.motivo}` : `Soporte quitó la pausa. ${dto.motivo}`,
      { tiendaId: t.id },
    );
    this.rt.emitir([`tienda:${t.id}`], 'tienda:actualizada', { tiendaId: t.id, pausadaHasta: hasta });
    return this.tienda(id);
  }

  /**
   * Alta de una tienda desde el panel. El dueño puede ser una cuenta de tienda existente (otra sucursal)
   * o una cuenta nueva que nace activa y con el correo verificado: el admin ya validó al negocio.
   */
  async crearTienda(actor: Usuario, dto: CrearTiendaAdminDto) {
    if (!dto.duenoId && !dto.dueno) throw invalido('Elige un dueño existente o captura los datos del nuevo', 'duenoId');
    const usuarios = this.ds.getRepository(Usuario);
    const tiendas = this.ds.getRepository(Tienda);
    let dueno: Usuario | null = null;
    if (dto.duenoId) {
      dueno = await usuarios.findOneBy({ id: dto.duenoId });
      if (!dueno || dueno.rol !== 'tienda') throw invalido('El dueño debe ser una cuenta con rol tienda', 'duenoId');
      if (dueno.estado === 'eliminado' || dueno.estado === 'baneado') throw conflicto('DUENO_INACTIVO', `La cuenta de ${dueno.nombre} está ${dueno.estado}`);
      if ((await tiendas.countBy({ ownerId: dueno.id, eliminadaEn: IsNull() })) >= REGLAS.tienda.maxSucursales) {
        throw conflicto('LIMITE_SUCURSALES', `${dueno.nombre} ya tiene ${REGLAS.tienda.maxSucursales} sucursales activas`);
      }
    } else {
      const email = dto.dueno!.email.toLowerCase().trim();
      if (await usuarios.existsBy({ email })) throw conflicto('EMAIL_REGISTRADO', 'Ese correo ya tiene una cuenta; elígela como dueño existente');
    }

    const t = await this.ds.transaction(async (m) => {
      if (!dueno) {
        dueno = await m.save(
          m.create(Usuario, {
            nombre: dto.dueno!.nombre.trim(),
            email: dto.dueno!.email.toLowerCase().trim(),
            telefono: dto.dueno!.telefono,
            rol: 'tienda',
            estado: 'activo',
            emailVerificadoEn: new Date(),
            passwordHash: await bcrypt.hash(dto.dueno!.password, 10),
          }),
        );
        await this.bitacora.registrar(dueno.id, 'registrada', actor, 'Creada desde el panel junto con su tienda', m);
      }
      const nueva = await m.save(
        m.create(Tienda, {
          ownerId: dueno.id, nombre: dto.nombre.trim(), categoria: dto.categoria, descripcion: dto.descripcion ?? null,
          imagenUrl: dto.imagenUrl ?? null, telefono: dto.telefono ?? dueno.telefono ?? null, direccion: dto.direccion.trim(),
          lat: dto.ubicacion.lat, lng: dto.ubicacion.lng, tiempoPreparacionMin: dto.tiempoPreparacionMin ?? 20, abierta: false,
        }),
      );
      await this.bitacora.registrar(dueno.id, 'tienda_creada', actor, nueva.nombre, m);
      return nueva;
    });
    this.rt.unir(t.ownerId, `tienda:${t.id}`);
    return this.tienda(t.id);
  }

  /** Corregir los datos de una tienda (los mismos que edita el dueño en su app). */
  async editarTienda(actor: Usuario, id: string, dto: EditarTiendaAdminDto) {
    const repo = this.ds.getRepository(Tienda);
    const t = await repo.findOneBy({ id });
    if (!t) throw noEncontrado('Tienda no encontrada');
    if (t.eliminadaEn) throw conflicto('TIENDA_ELIMINADA', 'Restaura la tienda antes de editarla');
    const { ubicacion, ...resto } = dto;
    if (resto.nombre) resto.nombre = resto.nombre.trim();
    Object.assign(t, resto);
    if (ubicacion) Object.assign(t, { lat: ubicacion.lat, lng: ubicacion.lng });
    await repo.save(t);
    await this.bitacora.registrar(t.ownerId, 'tienda_editada', actor, `${t.nombre}: ${Object.keys(dto).join(', ')}`);
    this.rt.emitir([`tienda:${t.id}`], 'tienda:actualizada', { tiendaId: t.id });
    return this.tienda(id);
  }

  /**
   * Baja lógica: deja de aparecer a los clientes y de recibir pedidos; su historial, pagos y reseñas se
   * conservan y se puede restaurar. No procede con pedidos en curso.
   */
  async eliminarTienda(actor: Usuario, id: string, motivo: string) {
    const repo = this.ds.getRepository(Tienda);
    const t = await repo.findOneBy({ id });
    if (!t) throw noEncontrado('Tienda no encontrada');
    if (t.eliminadaEn) throw conflicto('TIENDA_ELIMINADA', 'Esa tienda ya está dada de baja');
    const enCurso = await this.ds.getRepository(Pedido).countBy({ tiendaId: id, estado: Not(In(ESTADOS_FINALES)) });
    if (enCurso) throw conflicto('TIENE_PEDIDOS_ACTIVOS', `${t.nombre} tiene ${enCurso} pedido(s) en curso; termínalos o cancélalos primero`);
    await repo.update(id, { eliminadaEn: new Date(), eliminadaMotivo: motivo.trim(), abierta: false, pausadaHasta: null });
    await this.bitacora.registrar(t.ownerId, 'tienda_eliminada', actor, `${t.nombre}: ${motivo}`);
    void this.push.aUsuarios([t.ownerId], `${t.nombre} fue dada de baja`, `Ya no aparece en PaPedir. Motivo: ${motivo}. Si es un error, escribe a soporte.`, { tiendaId: t.id });
    this.rt.emitir([`tienda:${t.id}`], 'tienda:actualizada', { tiendaId: t.id, eliminada: true });
  }

  /** Deshace la baja. La tienda vuelve cerrada: el dueño decide cuándo abrir. */
  async restaurarTienda(actor: Usuario, id: string) {
    const repo = this.ds.getRepository(Tienda);
    const t = await repo.findOneBy({ id });
    if (!t) throw noEncontrado('Tienda no encontrada');
    if (!t.eliminadaEn) throw conflicto('TIENDA_ACTIVA', 'Esa tienda no está dada de baja');
    if ((await repo.countBy({ ownerId: t.ownerId, eliminadaEn: IsNull() })) >= REGLAS.tienda.maxSucursales) {
      throw conflicto('LIMITE_SUCURSALES', `El dueño ya tiene ${REGLAS.tienda.maxSucursales} sucursales activas`);
    }
    await repo.update(id, { eliminadaEn: null, eliminadaMotivo: null });
    await this.bitacora.registrar(t.ownerId, 'tienda_restaurada', actor, t.nombre);
    return this.tienda(id);
  }

  // ─────────────────────────── repartidores

  async repartidores(q: ListaRepartidoresDto) {
    const params: any[] = [];
    const p = (v: any) => (params.push(v), `$${params.length}`);
    const filtros = [`u.rol = 'repartidor'`];
    if (q.q?.trim()) {
      const t = p(`%${q.q.trim()}%`);
      filtros.push(`(u.nombre ILIKE ${t} OR u.email ILIKE ${t} OR u.telefono ILIKE ${t} OR v.placa ILIKE ${t})`);
    }
    if (q.estado) filtros.push(`u.estado = ${p(q.estado)}`);
    if (SI(q.conectado) != null) filtros.push(`${SI(q.conectado) ? '' : 'NOT '}${CONECTADO}`);

    const desde = `FROM usuarios u LEFT JOIN vehiculos v ON v.repartidor_id = u.id WHERE ${filtros.join(' AND ')}`;
    const [{ total }] = await this.ds.query(`SELECT count(*)::int AS total ${desde}`, params);
    const filas = await this.ds.query(
      `SELECT u.id, u.nombre, u.email, u.telefono, u.estado, u.foto_url AS "fotoUrl", u.calificacion::float8 AS calificacion,
              ${CONECTADO} AS conectado, u.disponible, u.ubicacion_en AS "ubicacionEn",
              CASE WHEN u.lat IS NULL THEN NULL ELSE json_build_object('lat', u.lat, 'lng', u.lng) END AS ubicacion,
              CASE WHEN v.repartidor_id IS NULL THEN NULL
                   ELSE json_build_object('tipo', v.tipo, 'marca', v.marca, 'modelo', v.modelo, 'color', v.color, 'placa', v.placa) END AS vehiculo,
              (SELECT count(*) FROM pedidos x WHERE x.repartidor_id = u.id AND x.estado = ANY(${p(ESTADOS_CON_REPARTIDOR)}))::int AS "pedidosEnCurso",
              (SELECT count(*) FROM pedidos x WHERE x.repartidor_id = u.id AND x.estado = 'entregado' AND x.entregado_en >= ${HOY})::int AS "entregasHoy",
              (SELECT count(*) FROM pedidos x WHERE x.repartidor_id = u.id AND x.estado = 'entregado')::int AS "entregasTotales",
              (SELECT coalesce(sum(m.monto), 0) FROM movimientos m WHERE m.usuario_id = u.id)::float8 AS saldo,
              u.creado_en AS "creadoEn"
       ${desde} ORDER BY ${CONECTADO} DESC, u.nombre LIMIT ${p(q.limit)} OFFSET ${p((q.page - 1) * q.limit)}`,
      params,
    );
    return pagina(filas, total, q);
  }

  /** Mapa de despacho: repartidores con ubicación reciente, pedidos activos y tiendas que reciben pedidos. */
  async mapa() {
    const repartidores = await this.ds.query(
      `SELECT u.id, u.nombre, u.lat, u.lng, u.ubicacion_en AS "ubicacionEn", ${CONECTADO} AS conectado,
              (SELECT count(*) FROM pedidos x WHERE x.repartidor_id = u.id AND x.estado = ANY($1))::int AS "pedidosEnCurso"
       FROM usuarios u
       WHERE u.rol = 'repartidor' AND u.estado = 'activo' AND u.lat IS NOT NULL
         AND (${CONECTADO} OR EXISTS (SELECT 1 FROM pedidos x WHERE x.repartidor_id = u.id AND x.estado = ANY($1)))`,
      [ESTADOS_CON_REPARTIDOR],
    );
    const pedidos = await this.ds.query(
      `SELECT p.id, p.folio_num AS "folioNum", p.estado, p.repartidor_id AS "repartidorId", p.destino_nombre AS cliente,
              json_build_object('lat', p.destino_lat, 'lng', p.destino_lng) AS destino,
              json_build_object('id', t.id, 'nombre', t.nombre, 'lat', t.lat, 'lng', t.lng) AS tienda,
              CASE WHEN p.estado = 'listo_para_recoger' THEN round(extract(epoch FROM now() - p.listo_en) / 60)::int END AS "minutosEsperando"
       FROM pedidos p JOIN tiendas t ON t.id = p.tienda_id
       WHERE p.estado IN ('creado','aceptado_tienda','listo_para_recoger','asignado','en_tienda','en_camino','en_domicilio')
       ORDER BY p.creado_en`,
    );
    const tiendas = await this.ds.query(
      `SELECT t.id, t.nombre, t.lat, t.lng FROM tiendas t JOIN usuarios u ON u.id = t.owner_id
       WHERE u.estado = 'activo' AND tienda_abierta_ahora(t.id)`,
    );
    return {
      repartidores: repartidores.map(({ lat, lng, ...r }) => ({ ...r, ubicacion: { lat, lng } })),
      pedidos: pedidos.map(({ folioNum, tienda, ...x }) => ({
        ...x,
        folio: folio('R', folioNum),
        tienda: { id: tienda.id, nombre: tienda.nombre, ubicacion: { lat: tienda.lat, lng: tienda.lng } },
      })),
      tiendas: tiendas.map(({ lat, lng, ...t }) => ({ ...t, ubicacion: { lat, lng } })),
    };
  }

  // ─────────────────────────── reseñas

  async resenas(q: ListaResenasDto, pedidoId?: string) {
    const params: any[] = [];
    const p = (v: any) => (params.push(v), `$${params.length}`);
    const filtros = ['true'];
    if (q.q?.trim()) {
      const t = p(`%${q.q.trim()}%`);
      filtros.push(`(c.comentario ILIKE ${t} OR t.nombre ILIKE ${t} OR cu.nombre ILIKE ${t})`);
    }
    if (q.estrellas) filtros.push(`c.tienda = ${p(q.estrellas)}`);
    if (SI(q.ocultas) != null) filtros.push(`c.oculta = ${p(SI(q.ocultas))}`);
    if (q.tiendaId) filtros.push(`c.tienda_id = ${p(q.tiendaId)}`);
    if (pedidoId) filtros.push(`c.pedido_id = ${p(pedidoId)}`);
    const desde = `FROM calificaciones c JOIN pedidos pe ON pe.id = c.pedido_id JOIN tiendas t ON t.id = c.tienda_id
                   LEFT JOIN usuarios cu ON cu.id = pe.cliente_id LEFT JOIN usuarios mo ON mo.id = c.oculta_por
                   WHERE ${filtros.join(' AND ')}`;
    const [{ total }] = await this.ds.query(`SELECT count(*)::int AS total ${desde}`, params);
    const filas = await this.ds.query(
      `SELECT c.pedido_id AS "pedidoId", pe.folio_num AS "folioNum", c.tienda AS estrellas, c.repartidor AS "estrellasRepartidor",
              c.comentario, c.respuesta, c.respondido_en AS "respondidoEn", c.creado_en AS "creadoEn",
              c.oculta, c.oculta_motivo AS "ocultaMotivo", c.oculta_en AS "ocultaEn", mo.nombre AS "ocultaPor",
              json_build_object('id', t.id, 'nombre', t.nombre) AS tienda,
              json_build_object('id', cu.id, 'nombre', cu.nombre) AS cliente
       ${desde} ORDER BY c.creado_en DESC LIMIT ${p(q.limit)} OFFSET ${p((q.page - 1) * q.limit)}`,
      params,
    );
    return pagina(filas.map(({ folioNum, ...x }) => ({ ...x, folio: folio('R', folioNum) })), total, q);
  }

  async moderar(actor: Usuario, pedidoId: string, dto: ModerarResenaDto) {
    const repo = this.ds.getRepository(Calificacion);
    const c = await repo.findOneBy({ pedidoId });
    if (!c) throw noEncontrado('Reseña no encontrada');
    await repo.update(pedidoId, dto.oculta
      ? { oculta: true, ocultaMotivo: dto.motivo!.trim(), ocultaPor: actor.id, ocultaEn: new Date() }
      : { oculta: false, ocultaMotivo: null, ocultaPor: null, ocultaEn: null });
    const [r] = (await this.resenas({ page: 1, limit: 1, q: undefined } as ListaResenasDto, pedidoId)).data;
    return r;
  }

  // ─────────────────────────── cuentas (solo admin)

  async editarUsuario(actor: Usuario, id: string, dto: EditarUsuarioDto) {
    const repo = this.ds.getRepository(Usuario);
    const u = await repo.findOneBy({ id });
    if (!u) throw noEncontrado('Usuario no encontrado');
    if (u.estado === 'eliminado') throw conflicto('CUENTA_ELIMINADA', 'Esta cuenta ya fue eliminada');
    const interno = u.rol === 'soporte' || u.rol === 'admin';
    if (dto.rol && !interno) throw invalido('Solo se puede cambiar el rol de las cuentas de soporte o admin', 'rol');
    if (dto.rol === 'soporte' && u.rol === 'admin' && (await repo.countBy({ rol: 'admin', estado: 'activo' })) <= 1) {
      throw conflicto('ULTIMO_ADMIN', 'No puedes quitarle el rol a la única cuenta de admin activa');
    }
    const email = dto.email?.trim().toLowerCase();
    if (email && email !== u.email && (await repo.existsBy({ email }))) throw conflicto('EMAIL_EN_USO', 'Ese correo ya tiene una cuenta');

    const cambios: Partial<Usuario> = {};
    const notas: string[] = [];
    if (dto.nombre && dto.nombre.trim() !== u.nombre) (cambios.nombre = dto.nombre.trim()), notas.push('nombre');
    if (dto.telefono && dto.telefono !== u.telefono) (cambios.telefono = dto.telefono), notas.push('teléfono');
    if (email && email !== u.email) (cambios.email = email), (cambios.emailVerificadoEn = null), notas.push('correo');
    if (dto.rol && dto.rol !== u.rol) (cambios.rol = dto.rol), notas.push(`rol a ${dto.rol}`);
    if (!notas.length) return vistaUsuario(u);

    await repo.update(id, cambios);
    // Un cambio de rol o de correo cierra sus sesiones para que entre con los datos nuevos.
    if (cambios.rol || cambios.email) {
      await this.ds.getRepository(RefreshToken).delete({ usuarioId: id });
      this.rt.desconectar(id);
    }
    await this.bitacora.registrar(id, 'datos_editados', actor, `Cambió ${notas.join(', ')}`);
    return vistaUsuario(await repo.findOneByOrFail({ id }));
  }

  /** Pone una contraseña temporal y cierra todas sus sesiones; se le comparte por un medio privado. */
  async fijarPassword(actor: Usuario, id: string, password: string) {
    const repo = this.ds.getRepository(Usuario);
    const u = await repo.findOneBy({ id });
    if (!u) throw noEncontrado('Usuario no encontrado');
    if (u.estado === 'eliminado') throw conflicto('CUENTA_ELIMINADA', 'Esta cuenta ya fue eliminada');
    if (u.firebaseUid && u.proveedor !== 'password' && u.proveedor !== 'local') {
      throw conflicto('CUENTA_SOCIAL', `Esta cuenta entra con ${u.proveedor}; su contraseña se maneja ahí`);
    }
    await repo.update(id, { passwordHash: await bcrypt.hash(password, 10), intentosFallidos: 0, bloqueadoHasta: null });
    await this.ds.getRepository(RefreshToken).delete({ usuarioId: id });
    this.rt.desconectar(id);
    await this.bitacora.registrar(id, 'password_restablecida', actor, 'Un admin le puso una contraseña temporal');
  }

  async eliminarUsuario(actor: Usuario, id: string, motivo: string) {
    const u = await this.ds.getRepository(Usuario).findOneBy({ id });
    if (!u) throw noEncontrado('Usuario no encontrado');
    if (u.id === actor.id) throw sinPermiso('No puedes eliminar tu propia cuenta desde aquí');
    if (u.estado === 'eliminado') throw conflicto('CUENTA_ELIMINADA', 'Esta cuenta ya fue eliminada');
    if (u.rol === 'admin' && (await this.ds.getRepository(Usuario).countBy({ rol: 'admin', estado: 'activo' })) <= 1) {
      throw conflicto('ULTIMO_ADMIN', 'No puedes eliminar la única cuenta de admin activa');
    }
    const activos = { estado: Not(In(ESTADOS_FINALES)) };
    const tiendas = u.rol === 'tienda' ? await this.ds.getRepository(Tienda).findBy({ ownerId: u.id }) : [];
    const pendientes =
      (u.rol === 'cliente' && (await this.ds.getRepository(Pedido).existsBy({ clienteId: u.id, ...activos }))) ||
      (u.rol === 'repartidor' && (await this.ds.getRepository(Viaje).existsBy({ repartidorId: u.id, estado: 'activo' }))) ||
      (tiendas.length > 0 && (await this.ds.getRepository(Pedido).existsBy({ tiendaId: In(tiendas.map((t) => t.id)), ...activos })));
    if (pendientes) throw conflicto('TIENE_PEDIDOS_ACTIVOS', 'Tiene pedidos en curso: termínalos o cancélalos antes de eliminar la cuenta');
    await this.auth.anonimizar(u, actor, motivo);
  }

  // ─────────────────────────── métricas con series

  async series(q: MetricasDto) {
    const args = [q.desde ?? null, q.hasta ?? null];
    const rango = `($1::date IS NULL OR (p.creado_en AT TIME ZONE 'America/Mexico_City')::date >= $1::date)
                   AND ($2::date IS NULL OR (p.creado_en AT TIME ZONE 'America/Mexico_City')::date <= $2::date)`;
    const porDia = await this.ds.query(
      `SELECT to_char((p.creado_en AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS dia,
              count(*)::int AS pedidos,
              count(*) FILTER (WHERE p.estado = 'entregado')::int AS entregados,
              count(*) FILTER (WHERE p.estado IN ('cancelado','rechazado'))::int AS cancelados,
              coalesce(sum(p.total) FILTER (WHERE p.estado = 'entregado'), 0)::float8 AS ventas
       FROM pedidos p WHERE ${rango} AND p.estado <> 'programado' GROUP BY 1 ORDER BY 1`,
      args,
    );
    const porHora = await this.ds.query(
      `SELECT h AS hora, count(p.id)::int AS pedidos
       FROM generate_series(0, 23) h
       LEFT JOIN pedidos p ON extract(hour FROM p.creado_en AT TIME ZONE 'America/Mexico_City') = h AND ${rango}
       GROUP BY h ORDER BY h`,
      args,
    );
    const topTiendas = await this.ds.query(
      `SELECT t.id, t.nombre, count(*)::int AS pedidos, coalesce(sum(p.subtotal), 0)::float8 AS ventas
       FROM pedidos p JOIN tiendas t ON t.id = p.tienda_id
       WHERE ${rango} AND p.estado = 'entregado' GROUP BY t.id, t.nombre ORDER BY ventas DESC LIMIT 5`,
      args,
    );
    const topRepartidores = await this.ds.query(
      `SELECT u.id, u.nombre, count(*)::int AS entregas, u.calificacion::float8 AS calificacion
       FROM pedidos p JOIN usuarios u ON u.id = p.repartidor_id
       WHERE ${rango} AND p.estado = 'entregado' GROUP BY u.id, u.nombre, u.calificacion ORDER BY entregas DESC LIMIT 5`,
      args,
    );
    const [tiempos] = await this.ds.query(
      `SELECT round(avg(extract(epoch FROM (p.entregado_en - p.creado_en)) / 60))::int AS "entregaMin",
              round(avg(extract(epoch FROM (p.listo_en - p.creado_en)) / 60))::int AS "preparacionMin",
              round(avg(p.total)::numeric, 2)::float8 AS "ticketPromedio",
              count(*) FILTER (WHERE p.metodo_pago = 'tarjeta')::int AS tarjeta,
              count(*) FILTER (WHERE p.metodo_pago = 'efectivo')::int AS efectivo
       FROM pedidos p WHERE ${rango} AND p.estado = 'entregado'`,
      args,
    );
    return { porDia, porHora, topTiendas, topRepartidores, tiempos };
  }

  // ─────────────────────────── notificaciones

  async notificar(actor: Usuario, dto: NotificacionDto) {
    if (dto.destino === 'tema') {
      const modo = await this.push.aTema(dto.tema!, dto.titulo, dto.cuerpo);
      return { destino: 'tema', tema: dto.tema, modo };
    }
    const total = await this.ds.getRepository(Usuario).countBy({ rol: dto.rol!, estado: 'activo' });
    await this.push.aRoles([dto.rol!], dto.titulo, dto.cuerpo, { tipo: 'aviso_general', enviadoPor: actor.id });
    return { destino: 'rol', rol: dto.rol, destinatarios: total, modo: this.push.activo ? 'enviada' : 'simulada' };
  }

  // ─────────────────────────── bitácora del equipo

  async acciones(q: BitacoraDto) {
    const params: any[] = [];
    const p = (v: any) => (params.push(v), `$${params.length}`);
    const filtros = ['true'];
    if (q.actorId) filtros.push(`a.actor_id = ${p(q.actorId)}`);
    if (q.q?.trim()) {
      const t = p(`%${q.q.trim()}%`);
      filtros.push(`(a.accion ILIKE ${t} OR a.ruta ILIKE ${t} OR u.nombre ILIKE ${t})`);
    }
    const desde = `FROM acciones_internas a LEFT JOIN usuarios u ON u.id = a.actor_id WHERE ${filtros.join(' AND ')}`;
    const [{ total }] = await this.ds.query(`SELECT count(*)::int AS total ${desde}`, params);
    const filas = await this.ds.query(
      `SELECT a.id, a.accion, a.metodo, a.ruta, a.recurso_id AS "recursoId", a.detalle, a.estado_http AS "estadoHttp", a.creado_en AS "creadoEn",
              json_build_object('id', a.actor_id, 'nombre', u.nombre, 'rol', a.actor_rol) AS actor
       ${desde} ORDER BY a.creado_en DESC LIMIT ${p(q.limit)} OFFSET ${p((q.page - 1) * q.limit)}`,
      params,
    );
    return pagina(filas, total, q);
  }

  /** La llama el interceptor después de cada cambio hecho por soporte o admin. */
  async registrarAccion(a: Omit<AccionInterna, 'id' | 'creadoEn'>) {
    await this.ds.getRepository(AccionInterna).insert(a);
  }
}
