import { Module } from '@nestjs/common';
import { PedidosModule } from '../pedidos/pedidos.module';
import { RepartidorModule } from '../repartidor/repartidor.module';
import { TicketsModule } from '../tickets/tickets';
import { RealtimeGateway } from './realtime.gateway';

@Module({ imports: [PedidosModule, RepartidorModule, TicketsModule], providers: [RealtimeGateway] })
export class RealtimeModule {}
