import { MigrationInterface, QueryRunner } from 'typeorm';

/** Pago de pedidos con tarjeta (Stripe) y planes de suscripción de las tiendas. */
export class PagosStripe1731900000000 implements MigrationInterface {
  name = 'PagosStripe1731900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS pedidos_metodo_pago_check`);
    await q.query(`ALTER TABLE pedidos ADD CONSTRAINT pedidos_metodo_pago_check CHECK (metodo_pago IN ('efectivo','tarjeta'))`);
    await q.query(`
      ALTER TABLE pedidos
        ADD COLUMN pago_estado text CHECK (pago_estado IN ('pagado','reembolsado','reembolso_fallido')),
        ADD COLUMN payment_intent_id text UNIQUE`);

    await q.query(`ALTER TABLE tiendas ADD COLUMN plan text NOT NULL DEFAULT 'basico' CHECK (plan IN ('basico','pro','premium')),
      ADD COLUMN plan_hasta timestamptz`);
    await q.query(`
      CREATE TABLE suscripciones (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tienda_id uuid NOT NULL REFERENCES tiendas(id) ON DELETE CASCADE,
        plan text NOT NULL,
        monto numeric(10,2) NOT NULL,
        payment_intent_id text NOT NULL UNIQUE,
        inicio timestamptz NOT NULL,
        fin timestamptz NOT NULL,
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_suscripciones_tienda ON suscripciones (tienda_id, creado_en DESC)`);
    await q.query(`ALTER TABLE suscripciones ENABLE ROW LEVEL SECURITY`);

    // Con tarjeta el dinero lo cobra PaPedir: le debe a la tienda su venta y al repartidor su envío y propina.
    await q.query(`ALTER TABLE movimientos DROP CONSTRAINT IF EXISTS movimientos_tipo_check`);
    await q.query(`ALTER TABLE movimientos ADD CONSTRAINT movimientos_tipo_check CHECK (tipo IN
      ('comision_tienda','comision_envio','descuento_plataforma','liquidacion','venta_tarjeta','envio_tarjeta'))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM movimientos WHERE tipo IN ('venta_tarjeta','envio_tarjeta')`);
    await q.query(`ALTER TABLE movimientos DROP CONSTRAINT movimientos_tipo_check`);
    await q.query(`ALTER TABLE movimientos ADD CONSTRAINT movimientos_tipo_check CHECK (tipo IN
      ('comision_tienda','comision_envio','descuento_plataforma','liquidacion'))`);
    await q.query(`DROP TABLE suscripciones`);
    await q.query(`ALTER TABLE tiendas DROP COLUMN plan, DROP COLUMN plan_hasta`);
    await q.query(`UPDATE pedidos SET metodo_pago = 'efectivo' WHERE metodo_pago = 'tarjeta'`);
    await q.query(`ALTER TABLE pedidos DROP COLUMN pago_estado, DROP COLUMN payment_intent_id`);
    await q.query(`ALTER TABLE pedidos DROP CONSTRAINT pedidos_metodo_pago_check`);
    await q.query(`ALTER TABLE pedidos ADD CONSTRAINT pedidos_metodo_pago_check CHECK (metodo_pago IN ('efectivo'))`);
  }
}
