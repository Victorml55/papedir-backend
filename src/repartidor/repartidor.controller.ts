import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Actor, Roles } from '../common/auth';
import { CoordenadasDto, PaginaDto } from '../common/dtos';
import { UuidPipe } from '../common/util';
import { Usuario } from '../database/entities';
import { DisponibilidadDto, DisponiblesDto, EntregaDto, MarcaDto } from './repartidor.dto';
import { RepartidorService } from './repartidor.service';

@Roles('repartidor')
@Controller('repartidor')
export class RepartidorController {
  constructor(private readonly svc: RepartidorService) {}

  @Patch('disponibilidad')
  disponibilidad(@Actor() u: Usuario, @Body() dto: DisponibilidadDto) { return this.svc.cambiarDisponibilidad(u, dto.disponible); }

  @Put('ubicacion') @HttpCode(204)
  ubicacion(@Actor() u: Usuario, @Body() dto: CoordenadasDto) { return this.svc.reportarUbicacion(u.id, dto); }

  @Get('pedidos-disponibles')
  disponibles(@Actor() u: Usuario, @Query() q: DisponiblesDto) { return this.svc.disponibles(u, q); }

  @Post('pedidos/:id/tomar') @HttpCode(200)
  tomar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.tomar(u, id); }

  /** 200 con el viaje, o 204 si no hay viaje activo. */
  @Get('viaje-actual')
  async viaje(@Actor() u: Usuario, @Res({ passthrough: true }) res: Response) {
    const viaje = await this.svc.viajeActual(u);
    if (!viaje) res.status(204);
    return viaje ?? undefined;
  }

  @Post('pedidos/:id/llegada-tienda') @HttpCode(200)
  llegadaTienda(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: MarcaDto) { return this.svc.llegadaTienda(u, id, dto.ubicacion); }

  @Post('pedidos/:id/salida-tienda') @HttpCode(200)
  salidaTienda(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: MarcaDto) { return this.svc.salidaTienda(u, id, dto.ubicacion); }

  @Post('pedidos/:id/llegada-cliente') @HttpCode(200)
  llegadaCliente(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: MarcaDto) { return this.svc.llegadaCliente(u, id, dto.ubicacion); }

  @Post('pedidos/:id/entregado') @HttpCode(200)
  entregado(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: EntregaDto) { return this.svc.entregar(u, id, dto); }

  @Get('historial')
  historial(@Actor() u: Usuario, @Query() q: PaginaDto) { return this.svc.historial(u, q); }
}
