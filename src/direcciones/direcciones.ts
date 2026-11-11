import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, Patch, Post } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Repository } from 'typeorm';
import { Actor, Roles } from '../common/auth';
import { CoordenadasDto } from '../common/dtos';
import { noEncontrado } from '../common/errores';
import { UuidPipe } from '../common/util';
import { Direccion, Usuario } from '../database/entities';

export class DireccionDto {
  @IsString() @IsNotEmpty() @MaxLength(40) alias: string;
  @IsString() @IsNotEmpty() @MaxLength(200) texto: string;
  @IsOptional() @IsString() @MaxLength(200) referencias?: string | null;
  @ValidateNested() @Type(() => CoordenadasDto) ubicacion: CoordenadasDto;
}

export const vistaDireccion = (d: Direccion) => ({
  id: d.id,
  alias: d.alias,
  texto: d.texto,
  referencias: d.referencias,
  ubicacion: { lat: d.lat, lng: d.lng },
});

@Injectable()
export class DireccionesService {
  constructor(@InjectRepository(Direccion) private readonly repo: Repository<Direccion>) {}

  async listar(clienteId: string) {
    return (await this.repo.find({ where: { clienteId }, order: { creadoEn: 'ASC' } })).map(vistaDireccion);
  }

  /** Solo devuelve la dirección si es del cliente. */
  async propia(id: string, clienteId: string) {
    const d = await this.repo.findOneBy({ id, clienteId });
    if (!d) throw noEncontrado('Dirección no encontrada');
    return d;
  }

  async guardar(clienteId: string, dto: DireccionDto, id?: string) {
    const d = id ? await this.propia(id, clienteId) : this.repo.create({ clienteId });
    Object.assign(d, {
      alias: dto.alias, texto: dto.texto, referencias: dto.referencias ?? null,
      lat: dto.ubicacion.lat, lng: dto.ubicacion.lng,
    });
    return vistaDireccion(await this.repo.save(d));
  }

  async eliminar(id: string, clienteId: string) {
    await this.repo.remove(await this.propia(id, clienteId));
  }
}

@Roles('cliente')
@Controller('direcciones')
export class DireccionesController {
  constructor(private readonly svc: DireccionesService) {}

  @Get() listar(@Actor() u: Usuario) { return this.svc.listar(u.id); }
  @Post() crear(@Actor() u: Usuario, @Body() dto: DireccionDto) { return this.svc.guardar(u.id, dto); }
  @Patch(':id') editar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: DireccionDto) { return this.svc.guardar(u.id, dto, id); }
  @Delete(':id') @HttpCode(204) eliminar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.eliminar(id, u.id); }
}

@Module({ controllers: [DireccionesController], providers: [DireccionesService], exports: [DireccionesService] })
export class DireccionesModule {}
