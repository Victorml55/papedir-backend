import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El índice único evita registrar dos veces lo mismo de un pedido (comisión, envío, reembolso...).
 * Una resolución de cancelación sí puede llevar varios movimientos para la misma persona
 * (por ejemplo, el viaje en falso y el cargo por cancelación al cliente), así que queda fuera.
 */
export class ResolucionVariasLineas1732500000000 implements MigrationInterface {
  name = 'ResolucionVariasLineas1732500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS idx_movimientos_pedido`);
    await q.query(`CREATE UNIQUE INDEX idx_movimientos_pedido ON movimientos (pedido_id, tipo, usuario_id) WHERE pedido_id IS NOT NULL AND tipo <> 'resolucion'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS idx_movimientos_pedido`);
    await q.query(`CREATE UNIQUE INDEX idx_movimientos_pedido ON movimientos (pedido_id, tipo, usuario_id) WHERE pedido_id IS NOT NULL`);
  }
}
