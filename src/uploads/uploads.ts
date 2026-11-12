import { Body, Controller, Injectable, Logger, Module, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsIn } from 'class-validator';
import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { memoryStorage } from 'multer';
import { join } from 'path';
import { AppError, invalido } from '../common/errores';
import { REGLAS } from '../config/reglas';

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export class SubidaDto {
  @IsIn(['producto', 'tienda', 'evidencia']) tipo: string;
}

/**
 * Guarda imágenes en Supabase Storage (solo el backend tiene la llave) y devuelve la URL pública.
 * Sin SUPABASE_URL/SUPABASE_SERVICE_KEY guarda en ./uploads, que la API sirve en /uploads (solo desarrollo).
 */
/**
 * Las llaves nuevas de Supabase (sb_secret_...) no son JWT: van solo en el header apikey.
 * La llave antigua service_role (un JWT) va en apikey y en Authorization.
 */
export const cabecerasSupabase = (llave: string): Record<string, string> =>
  llave.startsWith('sb_') ? { apikey: llave } : { apikey: llave, Authorization: `Bearer ${llave}` };

@Injectable()
export class UploadsService {
  private readonly log = new Logger('Uploads');

  async subir(archivo: Express.Multer.File, tipo: string, baseUrl: string) {
    if (!archivo) throw invalido('Falta el archivo', 'archivo');
    if (!REGLAS.upload.mimes.includes(archivo.mimetype as any)) throw invalido('Solo se aceptan imágenes JPG, PNG o WebP', 'archivo');
    const ruta = `${tipo}s/${randomUUID()}.${EXT[archivo.mimetype]}`;

    const { SUPABASE_URL: url, SUPABASE_SERVICE_KEY: llave, SUPABASE_BUCKET: bucket = 'papedir' } = process.env;
    if (url && llave) {
      const base = url.replace(/\/+$/, '');
      const r = await fetch(`${base}/storage/v1/object/${bucket}/${ruta}`, {
        method: 'POST',
        headers: { ...cabecerasSupabase(llave), 'Content-Type': archivo.mimetype, 'Cache-Control': 'max-age=31536000' },
        body: new Uint8Array(archivo.buffer),
      });
      if (!r.ok) {
        this.log.error(`Supabase Storage respondió ${r.status}: ${await r.text().catch(() => '')}`);
        throw new AppError(502, 'ALMACENAMIENTO', 'No se pudo guardar la imagen; intenta de nuevo');
      }
      return { url: `${base}/storage/v1/object/public/${bucket}/${ruta}` };
    }
    const destino = join(process.cwd(), 'uploads', ruta);
    await mkdir(join(destino, '..'), { recursive: true });
    await writeFile(destino, archivo.buffer);
    return { url: `${baseUrl}/uploads/${ruta}` };
  }
}

@Controller('uploads')
export class UploadsController {
  constructor(private readonly svc: UploadsService) {}

  @Post()
  @UseInterceptors(FileInterceptor('archivo', { storage: memoryStorage(), limits: { fileSize: REGLAS.upload.maxBytes } }))
  subir(@UploadedFile() archivo: Express.Multer.File, @Body() dto: SubidaDto) {
    const base = process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
    return this.svc.subir(archivo, dto.tipo, base);
  }
}

@Module({ controllers: [UploadsController], providers: [UploadsService] })
export class UploadsModule {}
