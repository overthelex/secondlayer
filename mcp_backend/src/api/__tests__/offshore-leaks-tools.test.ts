import { OffshoreLeaksTools, icijNameKey, icijNodeUrl, ICIJ_ATTRIBUTION, ICIJ_CAVEAT } from '../tools/offshore-leaks-tools.js';

const NODE = {
  node_id: '240221441', node_type: 'officer', name: 'IGOR KOLOMOISKYI', name_key: 'igor kolomoiskyi', original_name: 'IGOR KOLOMOISKYI',
  former_name: null, jurisdiction: null, jurisdiction_description: null, country_codes: ['UKR'], countries: ['Ukraine'],
  company_type: null, status: null, service_provider: null, incorporation_date: null, inactivation_date: null, struck_off_date: null,
  address: null, source_id: 'Pandora Papers - Alemán, Cordero, Galindo & Lee (Alcogal)', source_leak: 'Pandora Papers', note: null, _total: '1',
};

function fakeDb(edgeRows: any[] = [], totals: Record<string, number> = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  return {
    calls,
    query: async (sql: string, params: any[]) => {
      calls.push({ sql, params });
      if (/FROM icij_snapshots/.test(sql)) return { rows: [{ generated_on: '2026-09-09', loaded_at: '2026-11-19T23:31:22Z' }] };
      if (/CROSS JOIN LATERAL/.test(sql)) return { rows: edgeRows.filter((r) => params[0].includes(r.origin)) };
      if (/count\(\*\) FROM \(SELECT 1/.test(sql)) return { rows: params[0].map((id: string) => ({ origin: id, total: String(totals[id] ?? 0) })) };
      if (/DISTINCT ON \(node_id\)/.test(sql)) {
        return { rows: params[0].map((id: string) => ({ node_id: id, node_type: 'entity', name: `ENTITY ${id}`, jurisdiction: 'BVI', jurisdiction_description: 'British Virgin Islands', country_codes: ['VGB'] })) };
      }
      if (/FROM icij_nodes/.test(sql)) return { rows: [NODE] };
      return { rows: [] };
    },
  };
}

const run = async (db: any, args: any) => JSON.parse((await new OffshoreLeaksTools(db).executeTool('search_offshore_leaks', args))!.content[0].text);

describe('search_offshore_leaks (LEXAI-2311)', () => {
  it('normalises names the way the loader does', () => {
    expect(icijNameKey('Société Générale, S.A.')).toBe('societe generale s a');
    expect(icijNameKey('  KIENO_HOLDINGS   LTD. ')).toBe('kieno holdings ltd');
    expect(icijNameKey('Straße')).toBe('strasse');
    expect(icijNameKey('---')).toBeNull();
    expect(icijNodeUrl('240221441')).toBe('https://offshoreleaks.icij.org/nodes/240221441');
  });

  it('carries the ICIJ attribution and caveat in every response, errors included', async () => {
    const ok = await run(fakeDb(), { name: 'Kolomoiskyi' });
    expect(ok.attribution).toBe(ICIJ_ATTRIBUTION);
    expect(ok.caveat).toBe(ICIJ_CAVEAT);
    expect(ok.caveat).toMatch(/не означає/);
    const bad = await run(fakeDb(), {});
    expect(bad.error).toBeTruthy();
    expect(bad.attribution).toBe(ICIJ_ATTRIBUTION);
    expect(bad.caveat).toBe(ICIJ_CAVEAT);
    expect((await run(fakeDb(), { name: 'ab' })).error).toMatch(/3/);
    expect((await run(fakeDb(), { name: 'abc', country: 'Ukraine' })).error).toMatch(/alpha-3/);
    expect((await run(fakeDb(), { name: 'abc', source_leak: 'Lux Leaks' })).error).toMatch(/source_leak/);
    expect((await run(fakeDb(), { names: Array.from({ length: 51 }, (_, i) => `n${i}`) })).error).toMatch(/50/);
  });

  it('contains: LIKE on name_key with the exact key ranked first, filters as parameters', async () => {
    const db = fakeDb();
    const r = await run(db, { name: 'Kolomoiskyi', node_type: 'officer', country: 'ukr', source_leak: 'Pandora Papers', jurisdiction: 'bvi', hops: 0 });
    const q = db.calls.find((c) => /FROM icij_nodes/.test(c.sql) && /LIKE/.test(c.sql))!;
    expect(q.params).toContain('%kolomoiskyi%');
    expect(q.params).toContain('UKR');
    expect(q.params).toContain('BVI');
    expect(q.params).toContain('Pandora Papers');
    expect(q.sql).toMatch(/UNION/);
    expect(r.results[0]).toMatchObject({ node_id: '240221441', node_type: 'officer', source_leak: 'Pandora Papers', url: icijNodeUrl('240221441') });
    expect(r.results[0].relationships).toBeUndefined();
    expect(r.source).toMatchObject({ as_of: '2026-09-09' });
  });

  it('names: exact match on all keys', async () => {
    const db = fakeDb();
    const r = await run(db, { names: ['Igor Kolomoiskyi', 'IGOR  KOLOMOISKYI', 'Kieno Holdings Ltd'], match: 'contains', hops: 0 });
    expect(r.query.match).toBe('exact');
    const q = db.calls.find((c) => /name_key = ANY/.test(c.sql))!;
    expect(q.params[0]).toEqual(['igor kolomoiskyi', 'kieno holdings ltd']);
  });

  it('caps edges per node and reports the true total and truncation', async () => {
    const edges = Array.from({ length: 30 }, (_, i) => ({
      origin: '240221441', direction: 'out', other_id: `e${i}`, rel_type: 'officer_of', link: 'beneficial owner of',
      start_date: '2014-03-01', end_date: null, status: null, source_leak: 'Pandora Papers',
    }));
    const r = await run(fakeDb(edges, { '240221441': 30 }), { name: 'kolomoiskyi', edges_per_node: 5 });
    const rel = r.results[0].relationships;
    expect(rel).toMatchObject({ total: 30, shown: 5, truncated: true });
    expect(rel.items[0]).toMatchObject({
      direction: 'out', rel_type: 'officer_of', link: 'beneficial owner of', start_date: '2014-03-01', source_leak: 'Pandora Papers',
      node: { node_id: 'e0', name: 'ENTITY e0', jurisdiction: 'British Virgin Islands', url: icijNodeUrl('e0') },
    });
    expect(rel.items[0].rel_label).toMatch(/акціонер|бенефіціар/);
  });

  it('second hop expands a bounded number of neighbours', async () => {
    const edges = [
      { origin: '240221441', direction: 'out', other_id: 'e1', rel_type: 'officer_of', source_leak: 'Pandora Papers' },
      { origin: 'e1', direction: 'in', other_id: '240221441', rel_type: 'officer_of', source_leak: 'Pandora Papers' },
      { origin: 'e1', direction: 'in', other_id: 'i9', rel_type: 'intermediary_of', source_leak: 'Pandora Papers' },
    ];
    const r = await run(fakeDb(edges, { '240221441': 1, e1: 2 }), { name: 'kolomoiskyi', hops: 2 });
    const next = r.results[0].relationships.items[0].next_hop;
    // the edge back to the origin is not repeated
    expect(next.items.map((x: any) => x.node.node_id)).toEqual(['i9']);
    expect(next.items[0].rel_type).toBe('intermediary_of');
  });

  it('a database timeout becomes a Ukrainian hint, still with attribution', async () => {
    const db = { query: async () => { const e: any = new Error('canceling statement'); e.code = '57014'; throw e; } };
    const res = await new OffshoreLeaksTools(db).executeTool('search_offshore_leaks', { name: 'limited' });
    expect(res!.isError).toBe(true);
    const body = JSON.parse(res!.content[0].text);
    expect(body.error).toMatch(/ліміт часу/);
    expect(body.caveat).toBe(ICIJ_CAVEAT);
  });

  it('ignores other tool names', async () => {
    expect(await new OffshoreLeaksTools(fakeDb()).executeTool('other', {})).toBeNull();
  });
});
