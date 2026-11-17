import { MigrationInterface, QueryRunner } from 'typeorm';

/** Fase 1: recuperar y verificar correo, términos, bloqueo por intentos, foto, eliminar cuenta y bitácora de cuentas. */
export class CuentasSeguridad1731500000000 implements MigrationInterface {
  name = 'CuentasSeguridad1731500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE usuarios
        ADD COLUMN foto_url text,
        ADD COLUMN email_verificado_en timestamptz,
        ADD COLUMN terminos_version text,
        ADD COLUMN terminos_aceptados_en timestamptz,
        ADD COLUMN intentos_fallidos int NOT NULL DEFAULT 0,
        ADD COLUMN bloqueado_hasta timestamptz,
        ADD COLUMN eliminado_en timestamptz`);
    await q.query(`ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_estado_check`);
    await q.query(`ALTER TABLE usuarios ADD CONSTRAINT usuarios_estado_check
      CHECK (estado IN ('pendiente_aprobacion','activo','baneado','eliminado'))`);

    await q.query(`
      CREATE TABLE codigos_verificacion (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        proposito text NOT NULL CHECK (proposito IN ('recuperar_password','verificar_email')),
        codigo_hash text NOT NULL,
        expira_en timestamptz NOT NULL,
        intentos int NOT NULL DEFAULT 0,
        usado_en timestamptz,
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_codigos_usuario ON codigos_verificacion (usuario_id, proposito, creado_en DESC)`);

    await q.query(`
      CREATE TABLE eventos_cuenta (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        tipo text NOT NULL,
        actor_id uuid REFERENCES usuarios(id),
        actor_rol text,
        detalle text,
        creado_en timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_eventos_cuenta ON eventos_cuenta (usuario_id, creado_en DESC)`);

    for (const t of ['codigos_verificacion', 'eventos_cuenta']) await q.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS eventos_cuenta`);
    await q.query(`DROP TABLE IF EXISTS codigos_verificacion`);
    await q.query(`UPDATE usuarios SET estado = 'baneado' WHERE estado = 'eliminado'`);
    await q.query(`ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_estado_check`);
    await q.query(`ALTER TABLE usuarios ADD CONSTRAINT usuarios_estado_check CHECK (estado IN ('pendiente_aprobacion','activo','baneado'))`);
    await q.query(`ALTER TABLE usuarios DROP COLUMN foto_url, DROP COLUMN email_verificado_en, DROP COLUMN terminos_version,
      DROP COLUMN terminos_aceptados_en, DROP COLUMN intentos_fallidos, DROP COLUMN bloqueado_hasta, DROP COLUMN eliminado_en`);
  }
}
