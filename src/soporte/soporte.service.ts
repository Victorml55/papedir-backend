import { CATALOGO } from '../config/catalogos';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Brackets, DataSource, Repository } from 'typeorm';
import { AuthService, vistaUsuario } from '../auth/auth.service';
import { pagina } from '../common/dtos';
import { conflicto, noEncontrado } from '../common/errores';
import { ESTADOS_FINALES, EstadoPedido, REGLAS } from '../config/reglas';
import { Pedido, Tienda, Usuario, Vehiculo } from '../database/entities';
import { DocumentosService } from '../documentos/documentos';
import { BitacoraCuentasService } from '../nucleo/bitacora-cuentas.service';
import { PushService } from '../nucleo/push.service';
import { RealtimeService } from '../nucleo/realtime.service';
import { PedidosService, vistaVehiculo } from '../pedidos/pedidos.service';
import { BuscarPedidosDto, BuscarUsuariosDto, CancelarSoporteDto, CorregirUbicacionDto, MetricasDto, ReembolsoCarteraDto, UsuarioInternoDto } from './soporte.dto';
import { FinanzasService } from '../finanzas/finanzas.service';
import { folio, redondear } from '../common/util';
import { EventoPedido } from '../database/entities';

const NO_FINALES: EstadoPedido[] = ['programado', 'creado', 'aceptado_tienda', 'listo_para_recoger', 'asignado', 'en_tienda', 'en_camino', 'en_domicilio'];

/** Acciones de soporte. Todas exigen un motivo y quedan en la bitácora del pedido. */
@Injectable()
export class SoporteService {
  constructor(
    private readonly ds: DataSource,
    private readonly pedidosSvc: PedidosService,
    private readonly auth: AuthService,
    private readonly rt: RealtimeService,
    private readonly push: PushService,
    private readonly bitacora: BitacoraCuentasService,
    private readonly documentos: DocumentosService,
    @InjectRepository(Pedido) private readonly pedidos: Repository<Pedido>,
    @InjectRepository(Usuario) private readonly usuarios: Repository<Usuario>,
    @InjectRepository(Tienda) private readonly tiendas: Repository<Tienda>,
    private readonly finanzas: FinanzasService,
  ) {}

  // ─────────────────────────── pedidos

  async buscarPedidos(agente: Usuario, q: BuscarPedidosDto) {
    const qb = this.pedidos.createQueryBuilder('p').where('TRUE');
    const estados = this.pedidosSvc.estadosDe(q.estado);
    if (estados.length) qb.andWhere('p.estado IN (:...estados)', { estados });
    if (q.clienteId) qb.andWhere('p.cliente_id = :c', { c: q.clienteId });
    if (q.repartidorId) qb.andWhere('p.repartidor_id = :r', { r: q.repartidorId });
    if (q.tiendaId) qb.andWhere('p.tienda_id = :ti', { ti: q.tiendaId });
    if (q.q?.trim()) {
      qb.andWhere(
        new Brackets((b) =>
          b.where(`('R-' || lpad(p.folio_num::text, 6, '0')) ILIKE :t`)
            .orWhere('p.destino_nombre ILIKE :t')
            .orWhere('p.destino_telefono ILIKE :t'),
        ),
        { t: `%${q.q.trim()}%` },
      );
    }
    const [filas, total] = await qb.orderBy('p.creado_en', 'DESC').skip((q.page - 1) * q.limit).take(q.limit).getManyAndCount();
    return pagina(await this.pedidosSvc.vistas(filas, agente), total, q);
  }

  async cancelar(agente: Usuario, id: string, dto: CancelarSoporteDto) {
    const m = this.pedidosSvc.motivo('soporte', dto);
    const p = await this.pedidosSvc.transicionar(id, {
      desde: NO_FINALES, hacia: 'cancelado', evento: 'cancelado', actor: agente, detalle: m.texto, cambios: () => ({ motivoCodigo: m.codigo }),
      reembolsoA: dto.reembolsoA,
      reglas: dto.cobrarCargo ? (x, em) => this.pedidosSvc.cobrarCancelacion(x, em) : undefined,
    });
    return this.pedidosSvc.vista(p, agente);
  }

  /**
   * Devuelve dinero a la cartera del cliente por un pedido entregado (faltó algo, llegó mal...).
   * Lo absorbe PaPedir; el tope es lo que el cliente pagó por el pedido menos lo ya reembolsado.
   */
  async reembolsarACartera(agente: Usuario, id: string, dto: ReembolsoCarteraDto) {
    const p = await this.pedidos.findOneBy({ id });
    if (!p) throw noEncontrado('Pedido no encontrado');
    if (!p.clienteId) throw conflicto('SIN_CLIENTE', 'Es un pedido capturado por la tienda; no tiene cliente con cartera');
    if (p.estado !== 'entregado') throw conflicto('TRANSICION_INVALIDA', 'Solo se reembolsan pedidos entregados; para otros, cancélalo');
    await this.ds.transaction(async (m) => {
      await m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [p.id]);
      const [{ previo }] = await m.query(`SELECT coalesce(sum(monto), 0)::float8 AS previo FROM movimientos WHERE pedido_id = $1 AND tipo = 'reembolso' AND usuario_id = $2`, [p.id, p.clienteId]);
      const tope = redondear(p.total + p.saldoAplicado - p.deudaCobrada - previo);
      if (dto.monto > tope) throw conflicto('REEMBOLSO_EXCEDIDO', tope > 0 ? `Lo máximo que puedes reembolsar de este pedido es $${tope}` : 'Este pedido ya se reembolsó completo');
      // Un pedido admite un solo movimiento de cada tipo: los reembolsos siguientes se suman al primero.
      if (previo) await m.query(`UPDATE movimientos SET monto = monto + $3, descripcion = $4 WHERE pedido_id = $1 AND tipo = 'reembolso' AND usuario_id = $2`, [p.id, p.clienteId, dto.monto, `Reembolsos del pedido ${folio('R', p.folioNum)}`]);
      else await this.finanzas.abonar(m, [{ usuarioId: p.clienteId, pedidoId: p.id, tipo: 'reembolso', monto: dto.monto, descripcion: `Reembolso del pedido ${folio('R', p.folioNum)}: ${dto.motivo}` }]);
      await m.insert(EventoPedido, { pedidoId: p.id, tipo: 'reembolsado', usuarioId: agente.id, rol: agente.rol, detalle: `$${dto.monto} a la cartera: ${dto.motivo}` });
    });
    void this.push.aUsuarios([p.clienteId], 'Te reembolsamos', `$${dto.monto} del pedido ${folio('R', p.folioNum)} ya están en tu cartera; se descuentan solos en tu siguiente pedido`, { pedidoId: p.id });
    return this.pedidosSvc.vista(await this.pedidos.findOneByOrFail({ id }), agente);
  }

  /** La solicitud no procede tal como está: la cuenta sigue pendiente y el usuario ve el motivo para corregir. */
  async rechazarCuenta(agente: Usuario, id: string, motivo: string) {
    const u = await this.usuario(id);
    if (u.estado !== 'pendiente_aprobacion') throw conflicto('TRANSICION_INVALIDA', 'La cuenta no está pendiente de aprobación');
    Object.assign(u, { motivoRechazo: motivo.trim(), rechazadaEn: new Date() });
    await this.usuarios.save(u);
    await this.bitacora.registrar(u.id, 'solicitud_rechazada', agente, motivo);
    this.rt.emitir([`usuario:${u.id}`], 'cuenta:rechazada', { motivo });
    void this.push.aUsuarios([u.id], 'Tu solicitud necesita cambios', motivo);
    return vistaUsuario(u);
  }

  /** Por ejemplo: la ubicación estaba mal capturada pero el pedido sí se entregó. */
  async completar(agente: Usuario, id: string, motivo: string) {
    const p = await this.pedidosSvc.transicionar(id, {
      desde: NO_FINALES, hacia: 'entregado', evento: 'completado_por_soporte', actor: agente, detalle: motivo,
      cambios: () => ({ entregadoEn: new Date() }),
    });
    return this.pedidosSvc.vista(p, agente);
  }

  /** Quita el pedido al repartidor para que otro lo tome. Solo antes de que salga de la tienda con él. */
  async liberar(agente: Usuario, id: string, motivo: string) {
    const p = await this.pedidosSvc.transicionar(id, {
      desde: ['asignado', 'en_tienda'], hacia: 'listo_para_recoger', evento: 'liberado_por_soporte', actor: agente, detalle: motivo,
      cambios: () => ({ repartidorId: null, viajeId: null, listoEn: new Date(), soporteAvisado: false }),
    });
    return this.pedidosSvc.vista(p, agente);
  }

  /** Corrige el destino sin cambiar el precio ya pactado. */
  async corregirUbicacion(agente: Usuario, id: string, dto: CorregirUbicacionDto) {
    const p = await this.pedidos.findOneBy({ id });
    if (!p) throw noEncontrado('Pedido no encontrado');
    if (ESTADOS_FINALES.includes(p.estado)) throw conflicto('TRANSICION_INVALIDA', 'El pedido ya terminó');
    const actualizado = await this.pedidosSvc.transicionar(id, {
      desde: [p.estado], hacia: p.estado, evento: 'ubicacion_corregida', actor: agente, ubicacion: dto.ubicacion, sinPush: true,
      detalle: `${dto.motivo} · antes: ${p.destinoDireccion}`,
      cambios: () => ({ destinoDireccion: dto.direccion, destinoLat: dto.ubicacion.lat, destinoLng: dto.ubicacion.lng }),
    });
    return this.pedidosSvc.vista(actualizado, agente);
  }

  // ─────────────────────────── cuentas

  async buscarUsuarios(q: BuscarUsuariosDto) {
    const qb = this.usuarios.createQueryBuilder('u').where('TRUE');
    if (q.rol) qb.andWhere('u.rol = :rol', { rol: q.rol });
    // Las cuentas eliminadas solo aparecen si se piden explícitamente.
    if (q.estado) qb.andWhere('u.estado = :estado', { estado: q.estado });
    else qb.andWhere(`u.estado <> 'eliminado'`);
    if (q.q?.trim()) {
      qb.andWhere(
        new Brackets((b) =>
          b.where('u.nombre ILIKE :t').orWhere('u.email ILIKE :t').orWhere('u.telefono ILIKE :t')
            .orWhere('EXISTS (SELECT 1 FROM tiendas t WHERE t.owner_id = u.id AND t.nombre ILIKE :t)'),
        ),
        { t: `%${q.q.trim()}%` },
      );
    }
    const [filas, total] = await qb.orderBy('u.creado_en', 'DESC').skip((q.page - 1) * q.limit).take(q.limit).getManyAndCount();
    return pagina(filas.map(vistaUsuario), total, q);
  }

  private async usuario(id: string) {
    const u = await this.usuarios.findOneBy({ id });
    if (!u) throw noEncontrado('Usuario no encontrado');
    return u;
  }

  /** Ficha completa para soporte: datos de la cuenta, baneo, bloqueo y su tienda si tiene. */
  async detalle(id: string) {
    const u = await this.usuario(id);
    const tiendas = u.rol === 'tienda' ? await this.tiendas.findBy({ ownerId: u.id }) : [];
    return {
      ...vistaUsuario(u),
      motivoBaneo: u.motivoBaneo,
      bloqueadoHasta: u.bloqueadoHasta && u.bloqueadoHasta > new Date() ? u.bloqueadoHasta : null,
      eliminadoEn: u.eliminadoEn,
      terminosVersion: u.terminosVersion,
      terminosAceptadosEn: u.terminosAceptadosEn,
      tiendas: tiendas.map((t) => ({ id: t.id, nombre: t.nombre, abierta: t.abierta })),
      vehiculo: u.rol === 'repartidor' ? vistaVehiculo(await this.ds.getRepository(Vehiculo).findOneBy({ repartidorId: u.id })) : null,
      documentosCompletos: u.rol === 'repartidor' || u.rol === 'tienda' ? await this.documentos.completos(u) : null,
    };
  }

  eventos(id: string) {
    return this.usuario(id).then((u) => this.bitacora.listar(u.id));
  }

  async desbloquear(agente: Usuario, id: string) {
    const u = await this.usuario(id);
    if (!u.bloqueadoHasta || u.bloqueadoHasta <= new Date()) throw conflicto('TRANSICION_INVALIDA', 'La cuenta no está bloqueada');
    await this.usuarios.update(u.id, { bloqueadoHasta: null, intentosFallidos: 0 });
    await this.bitacora.registrar(u.id, 'desbloqueada', agente);
    return this.detalle(u.id);
  }

  async aprobar(agente: Usuario, id: string) {
    const u = await this.usuario(id);
    if (u.estado !== 'pendiente_aprobacion') throw conflicto('TRANSICION_INVALIDA', 'La cuenta no está pendiente de aprobación');
    if (CATALOGO.documentos.exigirParaAprobar && !(await this.documentos.completos(u))) {
      throw conflicto('DOCUMENTOS_INCOMPLETOS', 'Aprueba primero sus documentos obligatorios');
    }
    Object.assign(u, { estado: 'activo', motivoRechazo: null, rechazadaEn: null });
    await this.usuarios.save(u);
    await this.bitacora.registrar(u.id, 'aprobada', agente);
    this.rt.emitir([`usuario:${u.id}`], 'cuenta:aprobada', {});
    void this.push.aUsuarios([u.id], 'Cuenta aprobada', 'Ya puedes usar PaPedir');
    return vistaUsuario(u);
  }

  /** Banear cierra todas las sesiones al momento. Los pedidos en curso los resuelve soporte (liberar o cancelar). */
  async banear(agente: Usuario, id: string, motivo: string) {
    const u = await this.usuario(id);
    if (u.id === agente.id) throw conflicto('TRANSICION_INVALIDA', 'No puedes banearte a ti mismo');
    if (u.estado === 'eliminado') throw conflicto('TRANSICION_INVALIDA', 'La cuenta ya fue eliminada');
    if ((u.rol === 'soporte' || u.rol === 'admin') && agente.rol !== 'admin') {
      throw conflicto('TRANSICION_INVALIDA', 'Solo un admin puede banear cuentas internas');
    }
    Object.assign(u, { estado: 'baneado', motivoBaneo: motivo, disponible: false });
    await this.usuarios.save(u);
    await this.tiendas.update({ ownerId: u.id }, { abierta: false });
    await this.bitacora.registrar(u.id, 'baneada', agente, motivo);
    this.rt.emitir([`usuario:${u.id}`], 'cuenta:baneada', { motivo });
    await this.auth.cerrarSesiones(u.id);
    this.rt.desconectar(u.id);
    return vistaUsuario(u);
  }

  async desbanear(agente: Usuario, id: string) {
    const u = await this.usuario(id);
    if (u.estado !== 'baneado') throw conflicto('TRANSICION_INVALIDA', 'La cuenta no está baneada');
    Object.assign(u, { estado: 'activo', motivoBaneo: null });
    const guardado = await this.usuarios.save(u);
    await this.bitacora.registrar(u.id, 'desbaneada', agente);
    return vistaUsuario(guardado);
  }

  // ─────────────────────────── admin

  async crearInterno(admin: Usuario, dto: UsuarioInternoDto) {
    const email = dto.email.toLowerCase().trim();
    if (await this.usuarios.existsBy({ email })) throw conflicto('EMAIL_REGISTRADO', 'Ese correo ya está registrado');
    const externo = dto.rol === 'cliente' || dto.rol === 'repartidor';
    const u = await this.usuarios.save(
      this.usuarios.create({
        nombre: dto.nombre.trim(), email, rol: dto.rol, estado: 'activo', passwordHash: await bcrypt.hash(dto.password, 10),
        // Las cuentas que crea admin nacen verificadas; los términos los aceptan al entrar por primera vez.
        ...(externo ? { telefono: dto.telefono, emailVerificadoEn: new Date() } : {}),
      }),
    );
    await this.bitacora.registrar(u.id, 'creada_por_admin', admin, `Rol ${dto.rol}`);
    return vistaUsuario(u);
  }

  async metricas(q: MetricasDto) {
    const [m] = await this.ds.query(
      `WITH rango AS (
         SELECT * FROM pedidos
         WHERE ($1::timestamptz IS NULL OR creado_en >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR creado_en < $2::timestamptz + interval '1 day'))
       SELECT
         (SELECT count(*) FROM rango)::int AS "pedidosTotales",
         (SELECT count(*) FROM rango WHERE estado = 'entregado')::int AS "pedidosEntregados",
         (SELECT count(*) FROM rango WHERE estado IN ('cancelado','rechazado'))::int AS "pedidosCancelados",
         (SELECT coalesce(sum(total), 0) FROM rango WHERE estado = 'entregado')::float8 AS "ventasTotales",
         (SELECT count(*) FROM tiendas t JOIN usuarios u ON u.id = t.owner_id WHERE u.estado = 'activo')::int AS "tiendasActivas",
         (SELECT count(*) FROM usuarios WHERE rol = 'repartidor' AND estado = 'activo')::int AS "repartidoresActivos",
         (SELECT count(*) FROM tickets WHERE estado IN ('abierto','en_atencion'))::int AS "ticketsAbiertos"`,
      [q.desde ?? null, q.hasta ?? null],
    );
    return m;
  }
}
