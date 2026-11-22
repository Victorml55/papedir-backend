import { MigrationInterface, QueryRunner } from 'typeorm';

const TIPOS_ANTES = `'comision_tienda','comision_envio','descuento_plataforma','liquidacion','venta_tarjeta','envio_tarjeta','pago_con_saldo','reverso_saldo','saldo_cliente','pago_deuda','deuda_cobrada','reembolso','cargo_cancelacion','compensacion_cancelacion','ajuste'`;
const TIPOS = `${TIPOS_ANTES},'compensacion_repartidor','resolucion'`;

/**
 * Cierre de cancelaciones: el repartidor se compensa solo si el pedido se cancela cuando ya lo llevaba,
 * y soporte registra de quién fue la culpa, las compensaciones y el acuerdo con las personas.
 */
export class ResolverCancelaciones1732400000000 implements MigrationInterface {
  name = 'ResolverCancelaciones1732400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE movimientos DROP CONSTRAINT IF EXISTS movimientos_tipo_check`);
    await q.query(`ALTER TABLE movimientos ADD CONSTRAINT movimientos_tipo_check CHECK (tipo IN (${TIPOS}))`);
    await q.query(`
      CREATE TABLE resoluciones (
        pedido_id uuid PRIMARY KEY REFERENCES pedidos(id) ON DELETE CASCADE,
        culpable text NOT NULL CHECK (culpable IN ('cliente','tienda','repartidor','plataforma')),
        nota text NOT NULL,
        acuerdo text,
        acciones jsonb NOT NULL DEFAULT '[]',
        resuelto_por uuid NOT NULL REFERENCES usuarios(id),
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_resoluciones_culpable ON resoluciones (culpable, creado_en DESC)`);
    await q.query(`ALTER TABLE resoluciones ENABLE ROW LEVEL SECURITY`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE resoluciones`);
    await q.query(`DELETE FROM movimientos WHERE tipo IN ('compensacion_repartidor','resolucion')`);
    await q.query(`ALTER TABLE movimientos DROP CONSTRAINT IF EXISTS movimientos_tipo_check`);
    await q.query(`ALTER TABLE movimientos ADD CONSTRAINT movimientos_tipo_check CHECK (tipo IN (${TIPOS_ANTES}))`);
  }
}
