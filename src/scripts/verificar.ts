/**
 * Revisa que la configuración (.env o variables del entorno) funcione de verdad:
 *   npm run verificar                          base de datos, PostGIS, JWT, CORS, Storage y Firebase
 *   npm run verificar -- --configurar-bucket   además crea/ajusta el bucket de Supabase Storage
 *   npm run verificar -- --push <fcmToken>     además envía una notificación de prueba a ese dispositivo
 * Sale con código 1 si algo obligatorio falla.
 */
import { App, cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { Client } from 'pg';
import { REGLAS } from '../config/reglas';
import { cabecerasSupabase } from '../uploads/uploads';

try {
  process.loadEnvFile('.env');
} catch {
  /* sin .env: se usan las variables del entorno */
}

const args = process.argv.slice(2);
const arg = (nombre: string) => {
  const i = args.indexOf(nombre);
  return i >= 0 ? args[i + 1] : undefined;
};

let fallas = 0;
const ok = (m: string) => console.log(`  ✓ ${m}`);
const aviso = (m: string) => console.log(`  ! ${m}`);
const falla = (m: string) => {
  fallas++;
  console.log(`  ✗ ${m}`);
};
const seccion = (t: string) => console.log(`\n${t}`);

async function baseDeDatos() {
  seccion('Base de datos');
  const url = process.env.DATABASE_URL;
  if (!url) return falla('Falta DATABASE_URL');

  let host = '';
  let puerto = '';
  try {
    const u = new URL(url);
    host = u.hostname;
    puerto = u.port || '5432';
  } catch {
    return falla('DATABASE_URL no es una URL válida (¿la contraseña tiene caracteres especiales sin codificar?)');
  }
  const esSupabase = host.endsWith('supabase.com') || host.endsWith('supabase.co');
  if (esSupabase) {
    if (host.startsWith('db.')) {
      falla('Es la conexión directa de Supabase (solo IPv6): Render no puede usarla. Copia la del pooler (Transaction pooler, puerto 6543)');
    } else if (host.includes('pooler')) {
      ok(`Pooler de Supabase en el puerto ${puerto} (${puerto === '6543' ? 'modo transacción' : 'modo sesión'})`);
    }
    if (process.env.DATABASE_SSL !== 'true') falla('Con Supabase pon DATABASE_SSL=true');
  }

  const cliente = new Client({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10000,
  });
  try {
    await cliente.connect();
  } catch (e) {
    return falla(`No se pudo conectar: ${e.message}`);
  }
  try {
    const [{ version }] = (await cliente.query('SHOW server_version')).rows.map((r) => ({ version: r.server_version }));
    ok(`Conectado (PostgreSQL ${version})`);

    const postgis = (await cliente.query(
      `SELECT n.nspname AS esquema, e.extversion AS version FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'postgis'`,
    )).rows[0];
    if (!postgis) aviso('PostGIS no está instalado todavía; la API lo instala al arrancar la primera vez');
    else {
      ok(`PostGIS ${postgis.version} en el esquema "${postgis.esquema}"`);
      if (esSupabase && postgis.esquema === 'public') {
        aviso('En Supabase se recomienda PostGIS en "extensions"; en "public" el Security Advisor marcará spatial_ref_sys');
      }
      try {
        await cliente.query(`SELECT ST_Distance(ST_SetSRID(ST_MakePoint(-100.81, 20.52), 4326)::geography,
                                               ST_SetSRID(ST_MakePoint(-100.80, 20.53), 4326)::geography)`);
        ok('Las funciones de PostGIS se resuelven desde el search_path');
      } catch (e) {
        falla(`PostGIS está instalado pero sus funciones no se encuentran (${e.message}). Revisa el search_path del rol`);
      }
    }

    const tablas = (await cliente.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE rowsecurity)::int AS rls FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'spatial_ref_sys'`,
    )).rows[0];
    const migraciones = (await cliente.query(`SELECT to_regclass('public.migrations') IS NOT NULL AS hay`)).rows[0].hay
      ? (await cliente.query('SELECT count(*)::int AS n FROM migrations')).rows[0].n
      : 0;
    if (!migraciones) aviso('Aún no hay tablas: se crean al arrancar la API (o con npm run migration:run)');
    else {
      ok(`${migraciones} migración(es) aplicadas, ${tablas.total} tablas`);
      if (esSupabase && tablas.rls < tablas.total) {
        aviso(`${tablas.total - tablas.rls} tabla(s) sin RLS: la Data API de Supabase podría exponerlas`);
      } else if (esSupabase) ok('Todas las tablas tienen RLS activado (la Data API no expone nada)');
      const usuarios = (await cliente.query('SELECT count(*)::int AS n FROM usuarios')).rows[0].n;
      ok(`${usuarios} usuario(s) en la base${usuarios ? '' : ' — corre npm run seed si quieres datos de prueba'}`);
    }
  } finally {
    await cliente.end();
  }
}

function seguridad() {
  seccion('Seguridad y CORS');
  const secreto = process.env.JWT_SECRET ?? '';
  if (!secreto) falla('Falta JWT_SECRET');
  else if (secreto.length < 32 || secreto === 'cambia-esto') {
    (process.env.NODE_ENV === 'production' ? falla : aviso)('JWT_SECRET es corto o es el de ejemplo; usa al menos 32 caracteres aleatorios');
  } else ok('JWT_SECRET con longitud adecuada');

  const origenes = (process.env.FRONTEND_URL ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  if (!origenes.length) aviso('FRONTEND_URL vacío: la web de admin no podrá llamar a la API desde el navegador');
  for (const o of origenes) {
    if (o.endsWith('/')) falla(`FRONTEND_URL "${o}" no debe terminar en "/" (CORS compara el origen exacto)`);
    else ok(`CORS permite ${o}`);
  }
}

async function storage() {
  seccion('Supabase Storage (imágenes)');
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const llave = process.env.SUPABASE_SERVICE_KEY;
  const bucket = process.env.SUPABASE_BUCKET || 'papedir';
  if (!url && !llave) {
    return (process.env.NODE_ENV === 'production' ? falla : aviso)(
      'Sin SUPABASE_URL/SUPABASE_SERVICE_KEY: las imágenes se guardan en disco. En Render se pierden en cada deploy',
    );
  }
  if (!url || !llave) return falla('Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY (se necesitan las dos)');
  if (llave.startsWith('sb_publishable_')) return falla('Esa es la llave pública (publishable). Usa la secreta: sb_secret_...');

  const h = cabecerasSupabase(llave);
  const config = {
    public: true,
    file_size_limit: REGLAS.upload.maxBytes,
    allowed_mime_types: [...REGLAS.upload.mimes],
  };

  let r = await fetch(`${url}/storage/v1/bucket/${bucket}`, { headers: h }).catch((e) => e as Error);
  if (r instanceof Error) return falla(`No se pudo contactar ${url}: ${r.message}`);
  if (r.status === 401 || r.status === 403) return falla('Supabase rechazó la llave; revisa SUPABASE_SERVICE_KEY');

  if (!r.ok) {
    if (!args.includes('--configurar-bucket')) {
      return falla(`El bucket "${bucket}" no existe. Créalo con: npm run verificar -- --configurar-bucket`);
    }
    const c = await fetch(`${url}/storage/v1/bucket`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bucket, name: bucket, ...config }),
    });
    if (!c.ok) return falla(`No se pudo crear el bucket: ${c.status} ${await c.text()}`);
    ok(`Bucket "${bucket}" creado (público, máx. 5 MB, solo JPG/PNG/WebP)`);
    r = await fetch(`${url}/storage/v1/bucket/${bucket}`, { headers: h });
  }

  const b = await r.json();
  const malConfigurado = !b.public || b.file_size_limit !== config.file_size_limit ||
    [...(b.allowed_mime_types ?? [])].sort().join() !== [...config.allowed_mime_types].sort().join();
  if (malConfigurado && args.includes('--configurar-bucket')) {
    const u = await fetch(`${url}/storage/v1/bucket/${bucket}`, {
      method: 'PUT',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!u.ok) return falla(`No se pudo ajustar el bucket: ${u.status} ${await u.text()}`);
    ok(`Bucket "${bucket}" ajustado: público, máx. 5 MB, solo JPG/PNG/WebP`);
  } else if (!b.public) {
    return falla(`El bucket "${bucket}" es privado: las apps no podrán ver las imágenes. Corre con --configurar-bucket`);
  } else if (malConfigurado) {
    aviso(`El bucket "${bucket}" es público pero sin límite de 5 MB o de tipos de imagen. Ajústalo con --configurar-bucket`);
  } else ok(`Bucket "${bucket}" público, máx. 5 MB, solo JPG/PNG/WebP`);

  // Prueba real: sube una imagen de 1×1, la descarga por su URL pública y la borra.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const ruta = `verificacion/${Date.now()}.png`;
  const subida = await fetch(`${url}/storage/v1/object/${bucket}/${ruta}`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'image/png' },
    body: new Uint8Array(png),
  });
  if (!subida.ok) return falla(`No se pudo subir una imagen de prueba: ${subida.status} ${await subida.text()}`);
  const publica = await fetch(`${url}/storage/v1/object/public/${bucket}/${ruta}`);
  if (publica.ok) ok('Subida y lectura pública de una imagen de prueba');
  else falla(`La imagen se subió pero su URL pública responde ${publica.status}`);
  await fetch(`${url}/storage/v1/object/${bucket}/${ruta}`, { method: 'DELETE', headers: h }).catch(() => null);
}

async function firebase() {
  seccion('Firebase Cloud Messaging (push)');
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!b64) return aviso('Sin FIREBASE_SERVICE_ACCOUNT_BASE64: las notificaciones solo se escriben en el log');

  let cuenta: any;
  try {
    cuenta = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return falla('FIREBASE_SERVICE_ACCOUNT_BASE64 no es un JSON en base64 válido (¿se cortó al copiarlo?)');
  }
  if (cuenta.type !== 'service_account' || !cuenta.private_key || !cuenta.client_email) {
    return falla('El JSON no es de una cuenta de servicio (Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada)');
  }
  ok(`Cuenta de servicio del proyecto "${cuenta.project_id}"`);

  let app: App;
  try {
    app = initializeApp({ credential: cert(cuenta) }, `verificar-${Date.now()}`);
    await app.options.credential.getAccessToken();
    ok('Google aceptó la clave (se obtuvo un token de acceso)');
  } catch (e) {
    return falla(`Google rechazó la clave: ${e.message.split('\n')[0]}`);
  }

  const token = arg('--push');
  if (token) {
    try {
      await getMessaging(app).send({
        token,
        notification: { title: 'PaPedir', body: 'Notificación de prueba desde npm run verificar' },
      });
      ok('Notificación de prueba enviada; revisa el celular');
    } catch (e) {
      falla(`No se pudo enviar al token: ${e.code ?? ''} ${e.message}`);
    }
  } else {
    console.log('    Para probar un celular: npm run verificar -- --push <fcmToken>');
  }
  await deleteApp(app);
}

async function main() {
  console.log(`PaPedir · verificación de configuración (NODE_ENV=${process.env.NODE_ENV ?? 'sin definir'})`);
  await baseDeDatos();
  seguridad();
  await storage();
  await firebase();
  console.log(fallas ? `\n${fallas} problema(s) por corregir.` : '\nTodo en orden.');
  process.exit(fallas ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
