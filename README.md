# PaPedir — Backend

API de PaPedir, plataforma de reparto a domicilio en Celaya, Gto. Proyecto final de **Tópicos Avanzados de Desarrollo Web** y **Desarrollo de Aplicaciones Móviles** (TecNM Celaya).

Las 3 apps (Cliente, Tienda, Repartidor) y la web de Admin/Soporte hablan únicamente con esta API; nadie más toca la base de datos.

| | |
|---|---|
| Stack | Node.js 22 · NestJS 11 · TypeORM · PostgreSQL + PostGIS · Socket.IO · Firebase Cloud Messaging |
| Contrato | [`docs/openapi.yaml`](docs/openapi.yaml) — 65 endpoints. Es la fuente de verdad |
| Acuerdos del equipo | [`ACUERDOS.md`](ACUERDOS.md) — convenciones, eventos de tiempo real, Git |
| Reglas de negocio | [`src/config/reglas.ts`](src/config/reglas.ts) — montos, distancias y tiempos en un solo lugar |

## Correr en local

Necesitas Node 22 y PostgreSQL con PostGIS (o una base de Supabase).

```bash
npm install
cp .env.example .env          # llena DATABASE_URL y JWT_SECRET
npm run seed                  # crea tablas (migraciones) y datos de prueba
npm run start:dev             # http://localhost:3000/api/v1
```

- Documentación interactiva: http://localhost:3000/api/docs
- Las migraciones pendientes se aplican solas al arrancar.

Base local rápida con PostGIS:

```sql
CREATE USER papedir WITH PASSWORD 'papedir' SUPERUSER;
CREATE DATABASE papedir OWNER papedir;
CREATE DATABASE papedir_test OWNER papedir;
```

### Usuarios de prueba

Contraseña de todos: `PaPedir123!`

| Correo | Rol | App |
|---|---|---|
| `cliente@papedir.test` | cliente | App Cliente |
| `tienda@papedir.test` | tienda (Tacos Don Pepe) | App Tienda |
| `repartidor@papedir.test` · `repartidor2@papedir.test` | repartidor | App Repartidor |
| `soporte@papedir.test` | soporte | Web |
| `admin@papedir.test` | admin | Web |
| `tienda.pendiente@papedir.test` | tienda sin aprobar (con su INE por revisar) | App Tienda |
| `repartidor.nuevo@papedir.test` | repartidor sin aprobar (con documentos por revisar) | App Repartidor |
| `luis@`, `maria@`, `jorge@`, `sofia@`, `daniel@papedir.test` | más clientes con historial | App Cliente |
| `cliente.baneado@papedir.test` | cliente baneado | App Cliente |

El seed crea 4 tiendas abiertas con menú y una historia de 30 días hecha con la API real:

- ~50 pedidos: entregados (efectivo y tarjeta, con propina y cupones), cancelados y rechazados con motivo, uno de dos tiendas en un solo carrito y 6 manuales listos para recoger.
- Para la demo en vivo: uno nuevo que la tienda debe aceptar, uno en preparación, uno en camino con chat y uno programado para mañana.
- Reseñas con respuestas de la tienda, tickets en todos los estados, favoritos, documentos aprobados y por revisar.
- Zona de cobertura de Celaya, cupones (`BIENVENIDA`, `ENVIOGRATIS`, `TACOS10`), planes Premium y Pro, saldos y dos liquidaciones.

Los pagos con tarjeta del seed son simulados: no crean nada en Stripe. `npm run seed -- --reset` borra todo y vuelve a sembrar; con `--basico` se omite la historia.

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run start:dev` | API con recarga automática |
| `npm run build` · `npm run start:prod` | Compilar y correr en producción |
| `npm run seed` | Datos de prueba |
| `npm run verificar` | Revisa que `.env` funcione: base, PostGIS, Storage, Firebase |
| `npm run test:e2e` | 40 pruebas de punta a punta contra `papedir_test` (**borra esa base**) |
| `npm run migration:run` · `migration:revert` | Migraciones manuales |
| `npm run format` | Prettier |

## Estructura

```
src/
├── main.ts · app.module.ts
├── config/reglas.ts        reglas de negocio
├── common/                 guard de auth y roles, formato de errores, DTOs comunes
├── database/               entidades, migraciones, seed
├── nucleo/                 tiempo real, push y cálculo de envío (compartidos)
├── auth/                   registro, login por app, refresh, perfil, dispositivo
├── direcciones/            direcciones del cliente
├── tiendas/                tiendas, categorías, productos, menú
├── uploads/                imágenes (Supabase Storage)
├── pedidos/                cotización, pedidos, máquina de estados, tareas por tiempo
├── repartidor/             disponibles, tomar, viajes, marcas con geocerca
├── tickets/                tickets y chat con soporte
├── soporte/                acciones de soporte y admin
└── realtime/               gateway de Socket.IO
```

Dos ideas sostienen el diseño:

- **Todo cambio de estado de un pedido pasa por `PedidosService.transicionar`**: bloquea el pedido, valida permisos y reglas, escribe la bitácora y avisa por socket y push.
- **Tomar un pedido es atómico**: si dos repartidores lo intentan a la vez, uno recibe `409 PEDIDO_YA_TOMADO`.

## Integración continua

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) corre en cada Pull Request y en cada push a `main` o `develop`: valida `openapi.yaml`, compila y ejecuta las 40 pruebas e2e contra PostgreSQL + PostGIS.

Para que un PR con pruebas rojas no se pueda fusionar: **Settings → Branches → Add branch ruleset** sobre `main` y `develop`, con *Require a pull request before merging* y *Require status checks to pass* → `Contrato, build y pruebas e2e`.

## Despliegue

El orden importa: primero Supabase, luego Render (al arrancar crea las tablas), al final los datos.

### 1. Supabase (base de datos e imágenes)

1. Crea el proyecto. Elige la región **East US (Ohio)** o la más cercana a la de Render, y guarda la contraseña de la base.
2. **Database → Extensions → postgis → Enable**, con el esquema `extensions`. Si lo olvidas, la API lo instala ahí sola en el primer arranque.
3. Botón **Connect** → **Transaction pooler** (puerto 6543). Esa es tu `DATABASE_URL`, con `DATABASE_SSL=true`.
   - No uses la conexión directa (`db.<ref>.supabase.co`): es solo IPv6 y Render no la alcanza.
   - Si la contraseña tiene `@ : / # ?`, codifícala: `node -e "console.log(encodeURIComponent('tu-pass'))"`.
4. **Project Settings → API Keys** → copia la llave **secreta** (`sb_secret_...`) como `SUPABASE_SERVICE_KEY`. La URL del proyecto (`https://<ref>.supabase.co`) es `SUPABASE_URL`.
5. Pon esos valores en tu `.env` y crea los dos buckets con su configuración: `papedir` (público, máximo 5 MB, solo JPG/PNG/WebP) para fotos y `papedir-privado` (privado, imágenes y PDF) para documentos como INE y licencia:

   ```bash
   npm run verificar -- --configurar-bucket
   ```

Todas las tablas quedan con RLS activado y sin políticas: la Data API de Supabase no expone nada y el backend (dueño de las tablas) no se ve afectado.

### 2. Render (API)

**New → Blueprint** → elige este repositorio. [`render.yaml`](render.yaml) ya trae el build, el health check (`/api/v1/health`), Node 22 y genera `JWT_SECRET`. Render te pedirá:

| Variable | Valor |
|---|---|
| `DATABASE_URL` | Transaction pooler de Supabase (puerto 6543) |
| `SUPABASE_URL` · `SUPABASE_SERVICE_KEY` | Del paso 1 |
| `FRONTEND_URL` | Dominio de Vercel, sin `/` al final (ej. `https://papedir-admin.vercel.app`) |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | Opcional (paso 4); déjalo vacío por ahora |

Cada push a `main` redespliega. El plan gratis se duerme a los 15 minutos sin tráfico y la primera petición tarda unos 50 segundos; para la demo, abre `/api/v1/health` unos minutos antes.

### 3. Datos de prueba en Supabase

Desde tu máquina, con la `DATABASE_URL` de Supabase en `.env` (o en la línea de comandos):

```bash
DATABASE_URL="<transaction pooler>" DATABASE_SSL=true npm run seed
DATABASE_URL="<transaction pooler>" DATABASE_SSL=true npm run verificar
```

### 4. Firebase (notificaciones push)

1. En la [consola de Firebase](https://console.firebase.google.com) crea el proyecto `papedir` (Analytics no hace falta).
2. Agrega **3 apps Android** con estos nombres de paquete exactos y entrega cada `google-services.json` a quien hace esa app:
   - `com.papedir.cliente` → Omar
   - `com.papedir.tienda` → Omar
   - `com.papedir.repartidor` → Dennis
3. **Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada**. Descarga el JSON y conviértelo a base64 en una sola línea:

   ```bash
   base64 -w0 cuenta.json                                               # Linux
   base64 -i cuenta.json                                                # macOS
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("cuenta.json"))    # PowerShell
   ```

4. Pega el resultado en `FIREBASE_SERVICE_ACCOUNT_BASE64` (en `.env` y en Render) y prueba con un celular real:

   ```bash
   npm run verificar -- --push <fcmToken que imprime la app>
   ```

El JSON de la cuenta de servicio es una llave: no lo subas al repositorio ni lo mandes por el grupo; bórralo después de convertirlo.

#### Authentication, Firestore y Storage (requisitos de la app móvil)

Con la misma cuenta de servicio, la API ya valida el login de las apps (`POST /auth/firebase`). En la consola:

1. **Authentication → Sign-in method:** activa **Correo electrónico/contraseña**, **Google** y **GitHub**.
   - Google en Android necesita la huella **SHA-1** de cada app: cada quien la saca con `cd android && ./gradlew signingReport` y la agrega en **Configuración del proyecto → Tus apps**. Después hay que volver a descargar el `google-services.json`.
   - GitHub: en GitHub → **Settings → Developer settings → OAuth Apps → New**, usa como *callback URL* la que muestra Firebase, y pega en Firebase el *Client ID* y el *Client secret*.
   - En **Templates** cambia el idioma de los correos (verificación y contraseña) a español.
2. **Firestore Database → Crear base de datos** (modo producción, región `us-central1` o la más cercana) y en **Reglas** pega:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /usuarios/{uid} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
     }
   }
   ```

3. **Storage → Comenzar** y en **Reglas** pega:

   ```
   rules_version = '2';
   service firebase.storage {
     match /b/{bucket}/o {
       match /avatares/{uid}.jpg {
         allow read: if request.auth != null;
         allow write: if request.auth != null && request.auth.uid == uid
                      && request.resource.size < 5 * 1024 * 1024
                      && request.resource.contentType.matches('image/.*');
       }
     }
   }
   ```

   Storage pide el plan Blaze (de pago por uso) en proyectos nuevos; con el uso del proyecto queda dentro de la capa gratuita, pero conviene poner una **alerta de presupuesto** de $1 USD en Google Cloud.
4. **Messaging:** las campañas a temas (`novedades`, `promociones`, `tiendas`, `repartidores`) se mandan desde **Messaging → Nueva campaña → Notificaciones → Tema**.

### 5. Resend (correos con códigos)

La API manda por correo los códigos para verificar el correo y para recuperar la contraseña. Sin configurar, la API funciona igual y los códigos solo aparecen en el log de Render.

1. Crea una cuenta en [resend.com](https://resend.com) y en **API Keys** genera una llave con permiso *Sending access*.
2. En Render agrega `RESEND_API_KEY` con esa llave y revisa con `npm run verificar`.
3. Con el remitente de prueba `onboarding@resend.dev`, Resend **solo entrega al correo con el que creaste la cuenta**. Sirve para probar; para que le llegue a cualquier usuario, verifica un dominio propio en **Domains** y cambia `CORREO_REMITENTE` a `PaPedir <no-responder@tu-dominio>`.
### 6. Stripe (pago con tarjeta y planes de tienda)

1. Crea una cuenta en [stripe.com](https://stripe.com) (no hace falta activar pagos reales) y deja activado **Modo de prueba**.
2. **Developers → API keys**: copia la *Publishable key* (`pk_test_...`) y la *Secret key* (`sk_test_...`).
3. En Render agrégalas como `STRIPE_PUBLISHABLE_KEY` y `STRIPE_SECRET_KEY` y revisa con `npm run verificar`.
4. Para probar en la app usa la tarjeta `4242 4242 4242 4242`, cualquier fecha futura y cualquier CVC. `4000 0000 0000 9995` simula fondos insuficientes.

La llave secreta nunca va en las apps ni en el chat del equipo; las apps reciben la publicable con `GET /pagos/config`.

