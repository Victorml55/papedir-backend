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

  @Get('usuarios/:id')
  usuario(@Param('id', UuidPipe) id: string) { return this.svc.detalle(id); }

  @Get('usuarios/:id/eventos')
  eventosUsuario(@Param('id', UuidPipe) id: string) { return this.svc.eventos(id); }

  @Post('usuarios/:id/desbloquear') @HttpCode(200)
  desbloquear(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.desbloquear(u, id); }

  @Post('usuarios/:id/aprobar') @HttpCode(200)
  aprobar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.aprobar(u, id); }

  @Post('usuarios/:id/banear') @HttpCode(200)
  banear(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: MotivoDto) { return this.svc.banear(u, id, dto.motivo); }

  @Post('usuarios/:id/desbanear') @HttpCode(200)
  desbanear(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.desbanear(u, id); }
}

@Roles('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly svc: SoporteService) {}

  @Post('usuarios')
  crear(@Actor() u: Usuario, @Body() dto: UsuarioInternoDto) { return this.svc.crearInterno(u, dto); }

  @Get('metricas')
  metricas(@Query() q: MetricasDto) { return this.svc.metricas(q); }
}
