# Acuerdos del equipo — PaPedir

Proyecto compartido entre **Tópicos Avanzados de Desarrollo Web** y **Desarrollo de Aplicaciones Móviles** (TecNM Celaya).

| Integrante | No. de control | Rol en el proyecto |
|---|---|---|
| Mendoza Lara Victor Manuel | 22030872 | Backend + Web de Administración y Soporte |
| Mandujano Ávila Omar | 22031401 | App Cliente + App Tienda (Flutter) |
| Quintana Lazgare Dennis Adrián | 22030053 | App Repartidor + paquete `core` (Flutter) |

Este documento se acepta por los tres integrantes. Cualquier cambio se propone por Pull Request y necesita la aprobación de los otros dos.

**Documentos del proyecto:**

| Documento | Contenido |
|---|---|
| *PaPedir — Definición del proyecto* (compartido) | Contexto, **reglas de negocio**, funcionalidades por app, identidad visual, cronograma |
| `docs/openapi.yaml` | Contrato de la API: cada endpoint, campos, respuestas y códigos de error |
| `ACUERDOS.md` (este) | Cómo trabajamos: convenciones, tiempo real, Git, definición de terminado |

Si una regla de negocio de la Definición y el contrato no coinciden, se corrige el contrato.

---

## 1. Arquitectura

```
App Cliente (Flutter)     ─┐
App Tienda (Flutter)      ─┤
App Repartidor (Flutter)  ─┼──→ API NestJS (Render) ──→ PostgreSQL + PostGIS (Supabase)
Web Admin/Soporte (React) ─┘          │
                                      ├─ Socket.IO (tiempo real)
                                      └─ Firebase Cloud Messaging (push)
```

| Pieza | Tecnología | Despliegue |
|---|---|---|
| API | Node.js + NestJS (TypeScript), TypeORM | Render (Web Service) |
| Base de datos | PostgreSQL + PostGIS | Supabase (solo como base de datos) |
| Tiempo real | Socket.IO | Render (mismo servicio que la API) |
| Push | Firebase Cloud Messaging | — |
| Web admin/soporte | React + Vite + TypeScript | Vercel (Root Directory = `web`) |
| Apps móviles | Flutter (Dart 3.6+), Riverpod, dio | APK (`flutter build apk --release`) |
| Mapas | Mapbox o Google Maps (se decide antes de la semana 6) | — |

### Regla de oro

**Ninguna app ni la web accede directo a la base de datos.** Todo pasa por la API.

- Prohibido usar `supabase_flutter`, `supabase-js` o cualquier credencial de Supabase en el repo `papedir-frontend`.
- La única configuración que conocen los clientes es la URL de la API (`API_URL` / `VITE_API_URL`).
- La `DATABASE_URL` y el `JWT_SECRET` solo viven en las variables de entorno de Render y en el `.env` local del backend.
- La única llave permitida en las apps es la del proveedor de mapas, restringida por `applicationId`.

---

## 2. Repositorios

### `papedir-backend` (dueño: Victor)

```
papedir-backend/
├── src/
│   ├── auth/  usuarios/  direcciones/  tiendas/  categorias/  productos/
│   ├── pedidos/  repartidor/  tickets/  soporte/  admin/  uploads/
│   └── realtime/            (gateway Socket.IO)
├── migrations/
├── docs/
│   └── openapi.yaml         ← CONTRATO (fuente de verdad)
└── .env.example
```

### `papedir-frontend`

```
papedir-frontend/
├── apps/
│   ├── cliente/        (Omar)    applicationId: com.papedir.cliente
│   ├── tienda/         (Omar)    applicationId: com.papedir.tienda
│   └── repartidor/     (Dennis)  applicationId: com.papedir.repartidor
├── packages/
│   └── core/           (Dennis)  código compartido de las 3 apps
├── web/                (Victor)  React admin y soporte
├── docs/
│   └── openapi.yaml    ← copia sincronizada del backend
└── pubspec.yaml        (workspace de Dart)
```

---

## 3. El contrato de la API

El archivo `docs/openapi.yaml` del backend es **la fuente de verdad**. Si algo no está en el contrato, no existe.

### Trabajar contra el mock (desde el día 1)

Mientras el backend no esté listo, las apps consumen un servidor falso que responde según el contrato:

```bash
cd papedir-frontend
npx @stoplight/prism-cli mock docs/openapi.yaml -p 4010
```

| Entorno | URL de la API |
|---|---|
| Mock (Prism) | `http://localhost:4010` (emulador Android: `http://10.0.2.2:4010`) |
| Backend local | `http://localhost:3000/api/v1` (emulador: `http://10.0.2.2:3000/api/v1`) |
| Producción | `https://papedir-api.onrender.com/api/v1` |

En Flutter la URL se inyecta al compilar, nunca se escribe en el código:

```bash
flutter run --dart-define=API_URL=http://10.0.2.2:4010
```

```dart
const apiUrl = String.fromEnvironment('API_URL', defaultValue: 'http://10.0.2.2:4010');
```

El mock acepta cualquier token y devuelve los ejemplos del contrato (montos y coordenadas realistas de Celaya). Para probar errores, fuerza una respuesta con el header `Prefer: code=409`. El modo `--dynamic` genera datos aleatorios (incluso montos negativos); úsalo solo para probar listas largas y textos extremos.

El mock **no guarda estado ni tiene Socket.IO**: sirve para construir pantallas. Los flujos entre apps y el tiempo real se prueban con el backend real desde la semana 5.

### Cómo se cambia el contrato

1. Quien necesite el cambio abre un **issue** en `papedir-backend` con la etiqueta `contrato`, explicando qué necesita y por qué.
2. Victor actualiza `openapi.yaml` en un PR. Omar y Dennis lo revisan y aprueban.
3. Al hacer merge, se copia el archivo a `papedir-frontend/docs/openapi.yaml` en un PR con el título `chore: sincronizar contrato`.
4. Se avisa en el grupo del equipo.

Reglas:

- **Cambios que no rompen** (agregar un endpoint, un campo opcional en la respuesta): se aprueban rápido.
- **Cambios que rompen** (renombrar o quitar campos, cambiar tipos, hacer obligatorio un campo): requieren acuerdo de los tres antes de programarlos.
- El backend **no se desvía del contrato**. Si la implementación necesita otra forma, primero se cambia el contrato.

---

## 4. Convenciones de la API

| Tema | Acuerdo |
|---|---|
| Prefijo | `/api/v1` |
| Formato | JSON, campos en `camelCase` (en la BD son `snake_case`, eso lo resuelve el backend) |
| IDs | UUID |
| Fechas | ISO 8601 en UTC (`2026-11-09T20:00:00Z`); las apps las convierten a hora local |
| Dinero | MXN, número con 2 decimales. El cliente **nunca** envía precios ni totales de pedidos de la app; los calcula el backend |
| Coordenadas | `{ "lat": 20.5222, "lng": -100.8123 }` |
| Paginación | `?page=1&limit=20` → `{ "data": [...], "meta": { "page", "limit", "total" } }` |
| Auth | Header `Authorization: Bearer <accessToken>` |

### Errores

Todas las respuestas de error tienen la misma forma:

```json
{
  "statusCode": 409,
  "error": "TRANSICION_INVALIDA",
  "message": "El pedido ya fue tomado por otro repartidor",
  "detalles": [{ "campo": "email", "mensaje": "email debe ser un correo válido" }]
}
```

| Código | Significado | Qué hace la app |
|---|---|---|
| 400 | Datos inválidos | Mostrar `detalles` junto a cada campo |
| 401 | Token expirado o inválido | Llamar `/auth/refresh` una vez y reintentar; si falla, mandar al login |
| 403 | Sin permiso, app equivocada o cuenta baneada | Mostrar `message` y cerrar sesión si está baneado |
| 404 | No existe | Mensaje y regresar |
| 409 | Conflicto con una regla de negocio | Mostrar `message`, refrescar los datos y actuar según `error` (abajo) |
| 500 | Error del servidor | Mensaje genérico y opción de reintentar |

El campo `error` es un código estable; las apps deciden con él, no con el texto de `message`. Los más importantes:

| `error` | Cuándo | Qué hace la app |
|---|---|---|
| `CUENTA_PENDIENTE` | Tienda o repartidor sin aprobar intenta abrir o conectarse | Pantalla "Tu cuenta está en revisión" |
| `FUERA_DE_COBERTURA` | Destino a más de 8 km de la tienda | Pedir otra dirección |
| `PEDIDO_MINIMO` / `PEDIDO_MAXIMO_EFECTIVO` | Menos de $50 de productos / más de $1,500 de total | Aviso en el carrito |
| `PEDIDO_YA_TOMADO` | Otro repartidor lo tomó primero | Quitarlo del mapa |
| `VIAJE_LLENO` / `NO_ENCADENABLE` | Ya lleva 4 pedidos / el pedido queda lejos de su ruta | Aviso y quitarlo del mapa |
| `FUERA_DE_RANGO` | Marca de llegada a más de 150 m | "Acércate a la ubicación" |
| `CODIGO_INCORRECTO` | El código de entrega no coincide | Pedirlo de nuevo |
| `TRANSICION_INVALIDA` | El estado ya cambió (otro actor o soporte) | Refrescar el pedido |

La lista completa está en el schema `Error` de `openapi.yaml`. Todos los valores numéricos (montos, distancias, tiempos) están en la sección de reglas de negocio de la Definición del proyecto.

### Sesión en las apps

- `POST /auth/login` siempre envía `app` (`cliente`, `tienda`, `repartidor` o `web`). El backend rechaza con 403 si el rol no corresponde a la app.
- `accessToken` dura 15 min y `refreshToken` 7 días.
- Los tokens se guardan con `flutter_secure_storage`, nunca en `SharedPreferences`.
- Un interceptor de `dio` en `core` agrega el token y maneja el refresh automáticamente.
- Después del login se registra el token de FCM con `PUT /usuarios/me/dispositivo`.

### Estados del pedido

```
creado → aceptado_tienda → listo_para_recoger → asignado → en_tienda → en_camino → en_domicilio → entregado
   │            │                  │
   └→ rechazado └──── cancelado ───┘   (después de "asignado" solo soporte cancela)
```

Los pedidos manuales de la tienda nacen directamente en `listo_para_recoger`. Si la tienda no responde en 5 minutos, el backend cancela el pedido solo.

| Acción | Quién | Endpoint |
|---|---|---|
| Cotizar | Cliente · Tienda (manual) | `POST /pedidos/cotizar` · `/pedidos/cotizar-manual` |
| Aceptar / rechazar | Tienda | `POST /pedidos/{id}/aceptar` · `/rechazar` |
| Marcar listo | Tienda | `POST /pedidos/{id}/listo` |
| Cancelar | Cliente (solo `creado`) · Tienda (antes de `asignado`) | `POST /pedidos/{id}/cancelar` |
| Tomar (máx. 4 por viaje) | Repartidor | `POST /repartidor/pedidos/{id}/tomar` |
| Llegada / salida tienda (geocerca 150 m) | Repartidor | `POST /repartidor/pedidos/{id}/llegada-tienda` · `/salida-tienda` |
| Llegada / entrega con código (geocerca 150 m) | Repartidor | `POST /repartidor/pedidos/{id}/llegada-cliente` · `/entregado` |
| Calificar (hasta 24 h después) | Cliente | `POST /pedidos/{id}/calificar` |
| Cancelar, completar, corregir ubicación, liberar | Soporte | `/soporte/pedidos/{id}/...` |

---

## 5. Tiempo real (Socket.IO)

OpenAPI no describe WebSockets, así que este es el contrato de eventos.

**Conexión:** misma URL base de la API (sin `/api/v1`), namespace `/realtime`, enviando el token en el handshake:

```dart
final socket = io('$baseUrl/realtime', OptionBuilder()
    .setTransports(['websocket'])
    .setAuth({'token': accessToken})
    .build());
```

Al conectarse, el backend une al usuario automáticamente a sus salas: `usuario:{id}`, `tienda:{tiendaId}`, `repartidores` o `soporte` según el rol. Con un token inválido el servidor emite `error` y desconecta.

Los eventos que emiten las apps responden con un *ack*: `{ ok: true }` o `{ ok: false, error }` (en Dart: `socket.emitWithAck(...)`).

### Eventos que emite el servidor

| Evento | Lo recibe | Payload |
|---|---|---|
| `pedido:nuevo` | Tienda y soporte | `Pedido` (sin `codigoEntrega`) |
| `pedido:actualizado` | Cliente, tienda y repartidor del pedido; soporte | `{ pedidoId, estado, actualizadoEn }` |
| `pedido:disponible` | Todos los repartidores con socket abierto | `PedidoDisponible` con `distanciaATiendaKm: null`. Es solo un aviso: la app vuelve a pedir `GET /repartidor/pedidos-disponibles`, que aplica radio y encadenamiento |
| `pedido:tomado` | Repartidores (para quitarlo del mapa; también al cancelarse) | `{ pedidoId }` |
| `repartidor:ubicacion` | Cliente y tienda del pedido en curso | `{ pedidoId, lat, lng, actualizadoEn }` |
| `pedido:sin_repartidor` | Soporte (web) | `{ pedidoId, folio }` → lleva 15 min listo sin repartidor |
| `ticket:nuevo` | Soporte (web) | `Ticket` |
| `ticket:mensaje` | Participantes del ticket | `Mensaje` |
| `ticket:actualizado` | Creador del ticket | `{ ticketId, estado }` |
| `cuenta:baneada` | El usuario baneado | `{ motivo }` → la app cierra sesión |
| `cuenta:aprobada` | Tienda o repartidor aprobado | `{}` → la app quita el aviso de cuenta en revisión |

### Eventos que emiten las apps

| Evento | Quién | Payload | Notas |
|---|---|---|---|
| `repartidor:ubicacion` | App Repartidor | `{ lat, lng }` | Cada 10 s mientras esté disponible o con viaje activo. Si el socket está caído, usar `PUT /repartidor/ubicacion` |
| `pedido:seguir` / `pedido:dejar` | Cliente, tienda | `{ pedidoId }` | Para recibir la ubicación del repartidor en la pantalla de seguimiento |
| `ticket:unirse` / `ticket:salir` | Todos | `{ ticketId }` | Al abrir y cerrar el chat |

**Regla:** el socket solo avisa. Ante un evento, la app vuelve a pedir el recurso por REST si necesita el detalle completo. Si el socket se desconecta, la app sigue funcionando refrescando cada 15 s.

---

## 6. Flutter: workspace y paquete `core`

`packages/core` lo mantiene **Dennis**. Las 3 apps dependen de él; nadie duplica código que debería estar ahí.

| Carpeta de `core` | Contenido |
|---|---|
| `api/` | Cliente `dio`, interceptor de JWT y refresh, manejo del formato de error |
| `models/` | `Usuario`, `Tienda`, `CategoriaProducto`, `Producto`, `Cotizacion`, `Pedido`, `Viaje`, `Ticket`, `Mensaje`, enums de estado |
| `auth/` | Pantallas de login y registro reutilizables, almacenamiento seguro de tokens |
| `realtime/` | Conexión Socket.IO y streams de eventos |
| `soporte/` | Lista de tickets, crear ticket y chat (se usa en las 3 apps) |
| `push/` | Inicialización de FCM y registro del dispositivo |
| `theme/` | Tema azul y blanco de PaPedir (colores, Inter, formas; código en la Definición del proyecto) y widgets comunes |

Acuerdos:

- Cambios en `core` van en su propio PR y requieren la aprobación de Omar, porque afectan sus apps.
- Si Omar necesita algo en `core` y Dennis está ocupado, Omar puede hacer el PR y Dennis lo revisa.
- Gestión de estado: **Riverpod** en las 3 apps. HTTP: **dio**. Modelos: `json_serializable`.
- Cada app tiene su `applicationId`, nombre e ícono propios para poder instalarse las 3 en el mismo celular.

Estructura recomendada dentro de cada app:

```
lib/
├── main.dart
├── router.dart        (go_router)
├── features/
│   └── <funcionalidad>/   data/ · providers/ · screens/ · widgets/
└── config.dart        (lee API_URL)
```

---

## 7. Responsabilidades y entregables

### Victor — Backend + Web Admin/Soporte

| Entregable | Semana |
|---|---|
| Repo, NestJS base, conexión a Supabase, deploy en Render con `/api/v1/health` | 1 |
| Contrato `openapi.yaml` publicado y usuarios de prueba | 1 |
| Auth (registro, login por app, refresh, roles, aprobación, baneo) | 2 |
| Direcciones, tiendas, categorías, productos, uploads, cotización, pedidos y máquina de estados | 3 |
| Repartidor: pedidos cercanos con PostGIS, tomar pedido atómico, viajes de hasta 4, geocerca, código de entrega | 4 |
| Tickets, chat, soporte, admin, Socket.IO, FCM, auto-cancelación de 5 min, calificaciones | 5 |
| Web: login, bandeja de tickets con chat, búsqueda y acciones sobre pedidos | 6–9 |
| Web: aprobación de cuentas, baneos, dashboard de métricas | 10–12 |
| Swagger en producción, pruebas de integración, manual técnico | 13–18 |

### Omar — App Cliente + App Tienda

| Entregable | Semana |
|---|---|
| Wireframes de cliente y tienda | 1 |
| **Cliente:** registro/login, mis direcciones con selección en mapa | 2–3 |
| **Cliente:** tiendas cercanas, menú por categorías y carrito | 4–5 |
| **Cliente:** cotización, confirmar pedido, mis pedidos, línea de tiempo con `eventos` | 6–7 |
| **Cliente:** seguimiento en vivo, código de entrega, cancelar, calificar | 8 |
| **Tienda:** registro (cuenta en revisión), abrir/cerrar, categorías y productos con foto | 9–10 |
| **Tienda:** bandeja en tiempo real con contador de 5 min, aceptar/rechazar/listo | 11–12 |
| **Tienda:** pedido manual con captura de dirección en mapa | 13 |
| Soporte integrado (desde `core`), push, pruebas y APKs de cliente y tienda | 14–16 |
| Manual de usuario de cliente y tienda | 17–18 |

### Dennis — App Repartidor + `core`

| Entregable | Semana |
|---|---|
| Wireframes del repartidor, workspace de Dart y esqueleto de `core` | 1 |
| `core`: cliente API, modelos, auth, almacenamiento de tokens, theme | 2–3 |
| `core`: realtime, push y módulo de soporte (tickets y chat) | 4–5 |
| **Repartidor:** login, conectarse/desconectarse, permisos de ubicación | 6 |
| **Repartidor:** mapa con pedidos disponibles en tiempo real, tomar pedido | 7–8 |
| **Repartidor:** viaje actual con paradas y trazado de ruta | 9–10 |
| **Repartidor:** marcas con geocerca, entrega con código, efectivo a pagar y cobrar, llamar | 11–12 |
| **Repartidor:** ubicación en segundo plano, encadenar pedidos cercanos, historial | 13–14 |
| Pruebas en dispositivo real y APK del repartidor | 15–16 |
| Manual de usuario del repartidor | 17–18 |

### Todos

- Semana 1: revisar y aprobar el contrato.
- Desde la semana 5: probar contra el backend real los flujos entre apps y el tiempo real.
- Semana 14: todo apunta al backend real; el mock queda solo para pruebas aisladas.
- Semanas 17–18: prueba completa de punta a punta y ensayo de la demo.

---

## 8. Usuarios de prueba (seed)

El backend crea estos usuarios en desarrollo. Contraseña para todos: `PaPedir123!`

| Email | Rol | Se usa en |
|---|---|---|
| `cliente@papedir.test` | cliente | App Cliente |
| `tienda@papedir.test` | tienda (Tacos Don Pepe) | App Tienda |
| `repartidor@papedir.test` | repartidor | App Repartidor |
| `soporte@papedir.test` | soporte | Web |
| `admin@papedir.test` | admin | Web |
| `tienda.pendiente@papedir.test` | tienda sin aprobar | App Tienda (probar pantalla de cuenta en revisión) |

El seed también crea 4 tiendas aprobadas en Celaya con categorías y productos, y 6 pedidos en `listo_para_recoger` para que el repartidor pueda probar su mapa y encadenar pedidos sin depender de la App Tienda.

Estas credenciales son solo para desarrollo y nunca se usan en producción con datos reales.

---

## 9. Git y forma de trabajo

### Ramas en `papedir-backend`

```
main              producción: Render despliega en cada merge. Protegida.
└── develop       integración. Protegida.
    └── feature/<tema>    ej. feature/api-pedidos, fix/refresh-token
```

### Ramas en `papedir-frontend`

Cada app y la web tienen su propia rama de integración, para que cada quien trabaje aislado y todo se junte solo en `develop`:

```
main                      producción: Vercel despliega web/, se generan los APK
└── develop               integración de todo el front
    ├── dev-core          paquete core            (Dennis)
    │   └── core/<tema>         ej. core/auth, core/realtime
    ├── dev-cliente       App Cliente             (Omar)
    │   └── cliente/<tema>      ej. cliente/carrito
    ├── dev-tienda        App Tienda              (Omar)
    │   └── tienda/<tema>       ej. tienda/catalogo
    ├── dev-repartidor    App Repartidor          (Dennis)
    │   └── repartidor/<tema>   ej. repartidor/mapa
    └── dev-admin         Web Admin/Soporte       (Victor)
        └── admin/<tema>        ej. admin/tickets
```

Las ramas de área se llaman `dev-<área>` y las de tarea `<área>/<tema>`; Git no permite tener a la vez una rama `cliente` y otra `cliente/carrito`, por eso los nombres son distintos.

Flujo:

```bash
# 1. empezar una tarea desde la rama de su área
git checkout dev-cliente && git pull
git checkout -b cliente/carrito

# 2. al terminar: PR de cliente/carrito → dev-cliente

# 3. traer a su área los cambios de core que ya están en develop
git checkout dev-cliente && git pull
git merge origin/develop
```

- Al cerrar cada sprint (cada 2 semanas): PR de cada `dev-<área>` → `develop`, revisado por los otros dos.
- `core` entra primero a `develop` (vía `dev-core`); después cada área hace `git merge origin/develop`.
- En cada hito: `develop` → `main`, con los tres de acuerdo.
- Cada rama de área solo modifica su carpeta. Un `CODEOWNERS` pide la revisión del dueño:

```
# .github/CODEOWNERS
/apps/cliente/       @omar
/apps/tienda/        @omar
/apps/repartidor/    @dennis
/packages/core/      @dennis @omar
/web/                @Victorml55
/docs/openapi.yaml   @Victorml55
```

(Sustituyan `@omar` y `@dennis` por sus usuarios de GitHub.)

### Commits

[Conventional Commits](https://www.conventionalcommits.org/es/), en español:

```
feat(cliente): agregar pantalla de carrito
fix(core): renovar token al recibir 401
docs: sincronizar contrato
refactor(api): mover cálculo de envío a un servicio
```

### Pull Requests

- Todo entra por PR; nadie hace push directo a `main`, `develop` ni a las ramas `dev-*`.
- Cada PR necesita **1 aprobación** de otro integrante (2 si toca `core` o el contrato).
- El PR describe qué cambia y cómo probarlo, con capturas si es pantalla.
- Se hace merge a `main` al cerrar cada hito, con los tres de acuerdo.
- Nunca se suben `.env`, llaves ni el `google-services.json` de producción. Cada repo tiene su `.env.example`.

### Calidad

- Backend: ESLint + Prettier; `npm run lint` y `npm test` deben pasar.
- Flutter: `dart format .` y `flutter analyze` sin errores.
- GitHub Actions corre lint y pruebas en cada PR.

---

## 10. Definición de "terminado"

Una tarea está terminada cuando:

- [ ] Funciona contra el mock **y** contra el backend real (cuando ya exista).
- [ ] Maneja estados de carga, vacío y error.
- [ ] Respeta el contrato y las convenciones de este documento.
- [ ] Pasa lint/analyze y tiene sus pruebas básicas.
- [ ] Fue revisada y aprobada en un PR.
- [ ] Está marcada como hecha en el tablero.

---

## 11. Comunicación

- **Tablero:** GitHub Projects con columnas *Por hacer · En progreso · En revisión · Hecho*. Cada tarea es un issue con responsable y semana.
- **Reuniones:** dos por semana, de 15 minutos: qué hice, qué haré, qué me bloquea.
- **Bloqueos:** si alguien está bloqueado más de un día, lo avisa en el grupo. Si es por el backend, se sigue trabajando con el mock.
- **Retrasos:** si un entregable va a llegar tarde, se avisa antes de la fecha, no después.
- **Desacuerdos técnicos:** se discuten en el issue; si no hay consenso, se decide por mayoría.

---

## 12. Aceptación

| Integrante | Acepto estos acuerdos | Fecha |
|---|---|---|
| Mendoza Lara Victor Manuel | ☐ | |
| Mandujano Ávila Omar | ☐ | |
| Quintana Lazgare Dennis Adrián | ☐ | |
