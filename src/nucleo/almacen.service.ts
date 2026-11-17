import { Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { AppError } from '../common/errores';

/**
 * Las llaves nuevas de Supabase (sb_secret_...) no son JWT: van solo en el header apikey.
 * La llave antigua service_role (un JWT) va en apikey y en Authorization.
 */
export const cabecerasSupabase = (llave: string): Record<string, string> =>
  llave.startsWith('sb_') ? { apikey: llave } : { apikey: llave, Authorization: `Bearer ${llave}` };

/**
 * Archivos en Supabase Storage. Solo el backend tiene la llave; las apps nunca hablan con Supabase.
 * - Público (bucket SUPABASE_BUCKET): fotos de productos, tiendas, perfil y evidencias. URL permanente.
 * - Privado (bucket SUPABASE_BUCKET_PRIVADO): documentos (INE, licencia...). Solo con enlace firmado temporal.
 * Sin SUPABASE_URL/SUPABASE_SERVICE_KEY se guarda en disco: ./uploads (servido en /uploads) y ./privado (nunca servido).
 */
@Injectable()
export class AlmacenService {
  private readonly log = new Logger('Almacen');

  private get supabase() {
    const { SUPABASE_URL: url, SUPABASE_SERVICE_KEY: llave } = process.env;
    return url && llave ? { base: url.replace(/\/+$/, ''), h: cabecerasSupabase(llave) } : null;
  }
  private get bucket() { return process.env.SUPABASE_BUCKET || 'papedir'; }
  private get bucketPrivado() { return process.env.SUPABASE_BUCKET_PRIVADO || 'papedir-privado'; }

  private async subir(bucket: string, ruta: string, datos: Buffer, mime: string, cache: string) {
    const s = this.supabase;
    const r = await fetch(`${s.base}/storage/v1/object/${bucket}/${ruta}`, {
      method: 'POST',
      headers: { ...s.h, 'Content-Type': mime, 'Cache-Control': cache, 'x-upsert': 'true' },
      body: new Uint8Array(datos),
    });
    if (!r.ok) {
      this.log.error(`Supabase Storage respondió ${r.status}: ${await r.text().catch(() => '')}`);
      throw new AppError(502, 'ALMACENAMIENTO', 'No se pudo guardar el archivo; intenta de nuevo');
    }
  }

  /** Guarda un archivo público y devuelve su URL. */
  async publico(ruta: string, datos: Buffer, mime: string, baseUrl: string) {
    const s = this.supabase;
    if (s) {
      await this.subir(this.bucket, ruta, datos, mime, 'max-age=31536000');
      return `${s.base}/storage/v1/object/public/${this.bucket}/${ruta}`;
    }
    const destino = join(process.cwd(), 'uploads', ruta);
    await mkdir(dirname(destino), { recursive: true });
    await writeFile(destino, datos);
    return `${baseUrl}/uploads/${ruta}`;
  }

  /** Guarda un archivo privado. Devuelve la ruta (no una URL). */
  async privado(ruta: string, datos: Buffer, mime: string) {
    if (this.supabase) await this.subir(this.bucketPrivado, ruta, datos, mime, 'no-store');
    else {
      const destino = join(process.cwd(), 'privado', ruta);
      await mkdir(dirname(destino), { recursive: true });
      await writeFile(destino, datos);
    }
    return ruta;
  }

  /**
   * Enlace temporal a un archivo privado. Con Supabase es una URL firmada;
   * en disco (solo desarrollo) es un data: URL con el archivo.
   */
  async enlacePrivado(ruta: string, mime: string, minutos: number) {
    const expiraEn = new Date(Date.now() + minutos * 60000);
    const s = this.supabase;
    if (!s) {
      const datos = await readFile(join(process.cwd(), 'privado', ruta)).catch(() => null);
      if (!datos) throw new AppError(404, 'NO_ENCONTRADO', 'El archivo ya no existe');
      return { url: `data:${mime};base64,${datos.toString('base64')}`, expiraEn };
    }
    const r = await fetch(`${s.base}/storage/v1/object/sign/${this.bucketPrivado}/${ruta}`, {
      method: 'POST',
      headers: { ...s.h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: minutos * 60 }),
    });
    if (!r.ok) {
      this.log.error(`No se pudo firmar ${ruta}: ${r.status} ${await r.text().catch(() => '')}`);
      throw new AppError(502, 'ALMACENAMIENTO', 'No se pudo generar el enlace al archivo');
    }
    const { signedURL } = await r.json();
    return { url: `${s.base}/storage/v1${signedURL}`, expiraEn };
  }

  /** Borra archivos privados. Nunca lanza errores. */
  async borrarPrivados(rutas: string[]) {
    if (!rutas.length) return;
    try {
      const s = this.supabase;
      if (s) {
        await fetch(`${s.base}/storage/v1/object/${this.bucketPrivado}`, {
          method: 'DELETE',
          headers: { ...s.h, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefixes: rutas }),
        });
      } else {
        await Promise.all(rutas.map((r) => unlink(join(process.cwd(), 'privado', r)).catch(() => null)));
      }
    } catch (e) {
      this.log.warn(`No se pudieron borrar archivos privados: ${e.message}`);
    }
  }
}
