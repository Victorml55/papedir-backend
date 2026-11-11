import { Injectable, Logger } from '@nestjs/common';
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
  private mensajeria: any = null;

  constructor(
    @InjectRepository(Dispositivo) private readonly dispositivos: Repository<Dispositivo>,
    @InjectRepository(Usuario) private readonly usuarios: Repository<Usuario>,
  ) {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!b64) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const admin = require('firebase-admin');
      const cuenta = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      const app = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(cuenta) });
      this.mensajeria = admin.messaging(app);
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
