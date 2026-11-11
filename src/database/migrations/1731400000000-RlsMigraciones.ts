import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TypeORM guarda su historial en la tabla "migrations" (esquema public). En Supabase la Data API
 * podría leerla, así que también se le activa RLS sin políticas.
 */
export class RlsMigraciones1731400000000 implements MigrationInterface {
  name = 'RlsMigraciones1731400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE IF EXISTS migrations ENABLE ROW LEVEL SECURITY`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE IF EXISTS migrations DISABLE ROW LEVEL SECURITY`);
  }
}
