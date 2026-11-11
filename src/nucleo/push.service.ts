import { Injectable, Logger } from '@nestjs/common';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, Messaging } from 'firebase-admin/messaging';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Dispositivo, Usuario } from '../database/entities';
import { Rol } from '../config/reglas';

/**
 * Notificaciones push con Firebase Cloud Messaging.
 * Sin FIREBASE_SERVICE_ACCOUNT_BASE64 solo escribe en el log (útil en desarrollo).
 * Nunca lanza errores: una notificación fallida no debe tumbar la operación.
 */
@Injectable()
export class PushService {
  private readonly log = new Logger('Push');
  private mensajeria: Messaging | null = null;

  constructor(
    @InjectRepository(Dispositivo) private readonly dispositivos: Repository<Dispositivo>,
    @InjectRepository(Usuario) private readonly usuarios: Repository<Usuario>,
  ) {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!b64) return;
    try {
      const cuenta = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      const app = getApps().find((a) => a.name === 'papedir') ?? initializeApp({ credential: cert(cuenta) }, 'papedir');
      this.mensajeria = getMessaging(app);
      this.log.log(`Firebase listo (proyecto ${cuenta.project_id})`);
    } catch (e) {
      this.log.error(`No se pudo iniciar Firebase: ${e.message}`);
    }
  }

  async aUsuarios(ids: (string | null | undefined)[], titulo: string, cuerpo: string, data: Record<string, string> = {}) {
    const usuarioIds = [...new Set(ids.filter(Boolean) as string[])];
    if (!usuarioIds.length) return;
    try {
      const filas = await this.dispositivos.findBy({ usuarioId: In(usuarioIds) });
      const tokens = filas.map((d) => d.fcmToken);
      if (!this.mensajeria) return this.log.debug(`[simulada] "${titulo}: ${cuerpo}" → ${usuarioIds.length} usuario(s)`);
      if (!tokens.length) return;
      const r = await this.mensajeria.sendEachForMulticast({ tokens, notification: { title: titulo, body: cuerpo }, data });
      const invalidos = tokens.filter((_, i) => !r.responses[i].success &&
        ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(r.responses[i].error?.code));
      if (invalidos.length) await this.dispositivos.delete({ fcmToken: In(invalidos) });
    } catch (e) {
      this.log.warn(`Push fallida: ${e.message}`);
    }
  }

  async aRoles(roles: Rol[], titulo: string, cuerpo: string, data: Record<string, string> = {}) {
    const lista = await this.usuarios.find({ where: { rol: In(roles), estado: 'activo' }, select: { id: true } });
    return this.aUsuarios(lista.map((u) => u.id), titulo, cuerpo, data);
  }
}
