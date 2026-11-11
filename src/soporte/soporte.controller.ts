import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Actor, Roles } from '../common/auth';
import { MotivoDto } from '../common/dtos';
import { UuidPipe } from '../common/util';
import { Usuario } from '../database/entities';
import { TicketsService } from '../tickets/tickets';
import { AtenderTicketDto, BuscarPedidosDto, BuscarUsuariosDto, CorregirUbicacionDto, MetricasDto, UsuarioInternoDto } from './soporte.dto';
import { SoporteService } from './soporte.service';

@Roles('soporte', 'admin')
@Controller('soporte')
export class SoporteController {
  constructor(private readonly svc: SoporteService, private readonly tickets: TicketsService) {}

  @Get('pedidos')
  pedidos(@Actor() u: Usuario, @Query() q: BuscarPedidosDto) { return this.svc.buscarPedidos(u, q); }

  @Post('pedidos/:id/cancelar') @HttpCode(200)
  cancelar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: MotivoDto) { return this.svc.cancelar(u, id, dto.motivo); }

  @Post('pedidos/:id/completar') @HttpCode(200)
  completar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: MotivoDto) { return this.svc.completar(u, id, dto.motivo); }

  @Post('pedidos/:id/liberar') @HttpCode(200)
  liberar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: MotivoDto) { return this.svc.liberar(u, id, dto.motivo); }

  @Patch('pedidos/:id/ubicacion')
  ubicacion(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: CorregirUbicacionDto) { return this.svc.corregirUbicacion(u, id, dto); }

  @Patch('tickets/:id')
  atender(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: AtenderTicketDto) { return this.tickets.atender(id, u, dto); }

  @Get('usuarios')
  usuarios(@Query() q: BuscarUsuariosDto) { return this.svc.buscarUsuarios(q); }

  @Post('usuarios/:id/aprobar') @HttpCode(200)
  aprobar(@Param('id', UuidPipe) id: string) { return this.svc.aprobar(id); }

  @Post('usuarios/:id/banear') @HttpCode(200)
  banear(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: MotivoDto) { return this.svc.banear(u, id, dto.motivo); }

  @Post('usuarios/:id/desbanear') @HttpCode(200)
  desbanear(@Param('id', UuidPipe) id: string) { return this.svc.desbanear(id); }
}

@Roles('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly svc: SoporteService) {}

  @Post('usuarios')
  crear(@Body() dto: UsuarioInternoDto) { return this.svc.crearInterno(dto); }

  @Get('metricas')
  metricas(@Query() q: MetricasDto) { return this.svc.metricas(q); }
}
