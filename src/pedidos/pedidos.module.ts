import { Module } from '@nestjs/common';
import { PedidosController } from './pedidos.controller';
import { PedidosService } from './pedidos.service';
import { TareasService } from './tareas.service';
import { ChatPedidoService } from './chat.service';

@Module({ controllers: [PedidosController], providers: [PedidosService, TareasService, ChatPedidoService], exports: [PedidosService, TareasService] })
export class PedidosModule {}
