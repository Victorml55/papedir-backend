# PaPedir — Backend

API de PaPedir, plataforma de reparto a domicilio en Celaya, Gto. Proyecto final de **Tópicos Avanzados de Desarrollo Web** y **Desarrollo de Aplicaciones Móviles** (TecNM Celaya).

Las 3 apps (Cliente, Tienda, Repartidor) y la web de Admin/Soporte hablan únicamente con esta API; nadie más toca la base de datos.

| | |
|---|---|
| Stack | Node.js 20+ · NestJS 11 · TypeORM · PostgreSQL + PostGIS · Socket.IO · Firebase Cloud Messaging |
| Contrato | [`docs/openapi.yaml`](docs/openapi.yaml) — 65 endpoints. Es la fuente de verdad |
| Acuerdos del equipo | [`ACUERDOS.md`](ACUERDOS.md) — convenciones, eventos de tiempo real, Git |
| Reglas de negocio | [`src/config/reglas.ts`](src/config/reglas.ts) — montos, distancias y tiempos en un solo lugar |

## Correr en local

Necesitas Node 20+ y PostgreSQL con PostGIS (o una base de Supabase).

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
| `tienda.pendiente@papedir.test` | tienda sin aprobar | App Tienda |

El seed también crea 4 tiendas abiertas con menú y 6 pedidos listos para recoger. `npm run seed -- --reset` borra todo y vuelve a sembrar.

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run start:dev` | API con recarga automática |
| `npm run build` · `npm run start:prod` | Compilar y correr en producción |
| `npm run seed` | Datos de prueba |
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

## Despliegue

### Supabase (solo base de datos)

1. Crea el proyecto y copia la cadena **Session pooler** (Project Settings → Database → Connection string).
2. Las tablas las crea la API al arrancar. Quedan con RLS activado y sin políticas, así que la Data API de Supabase no expone nada.
3. Para imágenes: crea un bucket **público** llamado `papedir` en Storage y copia la `service_role key` (Project Settings → API). Esa llave solo va en Render, nunca en las apps.

### Render (Web Service)

| Campo | Valor |
|---|---|
| Build Command | `npm install --include=dev && npm run build` |
| Start Command | `npm run start:prod` |
| Health Check Path | `/api/v1/health` |

Variables de entorno: las de [`.env.example`](.env.example), con `NODE_ENV=production`, `DATABASE_SSL=true`, `FRONTEND_URL` con el dominio de Vercel y `PUBLIC_URL` con la URL del servicio.

Para cargar los datos de prueba en la base de Supabase, desde tu máquina:

```bash
DATABASE_URL="<cadena de Supabase>" DATABASE_SSL=true npm run seed
```

## Pendiente

- Notificaciones push reales: falta crear el proyecto de Firebase y poner `FIREBASE_SERVICE_ACCOUNT_BASE64`. Sin esa variable las notificaciones solo se escriben en el log.
- GitHub Actions para correr las pruebas en cada PR.
