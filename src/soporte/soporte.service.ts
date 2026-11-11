import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Brackets, DataSource, Repository } from 'typeorm';
import { AuthService, vistaUsuario } from '../auth/auth.service';
import { pagina } from '../common/dtos';
import { conflicto, noEncontrado } from '../common/errores';
import { ESTADOS_FINALES, EstadoPedido } from '../config/reglas';
import { Pedido, Tienda, Usuario } from '../database/entities';
import { PushService } from '../nucleo/push.service';
import { RealtimeService } from '../nucleo/realtime.service';
import { PedidosService } from '../pedidos/pedidos.service';
import { BuscarPedidosDto, BuscarUsuariosDto, CorregirUbicacionDto, MetricasDto, UsuarioInternoDto } from './soporte.dto';

const NO_FINALES: EstadoPedido[] = ['creado', 'aceptado_tienda', 'listo_para_recoger', 'asignado', 'en_tienda', 'en_camino', 'en_domicilio'];

/** Acciones de soporte. Todas exigen un motivo y quedan en la bitácora del pedido. */
@Injectable()
export class SoporteService {
  constructor(
    private readonly ds: DataSource,
    private readonly pedidosSvc: PedidosService,
    private readonly auth: AuthService,
    private readonly rt: RealtimeService,
    private readonly push: PushService,
    @InjectRepository(Pedido) private readonly pedidos: Repository<Pedido>,
    @InjectRepository(Usuario) private readonly usuarios: Repository<Usuario>,
    @InjectRepository(Tienda) private readonly tiendas: Repository<Tienda>,
  ) {}

  // ─────────────────────────── pedidos

  async buscarPedidos(agente: Usuario, q: BuscarPedidosDto) {
    const qb = this.pedidos.createQueryBuilder('p').where('TRUE');
    const estados = this.pedidosSvc.estadosDe(q.estado);
    if (estados.length) qb.andWhere('p.estado IN (:...estados)', { estados });
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

  async cancelar(agente: Usuario, id: string, motivo: string) {
    const p = await this.pedidosSvc.transicionar(id, { desde: NO_FINALES, hacia: 'cancelado', evento: 'cancelado', actor: agente, detalle: motivo });
    return this.pedidosSvc.vista(p, agente);
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
    if (q.estado) qb.andWhere('u.estado = :estado', { estado: q.estado });
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

  async aprobar(id: string) {
    const u = await this.usuario(id);
    if (u.estado !== 'pendiente_aprobacion') throw conflicto('TRANSICION_INVALIDA', 'La cuenta no está pendiente de aprobación');
    u.estado = 'activo';
    await this.usuarios.save(u);
    this.rt.emitir([`usuario:${u.id}`], 'cuenta:aprobada', {});
    void this.push.aUsuarios([u.id], 'Cuenta aprobada', 'Ya puedes usar PaPedir');
    return vistaUsuario(u);
  }

  /** Banear cierra todas las sesiones al momento. Los pedidos en curso los resuelve soporte (liberar o cancelar). */
  async banear(agente: Usuario, id: string, motivo: string) {
    const u = await this.usuario(id);
    if (u.id === agente.id) throw conflicto('TRANSICION_INVALIDA', 'No puedes banearte a ti mismo');
    if ((u.rol === 'soporte' || u.rol === 'admin') && agente.rol !== 'admin') {
      throw conflicto('TRANSICION_INVALIDA', 'Solo un admin puede banear cuentas internas');
    }
    Object.assign(u, { estado: 'baneado', motivoBaneo: motivo, disponible: false });
    await this.usuarios.save(u);
    await this.tiendas.update({ ownerId: u.id }, { abierta: false });
    this.rt.emitir([`usuario:${u.id}`], 'cuenta:baneada', { motivo });
    await this.auth.cerrarSesiones(u.id);
    this.rt.desconectar(u.id);
    return vistaUsuario(u);
  }

  async desbanear(id: string) {
    const u = await this.usuario(id);
    if (u.estado !== 'baneado') throw conflicto('TRANSICION_INVALIDA', 'La cuenta no está baneada');
    Object.assign(u, { estado: 'activo', motivoBaneo: null });
    return vistaUsuario(await this.usuarios.save(u));
  }

  // ─────────────────────────── admin

  async crearInterno(dto: UsuarioInternoDto) {
    const email = dto.email.toLowerCase().trim();
    if (await this.usuarios.existsBy({ email })) throw conflicto('EMAIL_REGISTRADO', 'Ese correo ya está registrado');
    const u = await this.usuarios.save(
      this.usuarios.create({ nombre: dto.nombre.trim(), email, rol: dto.rol, estado: 'activo', passwordHash: await bcrypt.hash(dto.password, 10) }),
    );
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
