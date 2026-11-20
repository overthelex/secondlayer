/**
 * Temp-file spill of the graph builds on a separate tablespace (LEXAI-2320).
 *
 * On cthulhu the openreyestr database lives on the NVMe root, and one co_party INSERT of a full
 * build spilled 240 GB into base/pgsql_tmp there (disk at 99 %). Migration step
 * ensure-bulk-tablespace.ts creates tablespace `bulk` on the HDD (/mnt/bulk_ts in the container);
 * the build sessions point temp_tablespaces at it, so their sort / hash / index-build spill files go
 * to the HDD. Only temp files move: graph_stage tables are ordinary (unlogged) tables in
 * pg_default, because the swap moves them into graph with ALTER TABLE ... SET SCHEMA, which keeps
 * their tablespace, and the live graph must stay on the NVMe.
 *
 * Session-scoped on purpose: live MCP queries keep spilling to pg_default (NVMe, fast, small),
 * only the multi-hour batch builds use the HDD.
 *
 * GRAPH_TEMP_TABLESPACE overrides the name; an empty value disables it. No such tablespace (dev,
 * CI, a host without the mount) = no change.
 */
export interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }

export const DEFAULT_TEMP_TABLESPACE = 'bulk';

/** Name to use: GRAPH_TEMP_TABLESPACE if set (empty = none), else `bulk`. */
export function tempTablespaceName(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.GRAPH_TEMP_TABLESPACE;
  const name = (v === undefined ? DEFAULT_TEMP_TABLESPACE : v).trim();
  return name || null;
}

/**
 * SET temp_tablespaces for this session if the tablespace exists and the role may use it.
 * Returns the tablespace set, or null (session left on pg_default). Undo with RESET temp_tablespaces.
 */
export async function useTempTablespace(c: Queryable, log: (m: string) => void = () => undefined,
  name: string | null = tempTablespaceName()): Promise<string | null> {
  if (!name) return null;
  const row = (await c.query(
    `SELECT has_tablespace_privilege(oid, 'CREATE') AS ok FROM pg_tablespace WHERE spcname = $1`, [name])).rows[0];
  if (!row) {
    log(`Temp files: tablespace ${name} not found, spilling to pg_default`);
    return null;
  }
  if (!row.ok) {
    log(`Temp files: no CREATE privilege on tablespace ${name}, spilling to pg_default`);
    return null;
  }
  await c.query(`SELECT set_config('temp_tablespaces', $1, false)`, [name]);
  log(`Temp files: tablespace ${name}`);
  return name;
}
