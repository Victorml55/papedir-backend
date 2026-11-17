import { Injectable, Logger } from '@nestjs/common';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, Messaging } from 'firebase-admin/messaging';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Dispositivo, Notificacion, Usuario } from '../database/entities';
import { Rol } from '../config/reglas';
import { RealtimeService } from './realtime.service';

/**
 * Notificaciones: se guardan en la bandeja del usuario (tabla notificaciones, evento `notificacion:nueva`)
 * y se mandan por push con Firebase Cloud Messaging. Sin FIREBASE_SERVICE_ACCOUNT_BASE64 el push solo va al log.
 * Nunca lanza errores: una notificación fallida no debe tumbar la operación.
 */
@Injectable()
export class PushService {
  private readonly log = new Logger('Push');
  private mensajeria: Messaging | null = null;

  constructor(
    @InjectRepository(Dispositivo) private readonly dispositivos: Repository<Dispositivo>,
    @InjectRepository(Usuario) private readonly usuarios: Repository<Usuario>,
    @InjectRepository(Notificacion) private readonly bandeja: Repository<Notificacion>,
    private readonly rt: RealtimeService,
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
      const guardadas = await this.bandeja.save(usuarioIds.map((usuarioId) => this.bandeja.create({ usuarioId, titulo, cuerpo, datos: data })));
      for (const n of guardadas) {
        this.rt.emitir([`usuario:${n.usuarioId}`], 'notificacion:nueva', { id: n.id, titulo, cuerpo, datos: data, creadoEn: n.creadoEn });
      }
    } catch (e) {
      this.log.warn(`No se guardó la notificación: ${e.message}`);
    }
    // El push a Firebase va en segundo plano: quien espera esta función solo espera a que quede en la bandeja.
    void this.enviarPush(usuarioIds, titulo, cuerpo, data);
  }

  private async enviarPush(usuarioIds: string[], titulo: string, cuerpo: string, data: Record<string, string>) {
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
