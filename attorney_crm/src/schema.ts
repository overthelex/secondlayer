import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Queryable } from './db';
import { tenant } from './tenant';

// pg.Pool hands each query to any idle connection, so BEGIN/COMMIT must run on one
// checked-out client. Fakes in tests may omit connect().
export interface ConnectablePool extends Queryable {
  connect?(): Promise<Queryable & { release(): void }>;
}

// Every file is idempotent, and a file is re-applied only when its content hash
// differs from the recorded one. Re-applying 001 on every boot (the first design)
// took DDL locks against the running ЄДРСР backfill and deadlocked the service.

/**
 * Applies attorney_crm/sql/*.sql in lexical order, each inside one transaction,
 * skipping files whose recorded sha256 matches. A 10 s lock_timeout per file means a
 * boot that collides with long DDL/DML elsewhere fails fast and is retried by the
 * container restart policy instead of hanging or deadlocking.
 * Returns the filenames applied in this run.
 */
export async function applySchema(
  pool: ConnectablePool,
  sqlDir: string,
  files: string[] = tenant().sqlFiles,
  schema: string | null = tenant().schema,
): Promise<string[]> {
  const client = pool.connect ? await pool.connect() : null;
  try {
    return await applyWith(client ?? pool, sqlDir, files, schema);
  } finally {
    client?.release();
  }
}

/**
 * `files` are paths relative to sqlDir in the order to apply (the tenant's list, so the
 * Polish tenant never sees the ЄДРСР files). `schema`, when set, is created first; the
 * connection's search_path (db.ts) then makes it the home of every unqualified table.
 */
async function applyWith(pool: Queryable, sqlDir: string, files: string[], schema: string | null): Promise<string[]> {
  if (schema) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`invalid schema name: ${schema}`);
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  }
  await pool.query(
    'CREATE TABLE IF NOT EXISTS attorney_crm_schema_version (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
  );
  await pool.query('ALTER TABLE attorney_crm_schema_version ADD COLUMN IF NOT EXISTS sha256 TEXT');
  const done = await pool.query<{ filename: string; sha256: string | null }>('SELECT filename, sha256 FROM attorney_crm_schema_version');
  const recorded = new Map(done.rows.map((r) => [r.filename, r.sha256]));
  const applied: string[] = [];
  for (const file of files) {
    const sql = fs.readFileSync(path.join(sqlDir, file), 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    if (recorded.get(file) === hash) continue;
    await pool.query('BEGIN');
    try {
      await pool.query("SET LOCAL lock_timeout = '10s'");
      await pool.query(sql);
      await pool.query(
        'INSERT INTO attorney_crm_schema_version (filename, sha256) VALUES ($1, $2) ON CONFLICT (filename) DO UPDATE SET sha256 = EXCLUDED.sha256, applied_at = NOW()',
        [file, hash],
      );
      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK');
      throw new Error(`schema ${file}: ${(err as Error).message}`);
    }
    applied.push(file);
  }
  return applied;
}
