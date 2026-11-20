import type { EdgeKind, NodeKind } from '../keys';
import { EdgeFilter, GraphEdge, GraphNode, GraphStore, traverse } from '../neighbourhood';
import {
  bidirectionalSearch, describePath, enumeratePaths, outEdge, outNode, pathsFromStart, resolveStartKey, snapshotGap,
} from '../connections';

function memStore(nodes: GraphNode[], edges: GraphEdge[]): GraphStore & { calls: number[][] } {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const ok = (e: GraphEdge, f: EdgeFilter) =>
    (!f.kinds || f.kinds.includes(e.kind))
    && (!f.asOf || ((e.valid_from === null || e.valid_from <= f.asOf) && (e.valid_to === null || e.valid_to >= f.asOf)))
    && (!f.currentOnly || e.valid_to === null);
  const calls: number[][] = [];
  return {
    calls,
    async nodeByKey(kind, key) { return nodes.find(n => n.kind === kind && n.key === key) || null; },
    async nodeById(id) { return byId.get(id) || null; },
    async nodesByIds(ids) { return ids.map(i => byId.get(i)).filter((n): n is GraphNode => !!n); },
    async edgesOf(ids, f, limit) {
      calls.push([...ids]);
      const out: Array<{ via: number; edge: GraphEdge }> = [];
      const sorted = [...edges].sort((a, b) => a.id - b.id);
      for (const id of ids) {
        out.push(...sorted.filter(e => e.src === id && ok(e, f)).slice(0, limit).map(edge => ({ via: id, edge })));
        out.push(...sorted.filter(e => e.dst === id && e.src !== id && ok(e, f)).slice(0, limit).map(edge => ({ via: id, edge })));
      }
      return out;
    },
  };
}

let eid = 0;
const N = (id: number, kind: NodeKind = 'company', hub = false, label: string | null = null): GraphNode =>
  ({ id, kind, key: kind === 'company' ? String(10000000 + id) : `k${id}`, label: label ?? `L${id}`, degree: 1, hub, attrs: {} });
const E = (src: number, dst: number, kind: EdgeKind = 'founder', valid_from: string | null = null, valid_to: string | null = null): GraphEdge =>
  ({ id: ++eid, src, dst, kind, valid_from, valid_to, source: 'edr_hist', source_ref: { hist: { first_seen: '2018-09-22', last_seen: '2021-11-01' } }, attrs: {} });
const opts = (o: Partial<{ maxDepth: number; includeHubs: boolean; asOf: string | null; maxFanout: number; visitBudget: number }> = {}) => ({
  maxDepth: o.maxDepth ?? 4, includeHubs: o.includeHubs ?? false, maxFanout: o.maxFanout ?? 50, visitBudget: o.visitBudget ?? 1000,
  filter: { kinds: null, asOf: o.asOf ?? null, currentOnly: false } as EdgeFilter,
});

describe('resolveStartKey', () => {
  it('reads codes, names, addresses and prefixes', () => {
    expect(resolveStartKey('32945')).toMatchObject({ kind: 'company', key: '00032945', inferred: 'company' });
    expect(resolveStartKey('Іваненко Іван Іванович')).toMatchObject({ kind: 'person_name', inferred: 'person' });
    expect(resolveStartKey('01001, м. Київ, вул. Хрещатик, 10')).toMatchObject({ kind: 'address', inferred: 'address' });
    expect(resolveStartKey('company:11111110')).toMatchObject({ kind: 'company', key: '11111110' });
    expect(resolveStartKey('node:42')).toMatchObject({ id: 42 });
    // a code-looking start forced to person is a person
    expect(resolveStartKey('Петренко Петро', 'person')).toMatchObject({ kind: 'person_name' });
  });

  it('refuses empty and placeholder starts in Ukrainian', () => {
    expect(() => resolveStartKey('  ')).toThrow('Вкажіть початок');
    expect(() => resolveStartKey('АКЦІОНЕРИ ЗГІДНО РЕЄСТРУ')).toThrow('Не вдалося розпізнати ПІБ');
  });
});

describe('output shape', () => {
  beforeEach(() => { eid = 0; });

  it('marks persons name_only and lifts snapshot dates out of source_ref', () => {
    const p = outNode({ ...N(1, 'person_name'), depth: 1 });
    expect(p).toMatchObject({ id: 'n1', type: 'person_name', match_level: 'name_only', depth: 1 });
    expect(outNode(N(2)).match_level).toBeUndefined();
    const e = outEdge({ ...E(1, 2), source_ref: { current: { dump: '2026-11-18', rows: ['founders:1'] } }, attrs: { role_class: 'head', role: 'керівник' } });
    expect(e).toMatchObject({ id: 'e1', from: 'n1', to: 'n2', type: 'founder', refs: ['founders:1'], attrs: { role: 'керівник' } });
    expect(e.snapshots).toEqual({ current_dump: '2026-11-18' });
    const c = outNode({ ...N(3), attrs: { status: 'зареєстровано', degree_by_kind: { head: 1 }, first_seen: '2016-07-25' } });
    expect(c.attrs).toEqual({ status: 'зареєстровано' });
    expect(outNode({ ...N(3), attrs: { degree_by_kind: { head: 1 } } }, { full: true }).attrs).toEqual({ degree_by_kind: { head: 1 } });
  });

  it('paths from the start prefer indirect companies and read in both directions', async () => {
    // person 2 founded 1 and 3; 3 is at depth 2
    const nodes = [N(1), N(2, 'person_name', false, 'ПЕТРЕНКО П.'), N(3), N(4, 'address')];
    const edges = [E(2, 1), E(2, 3, 'head'), E(1, 4, 'registered_at')];
    const r = await traverse(memStore(nodes, edges), nodes[0], { depth: 2 });
    const paths = pathsFromStart(r, 10);
    expect(paths).toHaveLength(1);
    expect(paths[0].length).toBe(2);
    expect(paths[0].has_person).toBe(true);
    expect(paths[0].text).toBe('L1 (10000001) ←засновник— ПЕТРЕНКО П. [ПІБ] —керівник→ L3 (10000003)');
    expect(paths[0]).toMatchObject({ nodes: ['n1', 'n2', 'n3'], edges: ['e1', 'e2'], edge_types: ['founder', 'head'] });
  });

  it('snapshotGap warns only for the long gaps between dumps', () => {
    const src = { snapshots: ['2018-09-22', '2021-10-18', '2021-11-01'], current_dump: '2026-11-18', built_at: null };
    expect(snapshotGap('2024-01-01', src)).toEqual({ from: '2021-11-01', to: '2026-11-18' });
    expect(snapshotGap('2021-10-20', src)).toBeNull();
    expect(snapshotGap('2021-11-01', src)).toBeNull();
    expect(snapshotGap(null, src)).toBeNull();
  });
});

describe('bidirectionalSearch', () => {
  beforeEach(() => { eid = 0; });

  it('finds every shortest path and nothing longer', async () => {
    // 1 - 2 - 4 and 1 - 3 - 4 (length 2); 1 - 5 - 6 - 4 (length 3)
    const nodes = [1, 2, 3, 4, 5, 6].map(i => N(i));
    const edges = [E(1, 2), E(2, 4), E(1, 3), E(3, 4), E(1, 5), E(5, 6), E(6, 4)];
    const st = memStore(nodes, edges);
    const r = await bidirectionalSearch(st, nodes[0], nodes[3], opts());
    expect(r.length).toBe(2);
    const paths = enumeratePaths(r, 10).map(p => p.nodes);
    expect(paths.sort()).toEqual([[1, 2, 4], [1, 3, 4]]);
    // each side expanded once
    expect(st.calls).toHaveLength(2);
  });

  it('reconstructs an odd-length path whose edges point either way', async () => {
    const nodes = [1, 2, 3, 4].map(i => N(i));
    const edges = [E(2, 1), E(2, 3, 'head'), E(4, 3)];
    const r = await bidirectionalSearch(memStore(nodes, edges), nodes[0], nodes[3], opts());
    expect(r.length).toBe(3);
    const [p] = enumeratePaths(r, 5);
    expect(p).toEqual({ nodes: [1, 2, 3, 4], edges: [1, 2, 3] });
    const d = describePath(p.nodes, p.edges, r.nodes, r.edges);
    expect(d.text).toBe('L1 (10000001) ←засновник— L2 (10000002) —керівник→ L3 (10000003) ←засновник— L4 (10000004)');
  });

  it('does not pass through a hub, not even by meeting on it, unless asked', async () => {
    // two companies at one mass-registration address
    const nodes = [N(1), N(2, 'address', true), N(3)];
    const edges = [E(1, 2, 'registered_at'), E(3, 2, 'registered_at')];
    const r = await bidirectionalSearch(memStore(nodes, edges), nodes[0], nodes[2], opts());
    expect(r.length).toBeNull();
    expect(r.truncated.hubs).toEqual([2]);
    const through = await bidirectionalSearch(memStore(nodes, edges), nodes[0], nodes[2], opts({ includeHubs: true }));
    expect(through.length).toBe(2);
    // a hub as an end is expanded and can be the target
    const toHub = await bidirectionalSearch(memStore(nodes, edges), nodes[0], nodes[1], opts());
    expect(toHub.length).toBe(1);
  });

  it('a hub on one side is reached but not expanded', async () => {
    // 1 - H - 2 - 3: side 1 reaches H and stops there
    const nodes = [N(1), N(9, 'person_name', true), N(2), N(3)];
    const edges = [E(9, 1), E(9, 2), E(2, 3, 'reg_neighbour')];
    const r = await bidirectionalSearch(memStore(nodes, edges), nodes[0], nodes[3], opts({ maxDepth: 4 }));
    expect(r.length).toBeNull();
    expect(r.truncated.hubs).toEqual([9]);
    const r2 = await bidirectionalSearch(memStore(nodes, edges), nodes[0], nodes[3], opts({ maxDepth: 4, includeHubs: true }));
    expect(r2.length).toBe(3);
    expect(enumeratePaths(r2, 5)[0].nodes).toEqual([1, 9, 2, 3]);
  });

  it('respects as_of and the visit budget', async () => {
    const nodes = [1, 2, 3].map(i => N(i));
    const edges = [E(1, 2, 'founder', null, '2018-09-22'), E(2, 3)];
    expect((await bidirectionalSearch(memStore(nodes, edges), nodes[0], nodes[2], opts({ asOf: '2021-11-01' }))).length).toBeNull();
    expect((await bidirectionalSearch(memStore(nodes, edges), nodes[0], nodes[2], opts({ asOf: '2018-01-01' }))).length).toBe(2);
    const big = await bidirectionalSearch(memStore(nodes, edges), nodes[0], nodes[2], opts({ visitBudget: 2 }));
    expect(big.truncated.budget).toBe(true);
  });

  it('a start equal to the target is length 0', async () => {
    const n = N(1);
    const r = await bidirectionalSearch(memStore([n], []), n, n, opts());
    expect(r.length).toBe(0);
    expect(enumeratePaths(r, 5)).toEqual([{ nodes: [1], edges: [] }]);
  });
});
