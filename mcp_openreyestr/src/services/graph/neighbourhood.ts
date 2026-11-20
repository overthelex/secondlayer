/**
 * Bounded neighbourhood of a node in the relationship graph (LEXAI-2303): breadth-first, one SQL
 * query per depth level for the frontier's edges (LATERAL, per-node LIMIT on the (src, kind) /
 * (dst, kind) indexes) and one for the new nodes. Chosen over a recursive CTE: the frontier is
 * deduplicated globally (a CTE walks every path, so a depth-3 walk through a few busy nodes
 * multiplies rows), and the hub stop / fanout cap / node budget are applied between levels. See
 * the benchmark in the PR / scripts/bench-graph.ts.
 *
 * Rules: edges are followed in both directions; the start node is always expanded, a hub
 * (graph.node.hub) is reached but not expanded when stopAtHubs; at most maxFanout edges of one
 * node (lowest edge id first, so results are stable) and maxNodes nodes overall; asOf keeps the
 * edges valid on that date (valid_from NULL = since before the first snapshot, valid_to NULL =
 * still current); kinds limits the edge kinds.
 */
import { normAddress } from '../graph-norm/address';
import type { StreetRenamingLookup } from '../graph-norm/address';
import { companyKey, EDGE_KINDS, EdgeKind, foreignEntityKey, NodeKind, organisationKey, personKey } from './keys';

export interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }

export interface GraphNode {
  id: number; kind: NodeKind; key: string; label: string | null; degree: number; hub: boolean; attrs: Record<string, unknown>;
}
export interface GraphEdge {
  id: number; src: number; dst: number; kind: EdgeKind; valid_from: string | null; valid_to: string | null;
  source: 'edr_hist' | 'edr_current'; source_ref: Record<string, unknown>; attrs: Record<string, unknown>;
}
export interface EdgeFilter { kinds: EdgeKind[] | null; asOf: string | null; currentOnly: boolean }

/** Data access of the traversal (SQL in production, in-memory in tests). */
export interface GraphStore {
  nodeByKey(kind: NodeKind, key: string): Promise<GraphNode | null>;
  nodeById(id: number): Promise<GraphNode | null>;
  nodesByIds(ids: number[]): Promise<GraphNode[]>;
  /** edges touching each of the nodes, at most limit per node and direction, as { via, edge } */
  edgesOf(ids: number[], filter: EdgeFilter, limit: number): Promise<Array<{ via: number; edge: GraphEdge }>>;
}

export interface NeighbourhoodOptions {
  depth?: number;          // 1..3, default 2
  asOf?: string | null;    // YYYY-MM-DD
  kinds?: EdgeKind[] | null;
  currentOnly?: boolean;   // only edges with valid_to NULL
  maxFanout?: number;      // per node, default 50
  stopAtHubs?: boolean;    // default true
  maxNodes?: number;       // default 1000
}

export interface NeighbourhoodResult {
  start: GraphNode | null;
  nodes: Array<GraphNode & { depth: number }>;
  edges: GraphEdge[];
  /** fanout: nodes whose edges were cut at maxFanout; hubs: hubs reached and not expanded */
  truncated: { fanout: number[]; hubs: number[]; maxNodes: boolean };
  options: Required<Omit<NeighbourhoodOptions, 'asOf' | 'kinds'>> & { asOf: string | null; kinds: EdgeKind[] | null };
}

export const MAX_DEPTH = 3;

export function normaliseOptions(o: NeighbourhoodOptions = {}): NeighbourhoodResult['options'] {
  const depth = o.depth ?? 2;
  if (!(Number.isInteger(depth) && depth >= 1 && depth <= MAX_DEPTH)) throw new Error(`depth must be 1..${MAX_DEPTH}`);
  if (o.asOf != null && !/^\d{4}-\d{2}-\d{2}$/.test(o.asOf)) throw new Error('asOf must be YYYY-MM-DD');
  const kinds = o.kinds && o.kinds.length ? o.kinds : null;
  for (const k of kinds || []) if (!EDGE_KINDS.includes(k)) throw new Error(`unknown edge kind ${k}`);
  const maxFanout = o.maxFanout ?? 50;
  const maxNodes = o.maxNodes ?? 1000;
  if (!(Number.isInteger(maxFanout) && maxFanout >= 1 && maxFanout <= 10000)) throw new Error('maxFanout must be 1..10000');
  if (!(Number.isInteger(maxNodes) && maxNodes >= 1 && maxNodes <= 100000)) throw new Error('maxNodes must be 1..100000');
  return { depth, asOf: o.asOf ?? null, kinds, currentOnly: !!o.currentOnly, maxFanout, stopAtHubs: o.stopAtHubs ?? true, maxNodes };
}

/** Breadth-first walk from a node; the store does the filtering by kind and date. */
export async function traverse(store: GraphStore, start: GraphNode, opts: NeighbourhoodOptions = {}): Promise<NeighbourhoodResult> {
  const o = normaliseOptions(opts);
  const filter: EdgeFilter = { kinds: o.kinds, asOf: o.asOf, currentOnly: o.currentOnly };
  const nodes = new Map<number, GraphNode & { depth: number }>([[start.id, { ...start, depth: 0 }]]);
  const edges = new Map<number, GraphEdge>();
  const truncated = { fanout: [] as number[], hubs: [] as number[], maxNodes: false };
  let frontier: number[] = [start.id];
  for (let d = 1; d <= o.depth && frontier.length; d++) {
    const expand = frontier.filter(id => {
      if (id === start.id || !o.stopAtHubs || !nodes.get(id)!.hub) return true;
      truncated.hubs.push(id);
      return false;
    });
    if (!expand.length) break;
    const rows = await store.edgesOf(expand, filter, o.maxFanout + 1);
    const byVia = new Map<number, Map<number, GraphEdge>>();
    for (const { via, edge } of rows) {
      let m = byVia.get(via);
      if (!m) byVia.set(via, (m = new Map()));
      m.set(edge.id, edge);   // a self-loop comes back twice
    }
    const next: number[] = [];
    for (const via of expand) {
      const list = [...(byVia.get(via)?.values() || [])].sort((a, b) => a.id - b.id);
      if (list.length > o.maxFanout) {
        truncated.fanout.push(via);
        list.length = o.maxFanout;
      }
      for (const e of list) {
        const other = e.src === via ? e.dst : e.src;
        if (!nodes.has(other)) {
          if (nodes.size >= o.maxNodes) { truncated.maxNodes = true; continue; }
          next.push(other);
          nodes.set(other, null as any); // placeholder until loaded; marks visited
        }
        edges.set(e.id, e);
      }
    }
    if (next.length) {
      for (const n of await store.nodesByIds(next)) nodes.set(n.id, { ...n, depth: d });
      for (const id of next) if (!nodes.get(id)) nodes.delete(id); // edge to a missing node: drop
    }
    frontier = next.filter(id => nodes.has(id));
  }
  const result = [...nodes.values()].filter(Boolean);
  const ids = new Set(result.map(n => n.id));
  return {
    start,
    nodes: result.sort((a, b) => a.depth - b.depth || a.id - b.id),
    edges: [...edges.values()].filter(e => ids.has(e.src) && ids.has(e.dst)).sort((a, b) => a.id - b.id),
    truncated,
    options: o,
  };
}

// ---------------------------------------------------------------- SQL store

const NODE_COLS = 'id, kind, key, label, degree, hub, attrs';
const EDGE_COLS = 'e.id, e.src, e.dst, e.kind, e.valid_from::text AS valid_from, e.valid_to::text AS valid_to, e.source, e.source_ref, e.attrs';
const toNode = (r: any): GraphNode => ({ ...r, id: Number(r.id), degree: Number(r.degree) });
const toEdge = (r: any): GraphEdge => ({
  id: Number(r.id), src: Number(r.src), dst: Number(r.dst), kind: r.kind, valid_from: r.valid_from, valid_to: r.valid_to,
  source: r.source, source_ref: r.source_ref, attrs: r.attrs,
});

/** WHERE clause of an edge filter; params are $2 (kinds), $3 (asOf) after $1 (ids). */
export function edgeFilterSql(alias = 'e'): string {
  return `($2::text[] IS NULL OR ${alias}.kind = ANY($2::text[]))
    AND ($3::date IS NULL OR ((${alias}.valid_from IS NULL OR ${alias}.valid_from <= $3::date) AND (${alias}.valid_to IS NULL OR ${alias}.valid_to >= $3::date)))
    AND (NOT $4::boolean OR ${alias}.valid_to IS NULL)`;
}

export function sqlGraphStore(db: Queryable, schema = 'graph'): GraphStore {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('bad schema name');
  return {
    async nodeByKey(kind, key) {
      const r = await db.query(`SELECT ${NODE_COLS} FROM ${schema}.node WHERE kind = $1 AND key = $2`, [kind, key]);
      return r.rows[0] ? toNode(r.rows[0]) : null;
    },
    async nodeById(id) {
      const r = await db.query(`SELECT ${NODE_COLS} FROM ${schema}.node WHERE id = $1`, [id]);
      return r.rows[0] ? toNode(r.rows[0]) : null;
    },
    async nodesByIds(ids) {
      if (!ids.length) return [];
      const r = await db.query(`SELECT ${NODE_COLS} FROM ${schema}.node WHERE id = ANY($1::bigint[])`, [ids]);
      return r.rows.map(toNode);
    },
    async edgesOf(ids, f, limit) {
      if (!ids.length) return [];
      const r = await db.query(
        `SELECT f.id AS via, x.* FROM unnest($1::bigint[]) AS f(id)
         CROSS JOIN LATERAL (
           (SELECT ${EDGE_COLS} FROM ${schema}.edge e WHERE e.src = f.id AND ${edgeFilterSql()} ORDER BY e.id LIMIT ${Number(limit)})
           UNION ALL
           (SELECT ${EDGE_COLS} FROM ${schema}.edge e WHERE e.dst = f.id AND e.src <> f.id AND ${edgeFilterSql()} ORDER BY e.id LIMIT ${Number(limit)})
         ) x`,
        [ids, f.kinds, f.asOf, f.currentOnly]);
      return r.rows.map(row => ({ via: Number(row.via), edge: toEdge(row) }));
    },
  };
}

// ---------------------------------------------------------------- start keys

/**
 * Start of a walk: '12345678' or 'company:12345678'; 'person:<full name>'; 'address:<raw address>';
 * 'foreign:<CC>:<name or registration code>'; 'org:<name>' (an organisation head node); 'node:<id>';
 * '<kind>:<key>' with an exact node key.
 */
export function parseStartKey(s: string, renamings?: StreetRenamingLookup | null): { kind: NodeKind; key: string } | { id: number } {
  const t = (s || '').trim();
  const c = companyKey(t);
  if (/^\d{5,8}$/.test(t) && c) return { kind: 'company', key: c };
  const i = t.indexOf(':');
  if (i < 0) throw new Error(`unrecognised start key: ${s}`);
  const [p, v] = [t.slice(0, i).toLowerCase(), t.slice(i + 1).trim()];
  const fail = () => { throw new Error(`no ${p} key in: ${s}`); };
  switch (p) {
    case 'node': { if (!/^\d+$/.test(v)) fail(); return { id: Number(v) }; }
    case 'company': return { kind: 'company', key: companyKey(v) ?? fail() };
    case 'person': case 'person_name': return { kind: 'person_name', key: personKey(v) ?? fail() };
    case 'org': case 'organisation': return { kind: 'organisation', key: organisationKey(v) ?? fail() };
    case 'address': {
      // an exact key ('UA-32|м|...') or a raw address
      if (v.includes('|')) return { kind: 'address', key: v };
      return { kind: 'address', key: normAddress(v, { streetRenamings: renamings }).addressKey ?? fail() };
    }
    case 'foreign': case 'foreign_entity': {
      if (/^[A-Z]{2}\|(name|code):/.test(v)) return { kind: 'foreign_entity', key: v };
      const j = v.indexOf(':');
      if (j < 0) fail();
      const [cc, rest] = [v.slice(0, j).toUpperCase(), v.slice(j + 1)];
      return { kind: 'foreign_entity', key: foreignEntityKey(cc, rest, null) ?? foreignEntityKey(cc, null, rest) ?? fail() };
    }
    default: throw new Error(`unknown start kind ${p}`);
  }
}

export async function neighbourhood(db: Queryable, startKey: string, opts: NeighbourhoodOptions = {},
  extra: { schema?: string; streetRenamings?: StreetRenamingLookup | null } = {}): Promise<NeighbourhoodResult> {
  const o = normaliseOptions(opts);
  const store = sqlGraphStore(db, extra.schema);
  const k = parseStartKey(startKey, extra.streetRenamings);
  const start = 'id' in k ? await store.nodeById(k.id) : await store.nodeByKey(k.kind, k.key);
  if (!start) return { start: null, nodes: [], edges: [], truncated: { fanout: [], hubs: [], maxNodes: false }, options: o };
  return traverse(store, start, o);
}
