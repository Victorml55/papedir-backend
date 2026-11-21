import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { ENTIDADES } from './entities';
import { Inicial1731300000000 } from './migrations/1731300000000-Inicial';
import { RlsMigraciones1731400000000 } from './migrations/1731400000000-RlsMigraciones';
import { CuentasSeguridad1731500000000 } from './migrations/1731500000000-CuentasSeguridad';
import { RepartidorTienda1731600000000 } from './migrations/1731600000000-RepartidorTienda';
import { ClienteNegocio1731700000000 } from './migrations/1731700000000-ClienteNegocio';
import { FirebaseAuth1731800000000 } from './migrations/1731800000000-FirebaseAuth';
import { PanelAdmin1732000000000 } from './migrations/1732000000000-PanelAdmin';
import { TiendasAdmin1732100000000 } from './migrations/1732100000000-TiendasAdmin';
import { CarteraSolicitudes1732200000000 } from './migrations/1732200000000-CarteraSolicitudes';
import { PagosStripe1731900000000 } from './migrations/1731900000000-PagosStripe';

try {
  process.loadEnvFile?.('.env'); // para los scripts (migraciones, seed); en la API lo carga ConfigModule
} catch {
  /* sin .env: se usan las variables del entorno */
}

export const opcionesBD = (): DataSourceOptions => ({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  // Los ids los genera la BD con gen_random_uuid(); no hace falta instalar uuid-ossp.
  installExtensions: false,
  // Conexiones simultáneas a la BD. El pooler de Supabase gratis admite pocas; 10 sobra para un servicio.
  extra: { max: Number(process.env.DATABASE_POOL_MAX ?? 10) },
  entities: ENTIDADES,
  migrations: [Inicial1731300000000, RlsMigraciones1731400000000, CuentasSeguridad1731500000000, RepartidorTienda1731600000000, ClienteNegocio1731700000000, FirebaseAuth1731800000000, PagosStripe1731900000000, PanelAdmin1732000000000, TiendasAdmin1732100000000, CarteraSolicitudes1732200000000],
  namingStrategy: new SnakeNamingStrategy(),
  synchronize: false, // el esquema solo cambia con migraciones
  migrationsRun: true, // al arrancar aplica las migraciones pendientes
});

export default new DataSource(opcionesBD());
