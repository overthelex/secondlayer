import { Pool } from 'pg';
import { OpenReyestrTools } from '../openreyestr-tools';
import { MCPOpenReyestrAPI } from '../mcp-openreyestr-api';
import { personKey } from '../../services/graph/keys';

// the real logger pulls in @secondlayer/shared (express, ESM uuid); the API only logs
jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

/**
 * A mocked pool that answers the graph queries of the tools from a tiny in-memory graph:
 * 11111110 (ТОВ "АЛЬФА") <-founder- person -head-> 22222220 (ТОВ "БЕТА") -registered_at-> hub address
 * <-registered_at- 33333330 (ТОВ "ГАМА").
 */
const PERSON = 'ПЕТРЕНКО ПЕТРО ПЕТРОВИЧ';
const NODES = [
  { id: 1, kind: 'company', key: '11111110', label: 'ТОВ "АЛЬФА"', degree: 1, hub: false, attrs: { status: 'зареєстровано' } },
  { id: 2, kind: 'person_name', key: personKey(PERSON)!, label: PERSON, degree: 2, hub: false, attrs: {} },
  { id: 3, kind: 'company', key: '22222220', label: 'ТОВ "БЕТА"', degree: 2, hub: false, attrs: {} },
  { id: 4, kind: 'address', key: 'UA-80|м|киив|вул|хрещатик|1', label: 'місто київ, вулиця хрещатик, 1', degree: 900, hub: true, attrs: { key_version: 'a1' } },
  { id: 5, kind: 'company', key: '33333330', label: 'ТОВ "ГАМА"', degree: 1, hub: false, attrs: {} },
];
const EDGES = [
  { id: 10, src: 2, dst: 1, kind: 'founder', valid_from: null, valid_to: null, source: 'edr_hist',
    source_ref: { hist: { first_seen: '2018-09-22', last_seen: '2021-11-01' }, current: { dump: '2026-11-18', rows: ['founders:1'] } },
    attrs: { contribution: '1000,00 грн.' } },
  { id: 11, src: 2, dst: 3, kind: 'head', valid_from: '2021-10-18', valid_to: '2021-11-01', source: 'edr_hist',
    source_ref: { hist: { first_seen: '2021-10-18', last_seen: '2021-11-01' } }, attrs: { role: 'керівник' } },
  { id: 12, src: 3, dst: 4, kind: 'registered_at', valid_from: null, valid_to: '2021-11-01', source: 'edr_hist', source_ref: {}, attrs: {} },
  { id: 13, src: 5, dst: 4, kind: 'registered_at', valid_from: null, valid_to: '2021-11-01', source: 'edr_hist', source_ref: {}, attrs: {} },
];
const BUILD = { sources: { snapshots: ['2016-07-25', '2018-09-22', '2021-10-18', '2021-11-01'], useCurrent: true, currentDate: '2026-11-18' }, finished_at: '2026-11-20T03:00:00Z' };

function graphPool(opts: { built?: boolean } = {}) {
  const sqls: string[] = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    sqls.push(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql)) return { rows: [] };
    if (sql.includes('.build')) return { rows: opts.built === false ? [] : [BUILD] };
    if (sql.includes('street_renamings')) return { rows: [] };
    if (sql.includes('WHERE kind = $1 AND key = $2')) return { rows: NODES.filter(n => n.kind === params[0] && n.key === params[1]) };
    if (sql.includes('WHERE id = ANY')) return { rows: NODES.filter(n => params[0].map(Number).includes(n.id)) };
    if (sql.includes('WHERE id = $1')) return { rows: NODES.filter(n => n.id === Number(params[0])) };
    if (sql.includes('unnest($1::bigint[])')) {
      const [ids, kinds, asOf] = params;
      const ok = (e: any) => (!kinds || kinds.includes(e.kind))
        && (!asOf || ((e.valid_from === null || e.valid_from <= asOf) && (e.valid_to === null || e.valid_to >= asOf)));
      const out: any[] = [];
      for (const id of ids.map(Number)) {
        for (const e of EDGES) if ((e.src === id || (e.dst === id && e.src !== id)) && ok(e)) out.push({ via: id, ...e });
      }
      return { rows: out };
    }
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  });
  const release = jest.fn();
  const pool = { query, connect: jest.fn(async () => ({ query, release })) } as unknown as Pool;
  return { pool, query, release, sqls };
}

describe('openreyestr find_connections', () => {
  it('returns the neighbourhood in the graph shape, person as name_only, hub not expanded', async () => {
    const { pool, sqls, release } = graphPool();
    const r = await new OpenReyestrTools(pool).findConnections({ start: '22222220' });
    expect(r.found).toBe(true);
    expect(r.start).toMatchObject({ id: 'n3', type: 'company', label: 'ТОВ "БЕТА"' });
    expect(r.graph.root).toEqual({ id: 'n3', type: 'company', key: '22222220', label: 'ТОВ "БЕТА"' });
    expect(r.graph.nodes.map((n: any) => [n.id, n.depth])).toEqual([['n3', 0], ['n2', 1], ['n4', 1], ['n1', 2]]); // ГАМА only behind the hub
    expect(r.graph.nodes.find((n: any) => n.id === 'n2').match_level).toBe('name_only');
    expect(r.graph.nodes.find((n: any) => n.id === 'n4').attrs).toBeUndefined(); // key_version stripped
    const founder = r.graph.edges.find((e: any) => e.id === 'e10');
    expect(founder).toMatchObject({ from: 'n2', to: 'n1', type: 'founder', source: 'edr_hist', refs: ['founders:1'],
      snapshots: { first_seen: '2018-09-22', last_seen: '2021-11-01', current_dump: '2026-11-18' }, attrs: { contribution: '1000,00 грн.' } });
    expect(founder.source_ref).toBeUndefined();
    expect(r.graph.nodes.find((n: any) => n.id === 'n2').key).toBeUndefined(); // person key = transliterated name
    expect(r.legend.edge_types.founder).toBe('засновник');
    expect(r.truncated.hubs).toEqual([{ id: 'n4', type: 'address', label: 'місто київ, вулиця хрещатик, 1', degree: 900 }]);
    expect(r.notes.join(' ')).toContain('include_hubs');
    expect(r.paths[0].text).toBe('ТОВ "БЕТА" (22222220) ←керівник— ПЕТРЕНКО ПЕТРО ПЕТРОВИЧ [ПІБ] —засновник→ ТОВ "АЛЬФА" (11111110)');
    expect(r.warnings.join(' ')).toContain('name_only');
    expect(r.data_limits).toContain('2026 не містить адрес');
    expect(r.sources.current_dump).toBe('2026-11-18');
    // read-only transaction with a statement timeout, client released
    expect(sqls[0]).toBe('BEGIN READ ONLY');
    expect(sqls[1]).toMatch(/^SET LOCAL statement_timeout = \d+$/);
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(release).toHaveBeenCalled();
  });

  it('include_source_refs returns the full source_ref', async () => {
    const r = await new OpenReyestrTools(graphPool().pool).findConnections({ start: '22222220', include_source_refs: true });
    expect(r.graph.edges.find((e: any) => e.id === 'e10').source_ref.hist.first_seen).toBe('2018-09-22');
  });

  it('include_hubs goes through the hub', async () => {
    const { pool } = graphPool();
    const r = await new OpenReyestrTools(pool).findConnections({ start: '22222220', include_hubs: true });
    expect(r.graph.nodes.map((n: any) => n.id)).toContain('n5');
    expect(r.truncated.hubs_total).toBe(0);
  });

  it('a person start warns that the name is only a candidate', async () => {
    const { pool } = graphPool();
    const r = await new OpenReyestrTools(pool).findConnections({ start: 'Петренко Петро Петрович', depth: 1 });
    expect(r.found).toBe(true);
    expect(r.query.start_type).toBe('person');
    expect(r.start).toMatchObject({ type: 'person_name', match_level: 'name_only' });
    expect(r.warnings[0]).toContain('різним людям');
    expect(r.summary.companies).toBe(2);
  });

  it('as_of filters the edges and warns inside the 2021-2026 gap', async () => {
    const { pool } = graphPool();
    const r = await new OpenReyestrTools(pool).findConnections({ start: '11111110', as_of: '2024-05-01' });
    expect(r.graph.edges.map((e: any) => e.id)).toEqual(['e10']);
    expect(r.warnings.join(' ')).toContain('між знімками ЄДР 2021-11-01 і 2026-11-18');
  });

  it('validates the input in Ukrainian without touching the database', async () => {
    const { pool, query } = graphPool();
    const t = new OpenReyestrTools(pool);
    expect((await t.findConnections({ start: '' })).error).toContain('Вкажіть початок');
    expect((await t.findConnections({ start: '11111110', as_of: '2024-02-30' })).error).toContain('YYYY-MM-DD');
    expect((await t.findConnections({ start: '11111110', kinds: ['owner'] })).error).toContain('невідомий тип');
    expect((await t.findConnections({ start: '11111110', depth: 2.5 })).error).toContain('depth');
    expect(query).not.toHaveBeenCalled();
  });

  it('clamps depth and max_nodes', async () => {
    const { pool } = graphPool();
    const r = await new OpenReyestrTools(pool).findConnections({ start: '11111110', depth: 9, max_nodes: 5000 });
    expect(r.query).toMatchObject({ depth: 3, max_nodes: 1000 });
  });

  it('says when the start or the graph is missing', async () => {
    const t = new OpenReyestrTools(graphPool().pool);
    const r = await t.findConnections({ start: '99999990' });
    expect(r.found).toBe(false);
    expect(r.message).toContain('ЄДРПОУ немає в графі');
    const none = await new OpenReyestrTools(graphPool({ built: false }).pool).findConnections({ start: '11111110' });
    expect(none).toEqual({ found: false, message: expect.stringContaining('ще не побудовано') });
  });
});

describe('openreyestr connection_path', () => {
  it('finds the path through a person and marks it as a hypothesis', async () => {
    const { pool } = graphPool();
    const r = await new OpenReyestrTools(pool).connectionPath({ from: '11111110', to: '22222220' });
    expect(r.found).toBe(true);
    expect(r.length).toBe(2);
    expect(r.paths).toHaveLength(1);
    expect(r.paths[0].has_person).toBe(true);
    expect(r.graph.root.id).toBe('n1');
    expect(r.graph.target.id).toBe('n3');
    expect(r.graph.nodes.map((n: any) => n.id).sort()).toEqual(['n1', 'n2', 'n3']);
    expect(r.graph.edges.map((e: any) => e.id)).toEqual(['e10', 'e11']);
    expect(r.notes.join(' ')).toContain('тезок');
    expect(r.warnings.join(' ')).toContain('name_only');
  });

  it('does not connect two companies through a mass-registration address unless include_hubs', async () => {
    const { pool } = graphPool();
    const t = new OpenReyestrTools(pool);
    const r = await t.connectionPath({ from: '22222220', to: '33333330' });
    expect(r.found).toBe(false);
    expect(r.truncated.hubs_total).toBe(1);
    expect(r.notes.join(' ')).toContain('include_hubs');
    const h = await t.connectionPath({ from: '22222220', to: '33333330', include_hubs: true });
    expect(h.found).toBe(true);
    expect(h.paths[0].text).toContain('—місцезнаходження→');
  });

  it('caps max_depth at 4 and reports a missing end', async () => {
    const t = new OpenReyestrTools(graphPool().pool);
    const r = await t.connectionPath({ from: '11111110', to: '99999990', max_depth: 7 });
    expect(r.found).toBe(false);
    expect(r.query.max_depth).toBe(4);
    expect(r.message).toContain('to («99999990»)');
  });
});

describe('MCP API registration', () => {
  it('lists both tools with required inputs and routes calls', async () => {
    const { pool } = graphPool();
    const api = new MCPOpenReyestrAPI(new OpenReyestrTools(pool));
    const tools = api.getTools();
    const fc = tools.find(t => t.name === 'find_connections')!;
    const cp = tools.find(t => t.name === 'connection_path')!;
    expect(fc.inputSchema.required).toEqual(['start']);
    expect(cp.inputSchema.required).toEqual(['from', 'to']);
    expect(fc.description).toContain('name_only');
    expect(fc.description).toContain('2026');
    const out = await api.handleToolCall('connection_path', { from: '11111110', to: '22222220' });
    expect(JSON.parse(out.content[0].text).found).toBe(true);
  });
});
