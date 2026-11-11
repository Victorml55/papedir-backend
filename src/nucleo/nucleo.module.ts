import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ENTIDADES } from '../database/entities';
import { EnvioService } from './envio.service';
import { PushService } from './push.service';
import { RealtimeService } from './realtime.service';

/** Servicios compartidos por todos los módulos: repositorios, JWT, tiempo real, push y cálculo de envío. */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature(ENTIDADES),
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_SECRET,
        signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN ?? '15m') as any },
      }),
    }),
  ],
  providers: [RealtimeService, PushService, EnvioService],
  exports: [TypeOrmModule, JwtModule, RealtimeService, PushService, EnvioService],
})
export class NucleoModule {}
