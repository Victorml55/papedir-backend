import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fase 2: vehículo, documentos y calificación del repartidor; sucursales, horario semanal y pausa,
 * inventario, varias fotos y opciones de producto (tamaño, extras...).
 */
export class RepartidorTienda1731600000000 implements MigrationInterface {
  name = 'RepartidorTienda1731600000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── Repartidor
    await q.query(`ALTER TABLE usuarios ADD COLUMN calificacion numeric(3,2)`);
    await q.query(`
      UPDATE usuarios u SET calificacion = c.prom
      FROM (SELECT repartidor_id, round(avg(repartidor), 2) AS prom FROM calificaciones WHERE repartidor_id IS NOT NULL GROUP BY 1) c
      WHERE u.id = c.repartidor_id`);
    await q.query(`
      CREATE TABLE vehiculos (
        repartidor_id uuid PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
        tipo text NOT NULL CHECK (tipo IN ('moto','bicicleta','auto')),
        marca text,
        modelo text,
        color text NOT NULL,
        placa text,
        actualizado_en timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE documentos (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        tipo text NOT NULL,
        ruta text NOT NULL,
        mime text NOT NULL,
        estado text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','aprobado','rechazado')),
        motivo text,
        revisado_por uuid REFERENCES usuarios(id),
        revisado_en timestamptz,
        creado_en timestamptz NOT NULL DEFAULT now(),
        UNIQUE (usuario_id, tipo)
      )`);

    // ── Tiendas: sucursales, horario y pausa
    await q.query(`ALTER TABLE tiendas DROP CONSTRAINT IF EXISTS tiendas_owner_id_key`);
    await q.query(`CREATE INDEX idx_tiendas_owner ON tiendas (owner_id)`);
    await q.query(`ALTER TABLE tiendas ADD COLUMN usar_horario boolean NOT NULL DEFAULT false, ADD COLUMN pausada_hasta timestamptz`);
    await q.query(`
      CREATE TABLE horarios_tienda (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tienda_id uuid NOT NULL REFERENCES tiendas(id) ON DELETE CASCADE,
        dia smallint NOT NULL CHECK (dia BETWEEN 0 AND 6),
        abre time NOT NULL,
        cierra time NOT NULL,
        CHECK (abre <> cierra)
      )`);
    await q.query(`CREATE INDEX idx_horarios_tienda ON horarios_tienda (tienda_id)`);
    /*
     * ¿La tienda recibe pedidos en este momento? Única fuente de verdad (búsqueda, menú y pedidos).
     * abierta = interruptor general de la tienda; pausada_hasta = pausa temporal; horario en hora de Celaya.
     * dia: 0 = domingo … 6 = sábado. Un turno que cruza la medianoche (20:00–02:00) pertenece al día en que abre.
     */
    await q.query(`
      CREATE FUNCTION tienda_abierta_ahora(p_tienda uuid, p_ahora timestamptz DEFAULT now()) RETURNS boolean
      LANGUAGE sql STABLE SET search_path = public AS $$
        SELECT t.abierta
          AND (t.pausada_hasta IS NULL OR t.pausada_hasta <= p_ahora)
          AND (NOT t.usar_horario OR EXISTS (
            SELECT 1 FROM horarios_tienda h, (SELECT p_ahora AT TIME ZONE 'America/Mexico_City' AS l) a
            WHERE h.tienda_id = t.id AND (
                 (h.abre < h.cierra AND h.dia = extract(dow FROM a.l) AND a.l::time >= h.abre AND a.l::time < h.cierra)
              OR (h.abre > h.cierra AND h.dia = extract(dow FROM a.l) AND a.l::time >= h.abre)
              OR (h.abre > h.cierra AND h.dia = extract(dow FROM a.l - interval '1 day') AND a.l::time < h.cierra))))
        FROM tiendas t WHERE t.id = p_tienda
      $$`);

    // ── Productos: inventario, fotos y opciones
    await q.query(`ALTER TABLE productos ADD COLUMN stock int CHECK (stock >= 0), ADD COLUMN imagenes jsonb NOT NULL DEFAULT '[]'`);
    await q.query(`UPDATE productos SET imagenes = jsonb_build_array(imagen_url) WHERE imagen_url IS NOT NULL`);
    await q.query(`
      CREATE TABLE grupos_opciones (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        producto_id uuid NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
        nombre text NOT NULL,
        minimo int NOT NULL DEFAULT 0 CHECK (minimo >= 0),
        maximo int NOT NULL DEFAULT 1 CHECK (maximo >= 1),
        orden int NOT NULL DEFAULT 0,
        CHECK (minimo <= maximo)
      )`);
    await q.query(`CREATE INDEX idx_grupos_producto ON grupos_opciones (producto_id)`);
    await q.query(`
      CREATE TABLE opciones (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        grupo_id uuid NOT NULL REFERENCES grupos_opciones(id) ON DELETE CASCADE,
        nombre text NOT NULL,
        precio_extra numeric(10,2) NOT NULL DEFAULT 0 CHECK (precio_extra >= 0),
        disponible boolean NOT NULL DEFAULT true,
        orden int NOT NULL DEFAULT 0
      )`);
    await q.query(`CREATE INDEX idx_opciones_grupo ON opciones (grupo_id)`);
    // Las opciones elegidas se copian al pedido (nombre y precio fijos aunque la tienda las cambie).
    await q.query(`ALTER TABLE pedido_items ADD COLUMN opciones jsonb NOT NULL DEFAULT '[]'`);

    for (const t of ['vehiculos', 'documentos', 'horarios_tienda', 'grupos_opciones', 'opciones']) {
      await q.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE pedido_items DROP COLUMN opciones`);
    await q.query(`DROP TABLE opciones`);
    await q.query(`DROP TABLE grupos_opciones`);
    await q.query(`ALTER TABLE productos DROP COLUMN stock, DROP COLUMN imagenes`);
    await q.query(`DROP FUNCTION tienda_abierta_ahora(uuid, timestamptz)`);
    await q.query(`DROP TABLE horarios_tienda`);
    await q.query(`ALTER TABLE tiendas DROP COLUMN usar_horario, DROP COLUMN pausada_hasta`);
    await q.query(`DROP INDEX idx_tiendas_owner`);
    // Falla si algún dueño ya tiene varias sucursales: hay que resolverlo a mano antes de revertir.
    await q.query(`ALTER TABLE tiendas ADD CONSTRAINT tiendas_owner_id_key UNIQUE (owner_id)`);
    await q.query(`DROP TABLE documentos`);
    await q.query(`DROP TABLE vehiculos`);
    await q.query(`ALTER TABLE usuarios DROP COLUMN calificacion`);
  }
}
