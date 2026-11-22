import { MigrationInterface, QueryRunner } from 'typeorm';

/** Control total desde el panel: prioridad de tickets, liquidaciones anulables e historial de notificaciones. */
export class ControlTotal1732300000000 implements MigrationInterface {
  name = 'ControlTotal1732300000000';

  public async up(q: QueryRunner): Promise<void> {
    // Las categorías de tienda ahora vienen del catálogo que edita admin: la base ya no las limita.
    await q.query(`ALTER TABLE tiendas DROP CONSTRAINT IF EXISTS tiendas_categoria_check`);
    await q.query(`ALTER TABLE tickets ADD COLUMN prioridad text NOT NULL DEFAULT 'normal' CHECK (prioridad IN ('baja','normal','alta','urgente'))`);
    await q.query(`
      ALTER TABLE liquidaciones
        ADD COLUMN anulada_en timestamptz,
        ADD COLUMN anulada_motivo text,
        ADD COLUMN anulada_por uuid REFERENCES usuarios(id) ON DELETE SET NULL`);
    await q.query(`
      CREATE TABLE envios_push (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id uuid REFERENCES usuarios(id) ON DELETE SET NULL,
        destino text NOT NULL CHECK (destino IN ('tema','rol')),
        tema text,
        rol text,
        titulo text NOT NULL,
        cuerpo text NOT NULL,
        destinatarios int,
        modo text NOT NULL,
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_envios_push_fecha ON envios_push (creado_en DESC)`);
    await q.query(`ALTER TABLE envios_push ENABLE ROW LEVEL SECURITY`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE envios_push`);
    await q.query(`ALTER TABLE liquidaciones DROP COLUMN anulada_en, DROP COLUMN anulada_motivo, DROP COLUMN anulada_por`);
    await q.query(`ALTER TABLE tickets DROP COLUMN prioridad`);
    await q.query(`UPDATE tiendas SET categoria = 'otros' WHERE categoria NOT IN ('comida','abarrotes','farmacia','materiales','otros')`);
    await q.query(`ALTER TABLE tiendas ADD CONSTRAINT tiendas_categoria_check CHECK (categoria IN ('comida','abarrotes','farmacia','materiales','otros'))`);
  }
}
