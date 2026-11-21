import { documentosDe, EsTipoDocumento, nombreDocumento } from '../config/catalogos';
import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsBoolean, IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { Actor, Roles } from '../common/auth';
import { conflicto, invalido, noEncontrado, sinPermiso } from '../common/errores';
import { UuidPipe } from '../common/util';
import { REGLAS } from '../config/reglas';
import { Documento, Usuario } from '../database/entities';
import { AlmacenService } from '../nucleo/almacen.service';
import { BitacoraCuentasService } from '../nucleo/bitacora-cuentas.service';
import { PushService } from '../nucleo/push.service';
import { EXT, subidaArchivo } from '../uploads/uploads';

const D = REGLAS.documentos;

export class DocumentoDto {
  @EsTipoDocumento() tipo: string;
}

export class RevisionDto {
  @IsBoolean() aprobado: boolean;
  /** Obligatorio al rechazar: el usuario lo ve para saber qué corregir. */
  @ValidateIf((o) => o.aprobado === false) @IsString() @IsNotEmpty() @MaxLength(300) motivo?: string;
}

export const vistaDocumento = (d: Documento) => ({
  id: d.id, tipo: d.tipo, nombre: nombreDocumento(d.tipo), estado: d.estado, motivo: d.motivo,
  creadoEn: d.creadoEn, revisadoEn: d.revisadoEn,
});

@Injectable()
export class DocumentosService {
  constructor(
    @InjectRepository(Documento) private readonly docs: Repository<Documento>,
    @InjectRepository(Usuario) private readonly usuarios: Repository<Usuario>,
    private readonly almacen: AlmacenService,
    private readonly bitacora: BitacoraCuentasService,
    private readonly push: PushService,
  ) {}

  /** Sube o reemplaza un documento. Uno por tipo; al reemplazarlo vuelve a quedar pendiente de revisión. */
  async subir(u: Usuario, tipo: string, archivo: Express.Multer.File) {
    const permitidos = documentosDe(u.rol).map((d) => d.tipo);
    if (!permitidos.includes(tipo)) throw invalido(`Tu cuenta no usa el documento "${tipo}"`, 'tipo');
    if (!archivo) throw invalido('Falta el archivo', 'archivo');
    if (!D.mimes.includes(archivo.mimetype as any)) throw invalido('Solo se aceptan JPG, PNG, WebP o PDF', 'archivo');

    const anterior = await this.docs.findOneBy({ usuarioId: u.id, tipo });
    if (anterior?.estado === 'aprobado') throw conflicto('DOCUMENTO_APROBADO', 'Este documento ya fue aprobado; pide a soporte si necesitas cambiarlo');
    const ruta = await this.almacen.privado(`${u.id}/${tipo}-${randomUUID()}.${EXT[archivo.mimetype]}`, archivo.buffer, archivo.mimetype);
    const doc = await this.docs.save(
      Object.assign(anterior ?? this.docs.create({ usuarioId: u.id, tipo }), {
        ruta, mime: archivo.mimetype, estado: 'pendiente' as const, motivo: null, revisadoPor: null, revisadoEn: null, creadoEn: new Date(),
      }),
    );
    if (anterior) void this.almacen.borrarPrivados([anterior.ruta]);
    return vistaDocumento(doc);
  }

  async mios(u: Usuario) {
    const tipos = documentosDe(u.rol).map((d) => d.tipo);
    const requeridos = documentosDe(u.rol).filter((d) => d.obligatorio).map((d) => d.tipo);
    const subidos = await this.docs.findBy({ usuarioId: u.id });
    return tipos.map((tipo) => {
      const d = subidos.find((x) => x.tipo === tipo);
      return { tipo, nombre: nombreDocumento(tipo), requerido: requeridos.includes(tipo), documento: d ? vistaDocumento(d) : null };
    });
  }

  async deUsuario(usuarioId: string) {
    if (!(await this.usuarios.existsBy({ id: usuarioId }))) throw noEncontrado('Usuario no encontrado');
    return (await this.docs.find({ where: { usuarioId }, order: { creadoEn: 'ASC' } })).map(vistaDocumento);
  }

  private async porId(id: string) {
    const d = await this.docs.findOneBy({ id });
    if (!d) throw noEncontrado('Documento no encontrado');
    return d;
  }

  async enlace(agente: Usuario, id: string) {
    const d = await this.porId(id);
    if (agente.rol !== 'soporte' && agente.rol !== 'admin') throw sinPermiso();
    return this.almacen.enlacePrivado(d.ruta, d.mime, D.minutosEnlace);
  }

  async revisar(agente: Usuario, id: string, dto: RevisionDto) {
    const d = await this.porId(id);
    Object.assign(d, {
      estado: dto.aprobado ? 'aprobado' : 'rechazado', motivo: dto.aprobado ? null : dto.motivo.trim(),
      revisadoPor: agente.id, revisadoEn: new Date(),
    });
    await this.docs.save(d);
    const nombre = nombreDocumento(d.tipo);
    await this.bitacora.registrar(d.usuarioId, dto.aprobado ? 'documento_aprobado' : 'documento_rechazado', agente, `${nombre}${d.motivo ? `: ${d.motivo}` : ''}`);
    void this.push.aUsuarios(
      [d.usuarioId], dto.aprobado ? 'Documento aprobado' : 'Revisa tu documento',
      dto.aprobado ? `Tu ${nombre} fue aprobado` : `Tu ${nombre} fue rechazado: ${d.motivo}`, { documentoId: d.id },
    );
    return vistaDocumento(d);
  }

  /** ¿Tiene aprobados todos los documentos requeridos para su rol? */
  async completos(u: Pick<Usuario, 'id' | 'rol'>) {
    const requeridos = documentosDe(u.rol).filter((d) => d.obligatorio).map((d) => d.tipo);
    if (!requeridos.length) return true;
    const aprobados = await this.docs.findBy({ usuarioId: u.id, estado: 'aprobado' });
    return requeridos.every((t) => aprobados.some((d) => d.tipo === t));
  }
}

@Controller()
export class DocumentosController {
  constructor(private readonly svc: DocumentosService) {}

  @Roles('repartidor', 'tienda') @Post('documentos')
  @UseInterceptors(subidaArchivo())
  subir(@Actor() u: Usuario, @UploadedFile() archivo: Express.Multer.File, @Body() dto: DocumentoDto) {
    return this.svc.subir(u, dto.tipo, archivo);
  }

  @Roles('repartidor', 'tienda') @Get('documentos')
  mios(@Actor() u: Usuario) { return this.svc.mios(u); }

  @Roles('soporte', 'admin') @Get('soporte/usuarios/:id/documentos')
  deUsuario(@Param('id', UuidPipe) id: string) { return this.svc.deUsuario(id); }

  @Roles('soporte', 'admin') @Get('soporte/documentos/:id/archivo')
  enlace(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.enlace(u, id); }

  @Roles('soporte', 'admin') @Post('soporte/documentos/:id/revisar') @HttpCode(200)
  revisar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: RevisionDto) { return this.svc.revisar(u, id, dto); }
}

@Module({ controllers: [DocumentosController], providers: [DocumentosService], exports: [DocumentosService] })
export class DocumentosModule {}
