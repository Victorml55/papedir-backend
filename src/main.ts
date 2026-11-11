import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { readFileSync } from 'fs';
import helmet from 'helmet';
import { join } from 'path';
import * as swaggerUi from 'swagger-ui-express';
import { parse } from 'yaml';
import { AppModule } from './app.module';
import { errorDeValidacion } from './common/errores';

/** Configuración compartida por la API y las pruebas e2e. */
export function configurar(app: INestApplication) {
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, exceptionFactory: errorDeValidacion }));
}

async function bootstrap() {
  if (!process.env.JWT_SECRET || !process.env.DATABASE_URL) {
    // ConfigModule aún no cargó .env en este punto: lo cargamos para poder validar.
    try { process.loadEnvFile('.env'); } catch { /* sin .env */ }
  }
  for (const v of ['JWT_SECRET', 'DATABASE_URL']) {
    if (!process.env[v]) throw new Error(`Falta la variable de entorno ${v} (revisa .env.example)`);
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.set('trust proxy', 1); // Render está detrás de un proxy: necesario para limitar por IP real
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.enableCors({
    origin: (process.env.FRONTEND_URL ?? '').split(',').map((o) => o.trim()).filter(Boolean),
    credentials: true,
  });
  configurar(app);

  // Imágenes locales (solo cuando no hay Supabase Storage configurado).
  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads' });

  // Swagger muestra el contrato tal cual (docs/openapi.yaml): la documentación nunca se desvía de él.
  const contrato = parse(readFileSync(join(process.cwd(), 'docs', 'openapi.yaml'), 'utf8'));
  contrato.servers = [{ url: '/api/v1' }];
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(contrato, { customSiteTitle: 'PaPedir API' }));
  app.getHttpAdapter().get('/api/docs-json', (_req: unknown, res: { json: (c: unknown) => void }) => res.json(contrato));

  const puerto = process.env.PORT || 3000;
  await app.listen(puerto, '0.0.0.0');
  new Logger('PaPedir').log(`API en http://localhost:${puerto}/api/v1 · documentación en /api/docs`);
}

if (require.main === module) void bootstrap();
