import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ENTIDADES } from '../database/entities';
import { AlmacenService } from './almacen.service';
import { FirebaseService } from './firebase.service';
import { PagosService } from './pagos.service';
import { RutasService } from './rutas.service';
import { BitacoraCuentasService } from './bitacora-cuentas.service';
import { ConfiguracionService } from './configuracion.service';
import { CuponesService } from '../cupones/cupones.service';
import { FinanzasService } from '../finanzas/finanzas.service';
import { CorreoService } from './correo.service';
import { EnvioService } from './envio.service';
import { PushService } from './push.service';
import { RealtimeService } from './realtime.service';

/** Servicios compartidos por todos los módulos: repositorios, JWT, tiempo real, push, correo, bitácora de cuentas y cálculo de envío. */
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
  providers: [RealtimeService, PushService, EnvioService, CorreoService, BitacoraCuentasService, AlmacenService, ConfiguracionService, CuponesService, FinanzasService, FirebaseService, PagosService, RutasService],
  exports: [TypeOrmModule, JwtModule, RealtimeService, PushService, EnvioService, CorreoService, BitacoraCuentasService, AlmacenService, ConfiguracionService, CuponesService, FinanzasService, FirebaseService, PagosService, RutasService],
})
export class NucleoModule {}
