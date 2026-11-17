import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Actor, Roles, TiendaSel } from '../common/auth';
import { UuidPipe } from '../common/util';
import { Usuario } from '../database/entities';
import {
  CalificacionDto, CotizarManualDto, CotizarPedidoDto, CrearPedidoDto, GrupoPedidosDto, ListarPedidosDto, MensajePedidoDto, MotivoCancelacionDto,
  PedidoManualDto, RespuestaResenaDto,
} from './pedidos.dto';
import { ChatPedidoService } from './chat.service';
import { PedidosService } from './pedidos.service';

@Controller('pedidos')
export class PedidosController {
  constructor(
    private readonly svc: PedidosService,
    private readonly chat: ChatPedidoService,
  ) {}

  @Get()
  listar(@Actor() u: Usuario, @Query() q: ListarPedidosDto, @TiendaSel() t?: string) { return this.svc.listar(u, q, false, t); }

  @Roles('cliente') @Post('cotizar') @HttpCode(200)
  cotizar(@Actor() u: Usuario, @Body() dto: CotizarPedidoDto) { return this.svc.cotizar(u, dto); }

  @Roles('tienda') @Post('cotizar-manual') @HttpCode(200)
  cotizarManual(@Actor() u: Usuario, @Body() dto: CotizarManualDto, @TiendaSel() t?: string) { return this.svc.cotizarManual(u, dto, t); }

  @Roles('tienda') @Post('manual')
  crearManual(@Actor() u: Usuario, @Body() dto: PedidoManualDto, @TiendaSel() t?: string) { return this.svc.crearManual(u, dto, t); }

  @Roles('cliente') @Post()
  crear(@Actor() u: Usuario, @Body() dto: CrearPedidoDto) { return this.svc.crear(u, dto); }

  /** Carrito con productos de 2 o 3 tiendas. */
  @Roles('cliente') @Post('grupo')
  crearGrupo(@Actor() u: Usuario, @Body() dto: GrupoPedidosDto) { return this.svc.crearGrupo(u, dto); }

  @Get(':id')
  detalle(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.detalle(u, id); }

  @Get(':id/eventos')
  eventos(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.bitacora(u, id); }

  @Roles('tienda') @Post(':id/aceptar') @HttpCode(200)
  aceptar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.aceptar(u, id); }

  @Roles('tienda') @Post(':id/rechazar') @HttpCode(200)
  rechazar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: MotivoCancelacionDto) { return this.svc.rechazar(u, id, dto); }

  @Roles('tienda') @Post(':id/listo') @HttpCode(200)
  listo(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.marcarListo(u, id); }

  @Roles('cliente', 'tienda') @Post(':id/cancelar') @HttpCode(200)
  cancelar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: MotivoCancelacionDto) { return this.svc.cancelar(u, id, dto); }

  @Roles('cliente') @Post(':id/calificar')
  calificar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: CalificacionDto) { return this.svc.calificar(u, id, dto); }

  /** Arma un carrito con lo de un pedido anterior, con precios y opciones de hoy. */
  @Roles('cliente') @Post(':id/repetir') @HttpCode(200)
  repetir(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.repetir(u, id); }

  @Roles('tienda') @Post(':id/calificacion/respuesta') @HttpCode(200)
  responder(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: RespuestaResenaDto) { return this.svc.responderResena(u, id, dto.texto); }

  @Get(':id/mensajes')
  mensajes(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.chat.listar(u, id); }

  @Post(':id/mensajes')
  enviar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: MensajePedidoDto) { return this.chat.enviar(u, id, dto.texto); }
}
