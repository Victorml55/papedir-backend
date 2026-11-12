import { MigrationInterface, QueryRunner } from 'typeorm';

const PUNTO = (lat: string, lng: string) =>
  `geography(Point,4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) STORED`;

const TABLAS = ['mensajes', 'tickets', 'calificaciones', 'eventos_pedido', 'pedido_items', 'pedidos', 'viajes', 'productos',
  'categorias_producto', 'tiendas', 'direcciones', 'dispositivos', 'refresh_tokens', 'usuarios'];

export class Inicial1731300000000 implements MigrationInterface {
  name = 'Inicial1731300000000';

  public async up(q: QueryRunner): Promise<void> {
    // En Supabase, PostGIS va en el esquema "extensions" (el rol postgres ya lo tiene en su search_path).
    // En PostgreSQL local o en CI ese esquema no existe y se instala en public.
    const [{ existe }] = await q.query(`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') AS existe`);
    await q.query(`CREATE EXTENSION IF NOT EXISTS postgis${existe ? ' WITH SCHEMA extensions' : ''}`);

    await q.query(`
      CREATE TABLE usuarios (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        nombre text NOT NULL,
        email text NOT NULL UNIQUE,
        password_hash text NOT NULL,
        telefono text,
        rol text NOT NULL CHECK (rol IN ('cliente','tienda','repartidor','soporte','admin')),
        estado text NOT NULL DEFAULT 'activo' CHECK (estado IN ('pendiente_aprobacion','activo','baneado')),
        motivo_baneo text,
        disponible boolean NOT NULL DEFAULT false,
        lat double precision,
        lng double precision,
        ubicacion ${PUNTO('lat', 'lng')},
        ubicacion_en timestamptz,
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_usuarios_ubicacion ON usuarios USING gist (ubicacion) WHERE rol = 'repartidor'`);

    await q.query(`
      CREATE TABLE refresh_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        expira_en timestamptz NOT NULL,
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE TABLE dispositivos (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        fcm_token text NOT NULL UNIQUE,
        app text NOT NULL,
        actualizado_en timestamptz NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE TABLE direcciones (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        cliente_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        alias text NOT NULL,
        texto text NOT NULL,
        referencias text,
        lat double precision NOT NULL,
        lng double precision NOT NULL,
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_direcciones_cliente ON direcciones (cliente_id)`);

    await q.query(`
      CREATE TABLE tiendas (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL UNIQUE REFERENCES usuarios(id) ON DELETE CASCADE,
        nombre text NOT NULL,
        categoria text NOT NULL CHECK (categoria IN ('comida','abarrotes','farmacia','materiales','otros')),
        descripcion text,
        imagen_url text,
        telefono text,
        direccion text NOT NULL,
        lat double precision NOT NULL,
        lng double precision NOT NULL,
        ubicacion ${PUNTO('lat', 'lng')},
        abierta boolean NOT NULL DEFAULT false,
        tiempo_preparacion_min int NOT NULL DEFAULT 20,
        calificacion numeric(3,2),
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_tiendas_ubicacion ON tiendas USING gist (ubicacion)`);

    await q.query(`
      CREATE TABLE categorias_producto (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tienda_id uuid NOT NULL REFERENCES tiendas(id) ON DELETE CASCADE,
        nombre text NOT NULL,
        orden int NOT NULL DEFAULT 0
      )`);
    await q.query(`CREATE INDEX idx_categorias_tienda ON categorias_producto (tienda_id)`);

    await q.query(`
      CREATE TABLE productos (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tienda_id uuid NOT NULL REFERENCES tiendas(id) ON DELETE CASCADE,
        categoria_id uuid REFERENCES categorias_producto(id) ON DELETE SET NULL,
        nombre text NOT NULL,
        descripcion text,
        precio numeric(10,2) NOT NULL CHECK (precio >= 0),
        imagen_url text,
        disponible boolean NOT NULL DEFAULT true,
        eliminado boolean NOT NULL DEFAULT false,
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_productos_tienda ON productos (tienda_id) WHERE NOT eliminado`);

    await q.query(`
      CREATE TABLE viajes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        repartidor_id uuid NOT NULL REFERENCES usuarios(id),
        estado text NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','finalizado')),
        creado_en timestamptz NOT NULL DEFAULT now(),
        finalizado_en timestamptz
      )`);
    // Un repartidor solo puede tener un viaje activo a la vez.
    await q.query(`CREATE UNIQUE INDEX idx_viaje_activo ON viajes (repartidor_id) WHERE estado = 'activo'`);

    await q.query(`
      CREATE TABLE pedidos (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        folio_num serial NOT NULL UNIQUE,
        estado text NOT NULL DEFAULT 'creado' CHECK (estado IN ('creado','aceptado_tienda','listo_para_recoger',
          'asignado','en_tienda','en_camino','en_domicilio','entregado','cancelado','rechazado')),
        origen text NOT NULL CHECK (origen IN ('app','manual')),
        tienda_id uuid NOT NULL REFERENCES tiendas(id),
        cliente_id uuid REFERENCES usuarios(id),
        destino_nombre text NOT NULL,
        destino_telefono text NOT NULL,
        destino_direccion text NOT NULL,
        destino_referencias text,
        destino_lat double precision NOT NULL,
        destino_lng double precision NOT NULL,
        destino_ubicacion ${PUNTO('destino_lat', 'destino_lng')},
        descripcion text,
        subtotal numeric(10,2) NOT NULL,
        costo_envio numeric(10,2) NOT NULL,
        total numeric(10,2) NOT NULL,
        distancia_km numeric(6,2) NOT NULL,
        metodo_pago text NOT NULL DEFAULT 'efectivo' CHECK (metodo_pago IN ('efectivo')),
        codigo_entrega text,
        notas text,
        repartidor_id uuid REFERENCES usuarios(id),
        viaje_id uuid REFERENCES viajes(id),
        evidencia_url text,
        listo_en timestamptz,
        entregado_en timestamptz,
        soporte_avisado boolean NOT NULL DEFAULT false,
        creado_en timestamptz NOT NULL DEFAULT now(),
        actualizado_en timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_pedidos_estado ON pedidos (estado)`);
    await q.query(`CREATE INDEX idx_pedidos_tienda ON pedidos (tienda_id, creado_en DESC)`);
    await q.query(`CREATE INDEX idx_pedidos_cliente ON pedidos (cliente_id, creado_en DESC)`);
    await q.query(`CREATE INDEX idx_pedidos_repartidor ON pedidos (repartidor_id, creado_en DESC)`);
    await q.query(`CREATE INDEX idx_pedidos_viaje ON pedidos (viaje_id)`);

    await q.query(`
      CREATE TABLE pedido_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        pedido_id uuid NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
        producto_id uuid NOT NULL REFERENCES productos(id),
        nombre text NOT NULL,
        cantidad int NOT NULL CHECK (cantidad > 0),
        precio_unitario numeric(10,2) NOT NULL
      )`);
    await q.query(`CREATE INDEX idx_items_pedido ON pedido_items (pedido_id)`);

    await q.query(`
      CREATE TABLE eventos_pedido (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        pedido_id uuid NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
        tipo text NOT NULL,
        usuario_id uuid REFERENCES usuarios(id),
        rol text,
        detalle text,
        lat double precision,
        lng double precision,
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_eventos_pedido ON eventos_pedido (pedido_id, creado_en)`);

    await q.query(`
      CREATE TABLE calificaciones (
        pedido_id uuid PRIMARY KEY REFERENCES pedidos(id) ON DELETE CASCADE,
        tienda_id uuid NOT NULL REFERENCES tiendas(id),
        repartidor_id uuid REFERENCES usuarios(id),
        tienda int NOT NULL CHECK (tienda BETWEEN 1 AND 5),
        repartidor int NOT NULL CHECK (repartidor BETWEEN 1 AND 5),
        comentario text,
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE TABLE tickets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        folio_num serial NOT NULL UNIQUE,
        asunto text NOT NULL,
        descripcion text NOT NULL,
        estado text NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto','en_atencion','resuelto','cerrado')),
        pedido_id uuid REFERENCES pedidos(id),
        creado_por uuid NOT NULL REFERENCES usuarios(id),
        atendido_por uuid REFERENCES usuarios(id),
        resuelto_en timestamptz,
        creado_en timestamptz NOT NULL DEFAULT now(),
        actualizado_en timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_tickets_creador ON tickets (creado_por, creado_en DESC)`);

    await q.query(`
      CREATE TABLE mensajes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        autor_id uuid NOT NULL REFERENCES usuarios(id),
        autor_rol text NOT NULL,
        texto text NOT NULL,
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_mensajes_ticket ON mensajes (ticket_id, creado_en)`);

    // Defensa en profundidad: Supabase expone el esquema public por su Data API. Con RLS activado y sin
    // políticas, esa API no devuelve nada; el backend se conecta como dueño de las tablas y no se ve afectado.
    for (const t of TABLAS) await q.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const t of TABLAS) await q.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
}
