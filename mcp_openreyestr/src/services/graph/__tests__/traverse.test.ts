import { EdgeFilter, GraphEdge, GraphNode, GraphStore, normaliseOptions, traverse } from '../neighbourhood';
import type { EdgeKind, NodeKind } from '../keys';

/** In-memory store with the filter semantics of edgeFilterSql. */
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
      for (const id of ids) {
        const sorted = [...edges].sort((a, b) => a.id - b.id);
        out.push(...sorted.filter(e => e.src === id && ok(e, f)).slice(0, limit).map(edge => ({ via: id, edge })));
        out.push(...sorted.filter(e => e.dst === id && e.src !== id && ok(e, f)).slice(0, limit).map(edge => ({ via: id, edge })));
      }
      return out;
    },
  };
}

let eid = 0;
const N = (id: number, kind: NodeKind = 'company', hub = false): GraphNode => ({ id, kind, key: String(id), label: null, degree: 0, hub, attrs: {} });
const E = (src: number, dst: number, kind: EdgeKind = 'founder', valid_from: string | null = null, valid_to: string | null = null): GraphEdge =>
  ({ id: ++eid, src, dst, kind, valid_from, valid_to, source: 'edr_hist', source_ref: {}, attrs: {} });

describe('graph traversal', () => {
  beforeEach(() => { eid = 0; });

  it('walks a cycle once and stops at the depth', async () => {
    // 1 -> 2 -> 3 -> 1 (cycle), 3 -> 4 -> 5
    const nodes = [1, 2, 3, 4, 5].map(i => N(i));
    const edges = [E(1, 2), E(2, 3), E(3, 1), E(3, 4), E(4, 5)];
    const st = memStore(nodes, edges);
    const r = await traverse(st, nodes[0], { depth: 2 });
    expect(r.nodes.map(n => [n.id, n.depth])).toEqual([[1, 0], [2, 1], [3, 1], [4, 2]]);
    // the cycle edge 2-3 is found from both ends but kept once
    expect(r.edges.map(e => e.id)).toEqual([1, 2, 3, 4]);
    expect(st.calls).toEqual([[1], [2, 3]]);
    const r3 = await traverse(st, nodes[0], { depth: 3 });
    expect(r3.nodes.map(n => n.id)).toEqual([1, 2, 3, 4, 5]);
    expect(r3.nodes.find(n => n.id === 5)!.depth).toBe(3);
  });

  it('reaches a hub but does not expand it, except as the start', async () => {
    // 1 -registered_at-> 10 (hub address) <- 2, 3; 1 -> 4 -> 5
    const nodes = [N(1), N(2), N(3), N(4), N(5), N(10, 'address', true)];
    const edges = [E(1, 10, 'registered_at'), E(2, 10, 'registered_at'), E(3, 10, 'registered_at'), E(4, 1), E(4, 5)];
    const st = memStore(nodes, edges);
    const r = await traverse(st, nodes[0], { depth: 3 });
    expect(r.nodes.map(n => n.id).sort((a, b) => a - b)).toEqual([1, 4, 5, 10]);
    expect(r.truncated.hubs).toEqual([10]);
    const open = await traverse(st, nodes[0], { depth: 3, stopAtHubs: false });
    expect(open.nodes.map(n => n.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 10]);
    const fromHub = await traverse(st, nodes[5], { depth: 1 });
    expect(fromHub.nodes.map(n => n.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 10]);
  });

  it('filters by date: valid_from NULL is open, valid_to NULL is current', async () => {
    const nodes = [N(1), N(2, 'person_name'), N(3, 'person_name'), N(4, 'person_name'), N(5, 'address')];
    const edges = [
      E(2, 1, 'founder', null, '2018-09-22'),            // gone after 2018
      E(3, 1, 'founder', '2021-10-18', null),            // since 2021, current
      E(4, 1, 'head', '2016-07-25', '2021-11-01'),       // 2016-2021
      E(1, 5, 'registered_at', null, null),
    ];
    const st = memStore(nodes, edges);
    const ids = async (o: any) => (await traverse(st, nodes[0], { depth: 1, ...o })).nodes.map(n => n.id).sort((a, b) => a - b);
    expect(await ids({ asOf: '2017-01-01' })).toEqual([1, 2, 4, 5]);
    expect(await ids({ asOf: '2020-06-01' })).toEqual([1, 4, 5]);
    expect(await ids({ asOf: '2026-11-18' })).toEqual([1, 3, 5]);
    expect(await ids({ currentOnly: true })).toEqual([1, 3, 5]);
    expect(await ids({ kinds: ['head'] })).toEqual([1, 4]);
    expect(await ids({})).toEqual([1, 2, 3, 4, 5]);
  });

  it('caps the fanout per node and the node budget', async () => {
    const nodes = [N(1), ...Array.from({ length: 10 }, (_, i) => N(100 + i, 'person_name'))];
    const edges = nodes.slice(1).map(n => E(n.id, 1));
    const st = memStore(nodes, edges);
    const r = await traverse(st, nodes[0], { depth: 1, maxFanout: 4 });
    expect(r.nodes.map(n => n.id)).toEqual([1, 100, 101, 102, 103]);
    expect(r.truncated.fanout).toEqual([1]);
    const b = await traverse(st, nodes[0], { depth: 1, maxNodes: 3 });
    expect(b.nodes).toHaveLength(3);
    expect(b.truncated.maxNodes).toBe(true);
    expect(b.edges).toHaveLength(2);
  });

  it('keeps self-loops once and drops edges to missing nodes', async () => {
    const nodes = [N(1), N(2)];
    const edges = [E(1, 1, 'reg_neighbour'), E(1, 2), E(1, 99)];
    const r = await traverse(memStore(nodes, edges), nodes[0], { depth: 2 });
    expect(r.nodes.map(n => n.id)).toEqual([1, 2]);
    expect(r.edges.map(e => e.id)).toEqual([1, 2]);
  });

  it('validates options', () => {
    expect(() => normaliseOptions({ depth: 4 })).toThrow();
    expect(() => normaliseOptions({ asOf: '2021/01/01' })).toThrow();
    expect(() => normaliseOptions({ kinds: ['owner' as any] })).toThrow();
    expect(normaliseOptions({}).depth).toBe(2);
  });
});
