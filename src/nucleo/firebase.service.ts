import { Injectable, Logger } from '@nestjs/common';
import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { AppError } from '../common/errores';

/** Lo que nos importa del token de Firebase Authentication. */
export type IdentidadFirebase = {
  uid: string;
  email: string | null;
  emailVerificado: boolean;
  nombre: string | null;
  foto: string | null;
  /** password, google.com, github.com, facebook.com... */
  proveedor: string;
};

/**
 * Conexión única con Firebase (cuenta de servicio en FIREBASE_SERVICE_ACCOUNT_BASE64).
 * La usan el push (Cloud Messaging) y el login de las apps (Authentication).
 */
/**
 * firebase-admin/auth depende de un paquete solo ESM (jose). Node 22 lo carga sin problema,
 * pero Jest no; por eso se carga hasta que se usa (en las pruebas se simula este servicio).
 */
const auth = (app: App) => (require('firebase-admin/auth') as typeof import('firebase-admin/auth')).getAuth(app);

@Injectable()
export class FirebaseService {
  private readonly log = new Logger('Firebase');
  readonly app: App | null = null;

  constructor() {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!b64) return;
    try {
      const cuenta = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      this.app = getApps().find((a) => a.name === 'papedir') ?? initializeApp({ credential: cert(cuenta) }, 'papedir');
      this.log.log(`Firebase listo (proyecto ${cuenta.project_id})`);
    } catch (e) {
      this.log.error(`No se pudo iniciar Firebase: ${e.message}`);
    }
  }

  /** Valida el ID token que la app obtuvo de Firebase Authentication (firma, vigencia y proyecto). */
  async verificar(idToken: string): Promise<IdentidadFirebase> {
    if (!this.app) throw new AppError(503, 'FIREBASE_NO_CONFIGURADO', 'El inicio de sesión con Firebase no está disponible');
    try {
      const d = await auth(this.app).verifyIdToken(idToken, true);
      return {
        uid: d.uid,
        email: d.email?.toLowerCase() ?? null,
        emailVerificado: !!d.email_verified,
        nombre: (d.name as string) ?? null,
        foto: d.picture ?? null,
        proveedor: d.firebase?.sign_in_provider ?? 'desconocido',
      };
    } catch (e) {
      this.log.debug(`Token de Firebase rechazado: ${e.code ?? e.message}`);
      throw new AppError(401, 'NO_AUTENTICADO', 'La sesión de Firebase no es válida o ya venció; inicia sesión de nuevo');
    }
  }

  /** Borra al usuario de Firebase Authentication. Nunca lanza errores. */
  async borrarUsuario(uid: string) {
    if (!this.app) return;
    await auth(this.app).deleteUser(uid).catch((e) => this.log.warn(`No se pudo borrar ${uid} de Firebase: ${e.message}`));
  }
}
