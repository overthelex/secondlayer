import fs from 'fs';
import path from 'path';
import type { Queryable } from './db';

// pg.Pool hands each query to any idle connection, so BEGIN/COMMIT must run on one
// checked-out client. Fakes in tests may omit connect().
export interface ConnectablePool extends Queryable {
  connect?(): Promise<Queryable & { release(): void }>;
}

// 001 holds functions the daily worker calls; re-applying it on every boot ships
// function fixes without a new migration file. Everything in it is idempotent.
const ALWAYS_APPLY = new Set(['001_practice_derivation.sql']);

/**
 * Applies attorney_crm/sql/*.sql in lexical order, each inside one transaction,
 * skipping files already recorded in attorney_crm_schema_version (except ALWAYS_APPLY).
 * Returns the filenames applied in this run.
 */
export async function applySchema(pool: ConnectablePool, sqlDir: string): Promise<string[]> {
  const client = pool.connect ? await pool.connect() : null;
  try {
    return await applyWith(client ?? pool, sqlDir);
  } finally {
    client?.release();
  }
}

async function applyWith(pool: Queryable, sqlDir: string): Promise<string[]> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS attorney_crm_schema_version (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
  );
  const done = await pool.query<{ filename: string }>('SELECT filename FROM attorney_crm_schema_version');
  const recorded = new Set(done.rows.map((r) => r.filename));
  const files = fs.readdirSync(sqlDir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (recorded.has(file) && !ALWAYS_APPLY.has(file)) continue;
    const sql = fs.readFileSync(path.join(sqlDir, file), 'utf8');
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query(
        'INSERT INTO attorney_crm_schema_version (filename) VALUES ($1) ON CONFLICT (filename) DO UPDATE SET applied_at = NOW()',
        [file],
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
