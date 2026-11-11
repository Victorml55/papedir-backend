import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { ENTIDADES } from './entities';
import { Inicial1731300000000 } from './migrations/1731300000000-Inicial';

try {
  process.loadEnvFile?.('.env'); // para los scripts (migraciones, seed); en la API lo carga ConfigModule
} catch {
  /* sin .env: se usan las variables del entorno */
}

export const opcionesBD = (): DataSourceOptions => ({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  entities: ENTIDADES,
  migrations: [Inicial1731300000000],
  namingStrategy: new SnakeNamingStrategy(),
  synchronize: false, // el esquema solo cambia con migraciones
  migrationsRun: true, // al arrancar aplica las migraciones pendientes
});

export default new DataSource(opcionesBD());
