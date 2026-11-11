import { Module } from '@nestjs/common';
import { PedidosModule } from '../pedidos/pedidos.module';
import { RepartidorController } from './repartidor.controller';
import { RepartidorService } from './repartidor.service';

@Module({ imports: [PedidosModule], controllers: [RepartidorController], providers: [RepartidorService], exports: [RepartidorService] })
export class RepartidorModule {}
