import { MigrationInterface, QueryRunner } from 'typeorm';

/** Baja lógica de tiendas desde el panel: los pedidos pasados la siguen referenciando. */
export class TiendasAdmin1732100000000 implements MigrationInterface {
  name = 'TiendasAdmin1732100000000';

  private funcion(conBaja: boolean) {
    return `
      CREATE OR REPLACE FUNCTION tienda_abierta_ahora(p_tienda uuid, p_ahora timestamptz DEFAULT now()) RETURNS boolean
      LANGUAGE sql STABLE SET search_path = public AS $$
        SELECT t.abierta${conBaja ? '\n          AND t.eliminada_en IS NULL' : ''}
          AND (t.pausada_hasta IS NULL OR t.pausada_hasta <= p_ahora)
          AND (NOT t.usar_horario OR EXISTS (
            SELECT 1 FROM horarios_tienda h, (SELECT p_ahora AT TIME ZONE 'America/Mexico_City' AS l) a
            WHERE h.tienda_id = t.id AND (
                 (h.abre < h.cierra AND h.dia = extract(dow FROM a.l) AND a.l::time >= h.abre AND a.l::time < h.cierra)
              OR (h.abre > h.cierra AND h.dia = extract(dow FROM a.l) AND a.l::time >= h.abre)
              OR (h.abre > h.cierra AND h.dia = extract(dow FROM a.l - interval '1 day') AND a.l::time < h.cierra))))
        FROM tiendas t WHERE t.id = p_tienda
      $$`;
  }

  async up(q: QueryRunner) {
    await q.query(`ALTER TABLE tiendas ADD COLUMN eliminada_en timestamptz, ADD COLUMN eliminada_motivo text`);
    await q.query(this.funcion(true));
  }

  async down(q: QueryRunner) {
    await q.query(this.funcion(false));
    await q.query(`ALTER TABLE tiendas DROP COLUMN eliminada_motivo, DROP COLUMN eliminada_en`);
  }
}
