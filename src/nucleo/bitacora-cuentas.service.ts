import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { EventoCuenta, Usuario } from '../database/entities';

/**
 * Bitácora de cuentas (tabla eventos_cuenta). Tipos usados:
 * registrada, creada_por_admin, aprobada, baneada, desbaneada, bloqueada, desbloqueada,
 * password_cambiada, password_restablecida, correo_verificado, terminos_aceptados, eliminada.
 */
@Injectable()
export class BitacoraCuentasService {
  constructor(@InjectRepository(EventoCuenta) private readonly repo: Repository<EventoCuenta>) {}

  registrar(usuarioId: string, tipo: string, actor?: Pick<Usuario, 'id' | 'rol'> | null, detalle?: string | null, m?: EntityManager) {
    const fila = { usuarioId, tipo, actorId: actor?.id ?? null, actorRol: actor?.rol ?? null, detalle: detalle ?? null };
    return (m ? m.getRepository(EventoCuenta) : this.repo).insert(fila);
  }

  async listar(usuarioId: string) {
    const filas = await this.repo.find({ where: { usuarioId }, order: { creadoEn: 'DESC' }, take: 200 });
    return filas.map((e) => ({ id: e.id, tipo: e.tipo, actorId: e.actorId, actorRol: e.actorRol, detalle: e.detalle, creadoEn: e.creadoEn }));
  }
}
