import { Module } from '@nestjs/common';
import { PedidosController } from './pedidos.controller';
import { PedidosService } from './pedidos.service';
import { TareasService } from './tareas.service';

@Module({ controllers: [PedidosController], providers: [PedidosService, TareasService], exports: [PedidosService, TareasService] })
export class PedidosModule {}
