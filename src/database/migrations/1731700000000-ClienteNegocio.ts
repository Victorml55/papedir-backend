import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fase 3: favoritos, reseñas con respuesta, propina, cupones, notificaciones, chat del pedido,
 * pedidos programados y de varias tiendas; comisiones, saldos y liquidaciones; motivos de cancelación,
 * zonas de cobertura y tarifas dinámicas (configuración editable).
 */
export class ClienteNegocio1731700000000 implements MigrationInterface {
  name = 'ClienteNegocio1731700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE favoritos (
        cliente_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        tienda_id uuid NOT NULL REFERENCES tiendas(id) ON DELETE CASCADE,
        creado_en timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (cliente_id, tienda_id)
      )`);

    await q.query(`ALTER TABLE calificaciones ADD COLUMN respuesta text, ADD COLUMN respondido_en timestamptz`);
    await q.query(`CREATE INDEX idx_calificaciones_tienda ON calificaciones (tienda_id, creado_en DESC)`);

    await q.query(`
      CREATE TABLE cupones (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        codigo text NOT NULL UNIQUE,
        descripcion text,
        tipo text NOT NULL CHECK (tipo IN ('porcentaje','monto','envio_gratis')),
        valor numeric(10,2) NOT NULL DEFAULT 0 CHECK (valor >= 0),
        maximo_descuento numeric(10,2),
        minimo_compra numeric(10,2) NOT NULL DEFAULT 0,
        tienda_id uuid REFERENCES tiendas(id) ON DELETE CASCADE,
        inicio timestamptz,
        fin timestamptz,
        usos_maximos int,
        usos_por_cliente int NOT NULL DEFAULT 1,
        solo_primer_pedido boolean NOT NULL DEFAULT false,
        activo boolean NOT NULL DEFAULT true,
        creado_por uuid REFERENCES usuarios(id),
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);

    // ── Pedidos: programados, grupos, propina, cupón, recargos, motivo y comisiones
    await q.query(`ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS pedidos_estado_check`);
    await q.query(`ALTER TABLE pedidos ADD CONSTRAINT pedidos_estado_check CHECK (estado IN ('programado','creado','aceptado_tienda',
      'listo_para_recoger','asignado','en_tienda','en_camino','en_domicilio','entregado','cancelado','rechazado'))`);
    await q.query(`
      ALTER TABLE pedidos
        ADD COLUMN propina numeric(10,2) NOT NULL DEFAULT 0,
        ADD COLUMN descuento numeric(10,2) NOT NULL DEFAULT 0,
        ADD COLUMN cupon_id uuid REFERENCES cupones(id),
        ADD COLUMN descuento_absorbe text CHECK (descuento_absorbe IN ('plataforma','tienda')),
        ADD COLUMN monto_tienda numeric(10,2),
        ADD COLUMN recargos jsonb NOT NULL DEFAULT '[]',
        ADD COLUMN grupo_id uuid,
        ADD COLUMN programado_para timestamptz,
        ADD COLUMN enviado_a_tienda_en timestamptz,
        ADD COLUMN motivo_codigo text,
        ADD COLUMN comision_tienda numeric(10,2),
        ADD COLUMN comision_envio numeric(10,2)`);
    await q.query(`UPDATE pedidos SET monto_tienda = subtotal`);
    await q.query(`ALTER TABLE pedidos ALTER COLUMN monto_tienda SET NOT NULL`);
    await q.query(`CREATE INDEX idx_pedidos_grupo ON pedidos (grupo_id) WHERE grupo_id IS NOT NULL`);
    await q.query(`CREATE INDEX idx_pedidos_programados ON pedidos (programado_para) WHERE estado = 'programado'`);
    await q.query(`CREATE INDEX idx_pedidos_cupon ON pedidos (cupon_id) WHERE cupon_id IS NOT NULL`);
    await q.query(`ALTER TABLE tiendas ADD COLUMN comision_pct numeric(5,2) CHECK (comision_pct BETWEEN 0 AND 100)`);

    await q.query(`
      CREATE TABLE notificaciones (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        titulo text NOT NULL,
        cuerpo text NOT NULL,
        datos jsonb NOT NULL DEFAULT '{}',
        leida_en timestamptz,
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_notificaciones_usuario ON notificaciones (usuario_id, creado_en DESC)`);

    await q.query(`
      CREATE TABLE mensajes_pedido (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        pedido_id uuid NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
        autor_id uuid NOT NULL REFERENCES usuarios(id),
        autor_rol text NOT NULL,
        texto text NOT NULL,
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_mensajes_pedido ON mensajes_pedido (pedido_id, creado_en)`);

    await q.query(`
      CREATE TABLE zonas (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        nombre text NOT NULL,
        poligono geography(Polygon, 4326) NOT NULL,
        activa boolean NOT NULL DEFAULT true,
        recargo numeric(10,2) NOT NULL DEFAULT 0 CHECK (recargo >= 0),
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_zonas_poligono ON zonas USING gist (poligono)`);

    await q.query(`
      CREATE TABLE configuracion (
        clave text PRIMARY KEY,
        valor jsonb NOT NULL,
        actualizado_por uuid REFERENCES usuarios(id),
        actualizado_en timestamptz NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE TABLE liquidaciones (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id uuid NOT NULL REFERENCES usuarios(id),
        sentido text NOT NULL CHECK (sentido IN ('cobro','pago')),
        monto numeric(10,2) NOT NULL CHECK (monto > 0),
        metodo text NOT NULL CHECK (metodo IN ('efectivo','transferencia')),
        referencia text,
        nota text,
        registrado_por uuid NOT NULL REFERENCES usuarios(id),
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);
    // Cuenta corriente con la plataforma. monto > 0 = el usuario le debe a PaPedir; < 0 = PaPedir le debe.
    await q.query(`
      CREATE TABLE movimientos (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id uuid NOT NULL REFERENCES usuarios(id),
        tienda_id uuid REFERENCES tiendas(id),
        pedido_id uuid REFERENCES pedidos(id),
        liquidacion_id uuid REFERENCES liquidaciones(id),
        tipo text NOT NULL CHECK (tipo IN ('comision_tienda','comision_envio','descuento_plataforma','liquidacion')),
        monto numeric(10,2) NOT NULL,
        descripcion text NOT NULL,
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_movimientos_usuario ON movimientos (usuario_id, creado_en DESC)`);
    await q.query(`CREATE UNIQUE INDEX idx_movimientos_pedido ON movimientos (pedido_id, tipo, usuario_id) WHERE pedido_id IS NOT NULL`);

    for (const t of ['favoritos', 'cupones', 'notificaciones', 'mensajes_pedido', 'zonas', 'configuracion', 'liquidaciones', 'movimientos']) {
      await q.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const t of ['movimientos', 'liquidaciones', 'configuracion', 'zonas', 'mensajes_pedido', 'notificaciones']) await q.query(`DROP TABLE ${t}`);
    await q.query(`ALTER TABLE tiendas DROP COLUMN comision_pct`);
    await q.query(`UPDATE pedidos SET estado = 'cancelado' WHERE estado = 'programado'`);
    await q.query(`ALTER TABLE pedidos DROP COLUMN propina, DROP COLUMN descuento, DROP COLUMN cupon_id, DROP COLUMN descuento_absorbe,
      DROP COLUMN monto_tienda, DROP COLUMN recargos, DROP COLUMN grupo_id, DROP COLUMN programado_para, DROP COLUMN enviado_a_tienda_en,
      DROP COLUMN motivo_codigo, DROP COLUMN comision_tienda, DROP COLUMN comision_envio`);
    await q.query(`ALTER TABLE pedidos DROP CONSTRAINT pedidos_estado_check`);
    await q.query(`ALTER TABLE pedidos ADD CONSTRAINT pedidos_estado_check CHECK (estado IN ('creado','aceptado_tienda',
      'listo_para_recoger','asignado','en_tienda','en_camino','en_domicilio','entregado','cancelado','rechazado'))`);
    await q.query(`DROP TABLE cupones`);
    await q.query(`DROP INDEX idx_calificaciones_tienda`);
    await q.query(`ALTER TABLE calificaciones DROP COLUMN respuesta, DROP COLUMN respondido_en`);
    await q.query(`DROP TABLE favoritos`);
  }
}
