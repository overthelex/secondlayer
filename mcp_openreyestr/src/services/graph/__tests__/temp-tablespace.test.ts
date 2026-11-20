import { tempTablespaceName, useTempTablespace } from '../temp-tablespace';

function fake(rows: any[]) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: /pg_tablespace/.test(sql) ? rows : [] };
    },
  };
}

describe('tempTablespaceName', () => {
  it('defaults to bulk', () => expect(tempTablespaceName({})).toBe('bulk'));
  it('takes GRAPH_TEMP_TABLESPACE', () => expect(tempTablespaceName({ GRAPH_TEMP_TABLESPACE: ' fast ' })).toBe('fast'));
  it('empty disables', () => expect(tempTablespaceName({ GRAPH_TEMP_TABLESPACE: '' })).toBeNull());
});

describe('useTempTablespace', () => {
  it('sets temp_tablespaces when the tablespace exists and is usable', async () => {
    const c = fake([{ ok: true }]);
    expect(await useTempTablespace(c, undefined, 'bulk')).toBe('bulk');
    expect(c.calls[1]).toEqual({ sql: `SELECT set_config('temp_tablespaces', $1, false)`, params: ['bulk'] });
  });
  it('leaves the session alone when the tablespace is absent', async () => {
    const c = fake([]);
    expect(await useTempTablespace(c, undefined, 'bulk')).toBeNull();
    expect(c.calls).toHaveLength(1);
  });
  it('leaves the session alone without CREATE privilege', async () => {
    const c = fake([{ ok: false }]);
    expect(await useTempTablespace(c, undefined, 'bulk')).toBeNull();
    expect(c.calls).toHaveLength(1);
  });
  it('does nothing when disabled', async () => {
    const c = fake([{ ok: true }]);
    expect(await useTempTablespace(c, undefined, null)).toBeNull();
    expect(c.calls).toHaveLength(0);
  });
});
