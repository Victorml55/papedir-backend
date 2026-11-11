import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PedidosModule } from '../pedidos/pedidos.module';
import { TicketsModule } from '../tickets/tickets';
import { AdminController, SoporteController } from './soporte.controller';
import { SoporteService } from './soporte.service';

@Module({ imports: [PedidosModule, TicketsModule, AuthModule], controllers: [SoporteController, AdminController], providers: [SoporteService] })
export class SoporteModule {}
