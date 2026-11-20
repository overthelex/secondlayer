/**
 * Tablespace `bulk` for temp-file spill on the HDD (LEXAI-2320), run by migrate.ts after the .sql files.
 *
 * Not a .sql migration: CREATE TABLESPACE cannot run inside a transaction block, so it cannot sit in
 * a DO block (needed for "only if the location exists"), and a multi-statement file is one implicit
 * transaction. Here every statement is its own simple query (autocommit). Idempotent and run on every
 * migrate, so a host that gets the mount later picks it up on the next deploy.
 *
 * Location /mnt/bulk_ts is a bind mount of /mnt/bulk_storage/pg_openreyestr_ts in
 * docker-compose.local.yml; the container's entrypoint creates it owned by postgres before the server
 * starts. Without the mount (dev, CI, prod compose) the directory is absent and nothing happens.
 *
 * Never fails the migration run: the app waits for this container to exit 0, and a missing spill
 * tablespace only means temp files stay in pg_default. Problems are logged as warnings.
 */
export interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }
export interface Log { info(m: string): unknown; warn(m: string): unknown }

export const BULK_TABLESPACE = 'bulk';
export const BULK_TABLESPACE_LOCATION = '/mnt/bulk_ts';

export type BulkTablespaceOutcome = 'exists' | 'created' | 'no-location' | 'skipped' | 'failed';

export async function ensureBulkTablespace(db: Queryable, log: Log = console,
  name = BULK_TABLESPACE, location = BULK_TABLESPACE_LOCATION): Promise<BulkTablespaceOutcome> {
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || !/^\/[A-Za-z0-9_./-]+$/.test(location)) {
    throw new Error(`bad tablespace name or location: ${name} ${location}`);
  }
  try {
    const have = (await db.query('SELECT pg_tablespace_location(oid) AS loc FROM pg_tablespace WHERE spcname = $1', [name])).rows[0];
    if (have) {
      log.info(`Tablespace ${name} exists (${have.loc})`);
      return 'exists';
    }
    let isDir: boolean | null;
    try {
      // missing_ok = true: NULL for an absent path. Needs superuser or pg_read_server_files.
      isDir = (await db.query('SELECT (pg_stat_file($1, true)).isdir AS d', [location])).rows[0]?.d ?? null;
    } catch (e: any) {
      log.warn(`Tablespace ${name}: cannot check ${location} (${e.message}), skipped`);
      return 'skipped';
    }
    if (!isDir) {
      log.info(`Tablespace ${name}: ${location} not present, skipped`);
      return 'no-location';
    }
    await db.query(`CREATE TABLESPACE ${name} LOCATION '${location}'`);
    log.info(`Tablespace ${name} created at ${location}`);
    return 'created';
  } catch (e: any) {
    log.warn(`Tablespace ${name} at ${location} not created: ${e.message}`);
    return 'failed';
  }
}
