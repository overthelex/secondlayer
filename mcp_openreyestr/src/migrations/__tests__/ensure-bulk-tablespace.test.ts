import { ensureBulkTablespace } from '../ensure-bulk-tablespace';

const quiet = { info: () => undefined, warn: () => undefined } as any;

function fake(opts: { exists?: boolean; isDir?: boolean | null; statError?: string; createError?: string }) {
  const sqls: string[] = [];
  return {
    sqls,
    query: async (sql: string) => {
      sqls.push(sql);
      if (/FROM pg_tablespace/.test(sql)) return { rows: opts.exists ? [{ loc: '/mnt/bulk_ts' }] : [] };
      if (/pg_stat_file/.test(sql)) {
        if (opts.statError) throw new Error(opts.statError);
        return { rows: [{ d: opts.isDir ?? null }] };
      }
      if (/CREATE TABLESPACE/.test(sql) && opts.createError) throw new Error(opts.createError);
      return { rows: [] };
    },
  };
}

describe('ensureBulkTablespace', () => {
  it('is a no-op when the tablespace exists', async () => {
    const db = fake({ exists: true });
    expect(await ensureBulkTablespace(db, quiet)).toBe('exists');
    expect(db.sqls).toHaveLength(1);
  });
  it('skips when the location is absent', async () => {
    const db = fake({ isDir: null });
    expect(await ensureBulkTablespace(db, quiet)).toBe('no-location');
    expect(db.sqls.some(s => /CREATE TABLESPACE/.test(s))).toBe(false);
  });
  it('creates it as a standalone statement when the location is a directory', async () => {
    const db = fake({ isDir: true });
    expect(await ensureBulkTablespace(db, quiet)).toBe('created');
    expect(db.sqls[2]).toBe(`CREATE TABLESPACE bulk LOCATION '/mnt/bulk_ts'`);
  });
  it('skips without permission to stat the location', async () => {
    const db = fake({ statError: 'permission denied for function pg_stat_file' });
    expect(await ensureBulkTablespace(db, quiet)).toBe('skipped');
  });
  it('does not throw when CREATE TABLESPACE fails', async () => {
    const db = fake({ isDir: true, createError: 'could not set permissions on directory' });
    expect(await ensureBulkTablespace(db, quiet)).toBe('failed');
  });
  it('rejects unsafe names', async () => {
    await expect(ensureBulkTablespace(fake({}), quiet, 'x; drop', '/mnt/bulk_ts')).rejects.toThrow('bad tablespace');
  });
});
