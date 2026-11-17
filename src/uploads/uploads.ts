import { Body, Controller, Module, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsIn } from 'class-validator';
import { randomUUID } from 'crypto';
import { memoryStorage } from 'multer';
import { invalido } from '../common/errores';
import { REGLAS } from '../config/reglas';
import { AlmacenService } from '../nucleo/almacen.service';

export { cabecerasSupabase } from '../nucleo/almacen.service';

export const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
export const baseUrl = () => process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
export const subidaArchivo = () => FileInterceptor('archivo', { storage: memoryStorage(), limits: { fileSize: REGLAS.upload.maxBytes } });

export class SubidaDto {
  @IsIn(['producto', 'tienda', 'evidencia', 'perfil']) tipo: string;
}

/** Imágenes públicas (productos, tiendas, perfil, evidencia de entrega). Los documentos privados van en /documentos. */
@Controller('uploads')
export class UploadsController {
  constructor(private readonly almacen: AlmacenService) {}

  @Post()
  @UseInterceptors(subidaArchivo())
  async subir(@UploadedFile() archivo: Express.Multer.File, @Body() dto: SubidaDto) {
    if (!archivo) throw invalido('Falta el archivo', 'archivo');
    if (!REGLAS.upload.mimes.includes(archivo.mimetype as any)) throw invalido('Solo se aceptan imágenes JPG, PNG o WebP', 'archivo');
    const ruta = `${dto.tipo}s/${randomUUID()}.${EXT[archivo.mimetype]}`;
    return { url: await this.almacen.publico(ruta, archivo.buffer, archivo.mimetype, baseUrl()) };
  }
}

@Module({ controllers: [UploadsController] })
export class UploadsModule {}
