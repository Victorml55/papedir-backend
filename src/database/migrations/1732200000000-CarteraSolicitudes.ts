import { MigrationInterface, QueryRunner } from 'typeorm';

const TIPOS_ANTES = `'comision_tienda','comision_envio','descuento_plataforma','liquidacion','venta_tarjeta','envio_tarjeta'`;
const TIPOS = `${TIPOS_ANTES},'pago_con_saldo','reverso_saldo','saldo_cliente','pago_deuda','deuda_cobrada','reembolso','cargo_cancelacion','compensacion_cancelacion','ajuste'`;

/**
 * Cartera estilo DiDi para clientes, tiendas y repartidores, solicitudes de tienda nueva desde la app
 * y rechazo de solicitudes de cuenta con motivo.
 *
 * El signo de los movimientos se invierte: ahora monto > 0 es dinero a favor del usuario y < 0 lo que debe.
 */
export class CarteraSolicitudes1732200000000 implements MigrationInterface {
  name = 'CarteraSolicitudes1732200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE movimientos SET monto = -monto`);
    await q.query(`ALTER TABLE movimientos DROP CONSTRAINT IF EXISTS movimientos_tipo_check`);
    await q.query(`ALTER TABLE movimientos ADD CONSTRAINT movimientos_tipo_check CHECK (tipo IN (${TIPOS}))`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_movimientos_usuario ON movimientos (usuario_id, creado_en DESC)`);

    // Saldo a favor que el pedido usó y deuda anterior que se cobró en él.
    await q.query(`
      ALTER TABLE pedidos
        ADD COLUMN saldo_aplicado numeric(10,2) NOT NULL DEFAULT 0,
        ADD COLUMN deuda_cobrada numeric(10,2) NOT NULL DEFAULT 0`);

    await q.query(`ALTER TABLE usuarios ADD COLUMN motivo_rechazo text, ADD COLUMN rechazada_en timestamptz`);

    await q.query(`
      CREATE TABLE solicitudes_tienda (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        datos jsonb NOT NULL,
        estado text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','aprobada','rechazada','cancelada')),
        motivo text,
        revisada_por uuid REFERENCES usuarios(id) ON DELETE SET NULL,
        revisada_en timestamptz,
        tienda_id uuid REFERENCES tiendas(id) ON DELETE SET NULL,
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_solicitudes_tienda_estado ON solicitudes_tienda (estado, creado_en DESC)`);
    await q.query(`CREATE INDEX idx_solicitudes_tienda_usuario ON solicitudes_tienda (usuario_id, creado_en DESC)`);
    await q.query(`ALTER TABLE solicitudes_tienda ENABLE ROW LEVEL SECURITY`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE solicitudes_tienda`);
    await q.query(`ALTER TABLE usuarios DROP COLUMN motivo_rechazo, DROP COLUMN rechazada_en`);
    await q.query(`ALTER TABLE pedidos DROP COLUMN saldo_aplicado, DROP COLUMN deuda_cobrada`);
    await q.query(`DELETE FROM movimientos WHERE tipo NOT IN (${TIPOS_ANTES})`);
    await q.query(`ALTER TABLE movimientos DROP CONSTRAINT movimientos_tipo_check`);
    await q.query(`ALTER TABLE movimientos ADD CONSTRAINT movimientos_tipo_check CHECK (tipo IN (${TIPOS_ANTES}))`);
    await q.query(`UPDATE movimientos SET monto = -monto`);
  }
}
