import { MigrationInterface, QueryRunner } from 'typeorm';

/** Panel de administración: moderación de reseñas y bitácora de acciones del equipo interno. */
export class PanelAdmin1732000000000 implements MigrationInterface {
  name = 'PanelAdmin1732000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE calificaciones
        ADD COLUMN oculta boolean NOT NULL DEFAULT false,
        ADD COLUMN oculta_motivo text,
        ADD COLUMN oculta_por uuid REFERENCES usuarios(id) ON DELETE SET NULL,
        ADD COLUMN oculta_en timestamptz`);

    await q.query(`
      CREATE TABLE acciones_internas (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id uuid REFERENCES usuarios(id) ON DELETE SET NULL,
        actor_rol text NOT NULL,
        metodo text NOT NULL,
        ruta text NOT NULL,
        accion text NOT NULL,
        recurso_id uuid,
        detalle jsonb,
        estado_http int NOT NULL,
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_acciones_internas_fecha ON acciones_internas (creado_en DESC)`);
    await q.query(`CREATE INDEX idx_acciones_internas_actor ON acciones_internas (actor_id, creado_en DESC)`);
    await q.query(`ALTER TABLE acciones_internas ENABLE ROW LEVEL SECURITY`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE acciones_internas`);
    await q.query(`ALTER TABLE calificaciones DROP COLUMN oculta, DROP COLUMN oculta_motivo, DROP COLUMN oculta_por, DROP COLUMN oculta_en`);
  }
}
