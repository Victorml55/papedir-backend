import { MigrationInterface, QueryRunner } from 'typeorm';

/** Inicio de sesión de las apps con Firebase Authentication (Google, GitHub, correo y contraseña). */
export class FirebaseAuth1731800000000 implements MigrationInterface {
  name = 'FirebaseAuth1731800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE usuarios ADD COLUMN firebase_uid text UNIQUE, ADD COLUMN proveedor text NOT NULL DEFAULT 'local'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE usuarios DROP COLUMN firebase_uid, DROP COLUMN proveedor`);
  }
}
