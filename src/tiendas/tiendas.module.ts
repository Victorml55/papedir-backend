import { Module } from '@nestjs/common';
import { TiendasController } from './tiendas.controller';
import { TiendasService } from './tiendas.service';

@Module({ controllers: [TiendasController], providers: [TiendasService], exports: [TiendasService] })
export class TiendasModule {}
