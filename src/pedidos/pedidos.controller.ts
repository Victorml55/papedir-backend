import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Actor, Roles } from '../common/auth';
import { MotivoDto } from '../common/dtos';
import { UuidPipe } from '../common/util';
import { Usuario } from '../database/entities';
import { CalificacionDto, CotizarManualDto, CotizarPedidoDto, CrearPedidoDto, ListarPedidosDto, PedidoManualDto } from './pedidos.dto';
import { PedidosService } from './pedidos.service';

@Controller('pedidos')
export class PedidosController {
  constructor(private readonly svc: PedidosService) {}

  @Get()
  listar(@Actor() u: Usuario, @Query() q: ListarPedidosDto) { return this.svc.listar(u, q); }

  @Roles('cliente') @Post('cotizar') @HttpCode(200)
  cotizar(@Actor() u: Usuario, @Body() dto: CotizarPedidoDto) { return this.svc.cotizar(u, dto); }

  @Roles('tienda') @Post('cotizar-manual') @HttpCode(200)
  cotizarManual(@Actor() u: Usuario, @Body() dto: CotizarManualDto) { return this.svc.cotizarManual(u, dto); }

  @Roles('tienda') @Post('manual')
  crearManual(@Actor() u: Usuario, @Body() dto: PedidoManualDto) { return this.svc.crearManual(u, dto); }

  @Roles('cliente') @Post()
  crear(@Actor() u: Usuario, @Body() dto: CrearPedidoDto) { return this.svc.crear(u, dto); }

  @Get(':id')
  detalle(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.detalle(u, id); }

  @Get(':id/eventos')
  eventos(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.bitacora(u, id); }

  @Roles('tienda') @Post(':id/aceptar') @HttpCode(200)
  aceptar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.aceptar(u, id); }

  @Roles('tienda') @Post(':id/rechazar') @HttpCode(200)
  rechazar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: MotivoDto) { return this.svc.rechazar(u, id, dto.motivo); }

  @Roles('tienda') @Post(':id/listo') @HttpCode(200)
  listo(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.marcarListo(u, id); }

  @Roles('cliente', 'tienda') @Post(':id/cancelar') @HttpCode(200)
  cancelar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: MotivoDto) { return this.svc.cancelar(u, id, dto.motivo); }

  @Roles('cliente') @Post(':id/calificar')
  calificar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: CalificacionDto) { return this.svc.calificar(u, id, dto); }
}
