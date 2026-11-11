import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthModule } from './auth/auth.module';
import { AuthGuard, Publico } from './common/auth';
import { FiltroErrores } from './common/errores';
import { opcionesBD } from './database/data-source';
import { DireccionesModule } from './direcciones/direcciones';
import { NucleoModule } from './nucleo/nucleo.module';
import { PedidosModule } from './pedidos/pedidos.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RepartidorModule } from './repartidor/repartidor.module';
import { SoporteModule } from './soporte/soporte.module';
import { TicketsModule } from './tickets/tickets';
import { TiendasModule } from './tiendas/tiendas.module';
import { UploadsModule } from './uploads/uploads';

@Controller()
export class HealthController {
  constructor(private readonly ds: DataSource) {}

  /** Render lo usa como health check: responde 200 solo si la base de datos contesta. */
  @Publico()
  @Get('health')
  async health() {
    await this.ds.query('SELECT 1');
    return { status: 'ok' };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({ useFactory: opcionesBD }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60000, limit: 300 }], // 300 peticiones por minuto por IP
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    NucleoModule,
    AuthModule,
    DireccionesModule,
    TiendasModule,
    UploadsModule,
    PedidosModule,
    RepartidorModule,
    TicketsModule,
    SoporteModule,
    RealtimeModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: FiltroErrores },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
