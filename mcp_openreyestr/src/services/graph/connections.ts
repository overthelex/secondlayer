/**
 * «Пошук зв'язків» over the ЄДР relationship graph (LEXAI-2308): the MCP tools find_connections
 * (bounded neighbourhood of a company / person name / address) and connection_path (shortest
 * paths between two starts, bidirectional BFS on the same store and edge filter as
 * neighbourhood.ts).
 *
 * Output follows the get_citation_graph shape ({ graph: { root, nodes, edges, truncated } } with
 * nodes { id, type, label } and edges { from, to, type }) plus the graph's own fields: dates,
 * source and snapshot refs per edge, degree / hub per node, and paths from the start.
 *
 * person_name nodes group namesakes (LEXAI-2306 tells people apart, not done yet): every person
 * in the output is match_level 'name_only' and a person start is a lead, not an identification.
 */
import type { StreetRenamingLookup } from '../graph-norm/address';
import { StreetRenamingsCache } from '../graph-norm/street-renamings';
import { EDGE_KINDS, EdgeKind, NodeKind } from './keys';
import {
  EdgeFilter, GraphEdge, GraphNode, GraphStore, NeighbourhoodResult, parseStartKey, Queryable, sqlGraphStore, traverse,
} from './neighbourhood';

// ---------------------------------------------------------------- texts

export const NODE_KIND_LABELS: Record<NodeKind, string> = {
  company: 'юрособа', person_name: 'особа (за ПІБ)', address: 'адреса', foreign_entity: 'іноземна особа',
  organisation: 'організація (не з ЄДР)',
};
export const EDGE_KIND_LABELS: Record<EdgeKind, string> = {
  founder: 'засновник', beneficiary: 'кінцевий бенефіціар', head: 'керівник', signer: 'підписант (представник)',
  registered_at: 'місцезнаходження', reg_neighbour: 'сусідній код реєстрації того ж дня',
};

export const PERSON_NAME_WARNING =
  'Особи в графі згруповані за ПІБ: один вузол person_name об\'єднує всіх тезок. Збіг за ПІБ — лише кандидат ' +
  '(наводка), а не встановлена особа; підтвердження потребує другої ознаки (спільна компанія, адреса, дата ' +
  'народження). Зіставлення фізосіб (LEXAI-2306) ще не зроблено, тому кожна особа у відповіді має match_level "name_only".';
export const PERSON_START_WARNING =
  'Початок пошуку — ПІБ: зв\'язки нижче можуть належати різним людям з однаковим ім\'ям. Перевірте кожну компанію ' +
  'за другою ознакою, перш ніж робити висновок про одну особу.';
export const DATA_LIMITS =
  'Джерело — відкриті дані ЄДР (data.gov.ua): знімки 2016–2018, 2021 і поточний 2026. Дати зв\'язків наближені: ' +
  'valid_from / valid_to — перший і останній знімок, де зв\'язок був (valid_from порожній — уже був у першому знімку, ' +
  'valid_to порожній — є в поточному); між знімками змін не видно. Дамп 2026 не містить адрес, тож зв\'язки ' +
  '«місцезнаходження» відображають стан не пізніше 2021. Хаби (адреси масової реєстрації, номінальні особи, тезки ' +
  'з поширеним ПІБ) показуються, але пошук крізь них не йде, якщо не задано include_hubs.';
const GAP_WARNING =
  'Дата as_of припадає між знімками ЄДР {from} і {to}: зв\'язок, що зник у цьому проміжку, вважається таким, ' +
  'що діяв до {from}, а новий — таким, що почався з {to}. Стан на цю дату наближений.';
const NOT_BUILT = 'Граф зв\'язків ще не побудовано (схема graph порожня).';

// ---------------------------------------------------------------- params

export type StartType = 'auto' | 'company' | 'person' | 'address';

export interface FindConnectionsParams {
  start?: string;
  start_type?: StartType;
  depth?: number;
  as_of?: string;
  kinds?: string[];
  max_nodes?: number;
  max_fanout?: number;
  include_hubs?: boolean;
  max_paths?: number;
  include_source_refs?: boolean;
}

export interface ConnectionPathParams {
  from?: string;
  to?: string;
  from_type?: StartType;
  to_type?: StartType;
  max_depth?: number;
  as_of?: string;
  kinds?: string[];
  max_fanout?: number;
  include_hubs?: boolean;
  max_paths?: number;
  include_source_refs?: boolean;
}

export const FIND_DEFAULTS = { depth: 2, maxNodes: 200, maxNodesCap: 1000, maxFanout: 50, maxFanoutCap: 200, maxPaths: 20, maxPathsCap: 100 };
export const PATH_DEFAULTS = { depth: 3, depthCap: 4, maxFanout: 50, maxFanoutCap: 200, maxPaths: 5, maxPathsCap: 20, visitBudget: 20000 };
/** statement_timeout of every graph query of one tool call */
export const GRAPH_STATEMENT_TIMEOUT_MS = 15000;

export class ConnectionsInputError extends Error {}

function intIn(v: unknown, def: number, min: number, max: number, name: string): number {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ConnectionsInputError(`${name}: ціле число від ${min} до ${max}`);
  return Math.min(Math.max(n, min), max);
}

function asOfOf(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!m || !d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw new ConnectionsInputError('as_of: дата у форматі YYYY-MM-DD');
  }
  return s;
}

function kindsOf(v: unknown): EdgeKind[] | null {
  if (v === undefined || v === null) return null;
  const list = (Array.isArray(v) ? v : String(v).split(',')).map(x => String(x).trim()).filter(Boolean);
  if (!list.length) return null;
  for (const k of list) {
    if (!EDGE_KINDS.includes(k as EdgeKind)) throw new ConnectionsInputError(`kinds: невідомий тип зв'язку «${k}»; допустимі: ${EDGE_KINDS.join(', ')}`);
  }
  return [...new Set(list)] as EdgeKind[];
}

// ---------------------------------------------------------------- start resolution

export interface ResolvedStart { kind: NodeKind; key: string; query: string; inferred: StartType }

/**
 * A start string to a node key: 8-digit ЄДРПОУ (or 5-7 digits, zero-padded) -> company; a prefixed
 * key ('company:', 'person:', 'address:', 'foreign:CC:', 'node:') as in parseStartKey; otherwise
 * by start_type, or for 'auto' a string with a digit is an address and one without is a person.
 */
export function resolveStartKey(raw: string, type: StartType = 'auto', renamings?: StreetRenamingLookup | null): ResolvedStart | { id: number; query: string; inferred: StartType } {
  const s = (raw || '').trim();
  if (!s) throw new ConnectionsInputError('Вкажіть початок пошуку: код ЄДРПОУ, ПІБ або адресу.');
  let spec = s;
  let inferred: StartType = type;
  if (type === 'company') spec = `company:${s.replace(/^company:/i, '')}`;
  else if (type === 'person') spec = `person:${s.replace(/^person(_name)?:/i, '')}`;
  else if (type === 'address') spec = `address:${s.replace(/^address:/i, '')}`;
  else if (/^\d{5,8}$/.test(s)) { spec = s; inferred = 'company'; }
  else if (/^(company|person|person_name|address|foreign|foreign_entity|node):/i.test(s)) {
    const p = s.slice(0, s.indexOf(':')).toLowerCase();
    inferred = p === 'company' ? 'company' : p.startsWith('person') ? 'person' : p === 'address' ? 'address' : 'auto';
  } else if (/\d/.test(s)) { spec = `address:${s}`; inferred = 'address'; }
  else { spec = `person:${s}`; inferred = 'person'; }
  let k: ReturnType<typeof parseStartKey>;
  try {
    k = parseStartKey(spec, renamings);
  } catch {
    const what = inferred === 'company' ? 'код ЄДРПОУ' : inferred === 'person' ? 'ПІБ' : inferred === 'address' ? 'адресу' : 'початок';
    throw new ConnectionsInputError(`Не вдалося розпізнати ${what}: «${s}».`);
  }
  return 'id' in k ? { id: k.id, query: s, inferred } : { ...k, query: s, inferred };
}

// ---------------------------------------------------------------- output shape

export interface OutNode {
  id: string; type: NodeKind; label: string | null; key?: string; degree: number; hub: boolean;
  depth?: number; match_level?: 'name_only'; attrs?: Record<string, unknown>;
}
export interface OutEdge {
  id: string; from: string; to: string; type: EdgeKind;
  valid_from: string | null; valid_to: string | null; source: string;
  /** first / last edr_hist snapshot that showed the relation, the current dump that has it */
  snapshots: { first_seen?: string; last_seen?: string; current_dump?: string };
  attrs?: Record<string, unknown>;
  /** rows of the current dump tables ('founders:123'); full source_ref with include_source_refs */
  refs?: string[];
  source_ref?: Record<string, unknown>;
}
export interface OutOptions { full?: boolean }

const nid = (id: number) => `n${id}`;
/** node attrs worth showing per kind (the rest: degree_by_kind, key versions, first/last seen) */
const NODE_ATTRS: Partial<Record<NodeKind, string[]>> = {
  company: ['status', 'legal_form', 'registered_on', 'kved'],
  foreign_entity: ['country_code'],
};
/** builder-internal edge attrs */
const EDGE_ATTRS_HIDDEN = new Set(['entry', 'role_class', 'contribution_uah']);
/** the raw register text of the entry (an address as written): only with include_source_refs */
const EDGE_ATTRS_RAW = new Set(['raw']);

export function outNode(n: GraphNode & { depth?: number }, o: OutOptions = {}): OutNode {
  const all = (n.attrs || {}) as Record<string, unknown>;
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k === 'key_version' || v === null || v === undefined) continue;
    if (o.full || (NODE_ATTRS[n.kind] || []).includes(k)) attrs[k] = v;
  }
  const out: OutNode = { id: nid(n.id), type: n.kind, label: n.label, degree: n.degree, hub: n.hub };
  // a person's key is the transliterated name: the label says the same, restart with node:<id>
  if (n.kind !== 'person_name') out.key = n.key;
  if (n.depth !== undefined) out.depth = n.depth;
  if (n.kind === 'person_name') out.match_level = 'name_only';
  if (Object.keys(attrs).length) out.attrs = attrs;
  return out;
}

export function outEdge(e: GraphEdge, o: { sourceRefs?: boolean } = {}): OutEdge {
  const ref = (e.source_ref || {}) as any;
  const snapshots: OutEdge['snapshots'] = {};
  if (ref.hist?.first_seen) snapshots.first_seen = ref.hist.first_seen;
  if (ref.hist?.last_seen) snapshots.last_seen = ref.hist.last_seen;
  if (ref.current?.dump) snapshots.current_dump = ref.current.dump;
  const out: OutEdge = {
    id: `e${e.id}`, from: nid(e.src), to: nid(e.dst), type: e.kind,
    valid_from: e.valid_from, valid_to: e.valid_to, source: e.source, snapshots,
  };
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e.attrs || {})) {
    if (EDGE_ATTRS_HIDDEN.has(k) || (EDGE_ATTRS_RAW.has(k) && !o.sourceRefs) || v === null || v === undefined) continue;
    attrs[k] = v;
  }
  if (Object.keys(attrs).length) out.attrs = attrs;
  if (Array.isArray(ref.current?.rows) && ref.current.rows.length) out.refs = ref.current.rows.map(String);
  if (o.sourceRefs) out.source_ref = ref;
  return out;
}

export const LEGEND = {
  node_types: NODE_KIND_LABELS,
  edge_types: EDGE_KIND_LABELS,
  direction: 'Ребро from → to: учасник → компанія (засновник, КБВ, керівник, підписант), компанія → адреса, менший код → більший (сусідній код реєстрації). У paths «А —засновник→ Б» означає: А — засновник Б.',
};

/** A path: node and edge ids in order (edge i joins nodes i and i+1; its from / to give the direction) and a one-line text. */
export interface OutPath { to: string; length: number; nodes: string[]; edges: string[]; edge_types: EdgeKind[]; text: string; has_person: boolean }

function nodeText(n: GraphNode): string {
  const l = n.label || n.key;
  if (n.kind === 'company') return `${l} (${n.key})`;
  if (n.kind === 'person_name') return `${l} [ПІБ]`;
  return l;
}

/** A path as node ids [a, ..., z] with the edge between each pair. */
export function describePath(nodeIds: number[], edgeIds: number[], nodes: Map<number, GraphNode>, edges: Map<number, GraphEdge>): OutPath {
  const parts: string[] = [];
  const kinds: EdgeKind[] = [];
  let hasPerson = false;
  nodeIds.forEach((id, i) => {
    const n = nodes.get(id)!;
    if (n.kind === 'person_name') hasPerson = true;
    if (i > 0) {
      const e = edges.get(edgeIds[i - 1])!;
      kinds.push(e.kind);
      const lbl = EDGE_KIND_LABELS[e.kind];
      parts.push(e.src === nodeIds[i - 1] ? ` —${lbl}→ ` : ` ←${lbl}— `);
    }
    parts.push(nodeText(n));
  });
  return {
    to: nid(nodeIds[nodeIds.length - 1]), length: nodeIds.length - 1,
    nodes: nodeIds.map(nid), edges: edgeIds.map(e => `e${e}`), edge_types: kinds,
    text: parts.join(''), has_person: hasPerson,
  };
}

/** Shortest-path tree over the edges of a neighbourhood, from its start; paths to the targets. */
export function pathsFromStart(r: NeighbourhoodResult, maxPaths: number): OutPath[] {
  if (!r.start) return [];
  const nodes = new Map<number, GraphNode & { depth: number }>(r.nodes.map(n => [n.id, n]));
  const edges = new Map<number, GraphEdge>(r.edges.map(e => [e.id, e]));
  const adj = new Map<number, GraphEdge[]>();
  for (const e of r.edges) {
    for (const v of [e.src, e.dst]) {
      let a = adj.get(v);
      if (!a) adj.set(v, (a = []));
      a.push(e);
    }
  }
  const parent = new Map<number, { p: number; e: number }>();
  const seen = new Set([r.start.id]);
  let frontier = [r.start.id];
  while (frontier.length) {
    const next: number[] = [];
    for (const v of frontier) {
      for (const e of adj.get(v) || []) {
        const o = e.src === v ? e.dst : e.src;
        if (seen.has(o)) continue;
        seen.add(o);
        parent.set(o, { p: v, e: e.id });
        next.push(o);
      }
    }
    frontier = next;
  }
  // targets: companies and foreign entities beyond the first step first (the indirect links are the
  // point of the search), then the direct ones; persons and addresses appear inside the paths
  const targets = r.nodes
    .filter(n => n.id !== r.start!.id && parent.has(n.id) && (n.kind === 'company' || n.kind === 'foreign_entity'))
    .sort((a, b) => (b.depth > 1 ? 1 : 0) - (a.depth > 1 ? 1 : 0) || a.depth - b.depth || b.degree - a.degree || a.id - b.id)
    .slice(0, maxPaths);
  return targets.map(t => {
    const ns = [t.id];
    const es: number[] = [];
    let v = t.id;
    while (parent.has(v)) { const { p, e } = parent.get(v)!; es.unshift(e); ns.unshift(p); v = p; }
    return describePath(ns, es, nodes, edges);
  });
}

// ---------------------------------------------------------------- snapshots

export interface GraphSources { snapshots: string[]; current_dump: string | null; built_at: string | null }

export async function graphSources(db: Queryable, schema = 'graph'): Promise<GraphSources | null> {
  try {
    const r = await db.query(`SELECT sources, finished_at FROM ${schema}.build ORDER BY id DESC LIMIT 1`);
    const row = r.rows[0];
    if (!row) return null;
    const s = row.sources || {};
    const built = row.finished_at instanceof Date ? row.finished_at.toISOString() : row.finished_at ? String(row.finished_at) : null;
    return { snapshots: Array.isArray(s.snapshots) ? s.snapshots : [], current_dump: s.useCurrent ? (s.currentDate ?? null) : null, built_at: built };
  } catch (e: any) {
    if (e?.code === '42P01' || e?.code === '3F000') return null;
    throw e;
  }
}

/** The snapshot gap an as_of date falls into (strictly between two loaded dumps), or null. */
export function snapshotGap(asOf: string | null, src: GraphSources | null): { from: string; to: string } | null {
  if (!asOf || !src) return null;
  const dates = [...new Set([...src.snapshots, ...(src.current_dump ? [src.current_dump] : [])])].sort();
  for (let i = 1; i < dates.length; i++) {
    if (asOf > dates[i - 1] && asOf < dates[i]) {
      // gaps of a few weeks between the autumn 2021 dumps are not worth a warning
      const days = (Date.parse(dates[i]) - Date.parse(dates[i - 1])) / 86400000;
      return days > 120 ? { from: dates[i - 1], to: dates[i] } : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------- db plumbing

interface PoolLike extends Queryable { connect?: () => Promise<Queryable & { release: () => void }> }

/** Read-only transaction with a statement_timeout; a plain Queryable (tests) runs as is. */
export async function withGraphReader<T>(pool: PoolLike, fn: (db: Queryable) => Promise<T>, timeoutMs = GRAPH_STATEMENT_TIMEOUT_MS): Promise<T> {
  if (typeof pool.connect !== 'function') return fn(pool);
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query(`SET LOCAL statement_timeout = ${Math.max(1000, Math.floor(timeoutMs))}`);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

let renamingsCache: StreetRenamingsCache | null = null;
async function streetRenamings(db: Queryable): Promise<StreetRenamingLookup | null> {
  try {
    if (!renamingsCache) renamingsCache = new StreetRenamingsCache(db);
    const idx = await renamingsCache.get();
    return idx.size ? idx : null;
  } catch {
    return null;
  }
}

async function findStartNode(db: Queryable, store: GraphStore, raw: string, type: StartType):
  Promise<{ node: GraphNode | null; inferred: StartType; key: string | null }> {
  let k = resolveStartKey(raw, type, null);
  if ('id' in k) return { node: await store.nodeById(k.id), inferred: k.inferred, key: null };
  let node = await store.nodeByKey(k.kind, k.key);
  if (!node && k.kind === 'address') {
    // the build keys addresses with the street renamings applied: an old street name needs them too
    const ren = await streetRenamings(db);
    if (ren) {
      const k2 = resolveStartKey(raw, type, ren);
      if (!('id' in k2) && k2.key !== k.key) { k = k2; node = await store.nodeByKey(k2.kind, k2.key); }
    }
  }
  return { node, inferred: k.inferred, key: k.key };
}

function warningsFor(inferred: StartType, hasPerson: boolean, gap: { from: string; to: string } | null): string[] {
  const w: string[] = [];
  if (inferred === 'person') w.push(PERSON_START_WARNING);
  if (hasPerson || inferred === 'person') w.push(PERSON_NAME_WARNING);
  if (gap) w.push(GAP_WARNING.replace(/\{from\}/g, gap.from).replace(/\{to\}/g, gap.to));
  return w;
}

function countBy<T>(xs: T[], f: (x: T) => string): Record<string, number> {
  const o: Record<string, number> = {};
  for (const x of xs) o[f(x)] = (o[f(x)] || 0) + 1;
  return o;
}

// ---------------------------------------------------------------- find_connections

export async function findConnections(pool: PoolLike, p: FindConnectionsParams, schema = 'graph'): Promise<any> {
  let depth: number, maxNodes: number, maxFanout: number, maxPaths: number, asOf: string | null, kinds: EdgeKind[] | null;
  try {
    depth = intIn(p.depth, FIND_DEFAULTS.depth, 1, 3, 'depth');
    maxNodes = intIn(p.max_nodes, FIND_DEFAULTS.maxNodes, 1, FIND_DEFAULTS.maxNodesCap, 'max_nodes');
    maxFanout = intIn(p.max_fanout, FIND_DEFAULTS.maxFanout, 1, FIND_DEFAULTS.maxFanoutCap, 'max_fanout');
    maxPaths = intIn(p.max_paths, FIND_DEFAULTS.maxPaths, 0, FIND_DEFAULTS.maxPathsCap, 'max_paths');
    asOf = asOfOf(p.as_of);
    kinds = kindsOf(p.kinds);
    resolveStartKey(String(p.start ?? ''), p.start_type || 'auto');
  } catch (e) {
    if (e instanceof ConnectionsInputError) return { found: false, error: e.message };
    throw e;
  }
  const includeHubs = !!p.include_hubs;
  const started = Date.now();
  return withGraphReader(pool, async (db) => {
    const sources = await graphSources(db, schema);
    if (!sources) return { found: false, message: NOT_BUILT };
    const store = sqlGraphStore(db, schema);
    const { node: start, inferred } = await findStartNode(db, store, String(p.start), p.start_type || 'auto');
    const query = { start: String(p.start).trim(), start_type: inferred, depth, as_of: asOf, kinds, max_nodes: maxNodes, max_fanout: maxFanout, include_hubs: includeHubs };
    if (!start) {
      const what = inferred === 'company' ? 'Юрособи з таким кодом ЄДРПОУ' : inferred === 'person' ? 'Особи з таким ПІБ' : 'Такої адреси';
      return {
        found: false, query,
        message: `${what} немає в графі зв'язків. Граф містить юрособи (не ФОП) зі знімків ЄДР; ПІБ і адресу треба писати повністю.`,
        warnings: inferred === 'person' ? [PERSON_NAME_WARNING] : [],
        data_limits: DATA_LIMITS, sources,
      };
    }
    const r = await traverse(store, start, { depth, asOf, kinds, maxFanout, maxNodes, stopAtHubs: !includeHubs });
    const nodes = r.nodes.map(n => outNode(n));
    const edges = r.edges.map(e => outEdge(e, { sourceRefs: !!p.include_source_refs }));
    const paths = pathsFromStart(r, maxPaths);
    const hasPerson = r.nodes.some(n => n.kind === 'person_name');
    const gap = snapshotGap(asOf, sources);
    const hubLabels = r.truncated.hubs.slice(0, 20).map(id => {
      const n = r.nodes.find(x => x.id === id)!;
      return { id: nid(id), type: n.kind, label: n.label, degree: n.degree };
    });
    const notes: string[] = [];
    if (r.truncated.hubs.length) notes.push(`${r.truncated.hubs.length} хаб(ів) показано, але не розкрито (зв'язків понад поріг). Щоб іти крізь них, задайте include_hubs: true.`);
    if (r.truncated.fanout.length) notes.push(`У ${r.truncated.fanout.length} вузл(ів) показано лише перші ${maxFanout} зв'язків (max_fanout).`);
    if (r.truncated.maxNodes) notes.push(`Досягнуто ліміту ${maxNodes} вузлів (max_nodes): результат неповний.`);
    return {
      found: true,
      query,
      start: outNode({ ...start, depth: 0 }, { full: true }),
      summary: {
        nodes: nodes.length, edges: edges.length,
        nodes_by_type: countBy(r.nodes, n => n.kind),
        edges_by_type: countBy(r.edges, e => e.kind),
        companies: r.nodes.filter(n => n.kind === 'company' && n.id !== start.id).length,
      },
      paths,
      graph: {
        root: { id: nid(start.id), type: start.kind, key: start.key, label: start.label },
        nodes, edges,
        truncated: !!(r.truncated.hubs.length || r.truncated.fanout.length || r.truncated.maxNodes),
      },
      truncated: { hubs: hubLabels, hubs_total: r.truncated.hubs.length, fanout: r.truncated.fanout.map(nid), max_nodes: r.truncated.maxNodes },
      notes,
      warnings: warningsFor(inferred, hasPerson, gap),
      legend: LEGEND,
      data_limits: DATA_LIMITS,
      sources,
      elapsed_ms: Date.now() - started,
    };
  });
}

// ---------------------------------------------------------------- connection_path

interface Side {
  start: GraphNode;
  dist: Map<number, number>;
  parents: Map<number, Array<{ p: number; e: number }>>;
  frontier: number[];
  depth: number;
}

export interface BiSearchResult {
  length: number | null;
  meet: number[];
  a: Side; b: Side;
  nodes: Map<number, GraphNode>;
  edges: Map<number, GraphEdge>;
  truncated: { hubs: number[]; fanout: number[]; budget: boolean };
  visited: number;
}

/**
 * Bidirectional breadth-first search between two nodes: expands the smaller frontier one level at a
 * time (one edgesOf call per level, as in traverse), records every parent at the level a node is
 * first reached (so all shortest paths can be enumerated), stops at the first level where the two
 * sides meet. Hubs are reached but not expanded unless includeHubs (the two ends always are).
 */
export async function bidirectionalSearch(store: GraphStore, a0: GraphNode, b0: GraphNode,
  o: { maxDepth: number; filter: EdgeFilter; maxFanout: number; includeHubs: boolean; visitBudget: number }): Promise<BiSearchResult> {
  const nodes = new Map<number, GraphNode>([[a0.id, a0], [b0.id, b0]]);
  const edges = new Map<number, GraphEdge>();
  const mk = (s: GraphNode): Side => ({ start: s, dist: new Map([[s.id, 0]]), parents: new Map(), frontier: [s.id], depth: 0 });
  const a = mk(a0), b = mk(b0);
  const truncated = { hubs: [] as number[], fanout: [] as number[], budget: false };
  const hubSeen = new Set<number>();
  if (a0.id === b0.id) return { length: 0, meet: [a0.id], a, b, nodes, edges, truncated, visited: 1 };

  while (a.depth + b.depth < o.maxDepth && (a.frontier.length || b.frontier.length)) {
    const side = !b.frontier.length || (a.frontier.length && a.frontier.length <= b.frontier.length) ? a : b;
    const other = side === a ? b : a;
    const expand = side.frontier.filter(id => {
      const n = nodes.get(id);
      if (id === side.start.id || o.includeHubs || !n?.hub) return true;
      if (!hubSeen.has(id)) { hubSeen.add(id); truncated.hubs.push(id); }
      return false;
    });
    side.depth++;
    side.frontier = [];
    if (!expand.length) continue;
    const rows = await store.edgesOf(expand, o.filter, o.maxFanout + 1);
    const byVia = new Map<number, Map<number, GraphEdge>>();
    for (const { via, edge } of rows) {
      let m = byVia.get(via);
      if (!m) byVia.set(via, (m = new Map()));
      m.set(edge.id, edge);
    }
    const fresh: number[] = [];
    for (const via of expand) {
      const list = [...(byVia.get(via)?.values() || [])].sort((x, y) => x.id - y.id);
      if (list.length > o.maxFanout) { truncated.fanout.push(via); list.length = o.maxFanout; }
      for (const e of list) {
        const nb = e.src === via ? e.dst : e.src;
        const d = side.dist.get(nb);
        if (d === undefined) {
          if (side.dist.size + other.dist.size >= o.visitBudget) { truncated.budget = true; continue; }
          side.dist.set(nb, side.depth);
          side.parents.set(nb, [{ p: via, e: e.id }]);
          fresh.push(nb);
          edges.set(e.id, e);
        } else if (d === side.depth) {
          side.parents.get(nb)!.push({ p: via, e: e.id });
          edges.set(e.id, e);
        }
      }
    }
    const unknown = fresh.filter(id => !nodes.has(id));
    if (unknown.length) for (const n of await store.nodesByIds(unknown)) nodes.set(n.id, n);
    side.frontier = fresh.filter(id => nodes.has(id));
    // meeting nodes reached by this level: shortest total over them
    let best: number | null = null;
    const meet: number[] = [];
    for (const id of side.frontier) {
      const od = other.dist.get(id);
      if (od === undefined) continue;
      // meeting on a hub = passing through it (two companies at one mass-registration address)
      if (nodes.get(id)!.hub && !o.includeHubs && id !== a0.id && id !== b0.id) {
        if (!hubSeen.has(id)) { hubSeen.add(id); truncated.hubs.push(id); }
        continue;
      }
      const len = side.depth + od;
      if (best === null || len < best) { best = len; meet.length = 0; }
      if (len === best) meet.push(id);
    }
    if (best !== null) return { length: best, meet, a, b, nodes, edges, truncated, visited: a.dist.size + b.dist.size };
    if (truncated.budget) break;
  }
  return { length: null, meet: [], a, b, nodes, edges, truncated, visited: a.dist.size + b.dist.size };
}

/** All shortest paths through the meeting nodes, at most max, as node / edge id lists from a to b. */
export function enumeratePaths(r: BiSearchResult, max: number): Array<{ nodes: number[]; edges: number[] }> {
  const out: Array<{ nodes: number[]; edges: number[] }> = [];
  // partial paths from a side's start to v: node ids start..v, edge ids
  const walk = (side: Side, v: number, limit: number): Array<{ nodes: number[]; edges: number[] }> => {
    if (v === side.start.id) return [{ nodes: [v], edges: [] }];
    const res: Array<{ nodes: number[]; edges: number[] }> = [];
    for (const { p, e } of side.parents.get(v) || []) {
      for (const sub of walk(side, p, limit - res.length)) {
        res.push({ nodes: [...sub.nodes, v], edges: [...sub.edges, e] });
        if (res.length >= limit) return res;
      }
    }
    return res;
  };
  for (const m of r.meet) {
    for (const pa of walk(r.a, m, max)) {
      for (const pb of walk(r.b, m, max)) {
        out.push({ nodes: [...pa.nodes, ...pb.nodes.slice(0, -1).reverse()], edges: [...pa.edges, ...[...pb.edges].reverse()] });
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

export async function connectionPath(pool: PoolLike, p: ConnectionPathParams, schema = 'graph'): Promise<any> {
  let maxDepth: number, maxFanout: number, maxPaths: number, asOf: string | null, kinds: EdgeKind[] | null;
  try {
    maxDepth = intIn(p.max_depth, PATH_DEFAULTS.depth, 1, PATH_DEFAULTS.depthCap, 'max_depth');
    maxFanout = intIn(p.max_fanout, PATH_DEFAULTS.maxFanout, 1, PATH_DEFAULTS.maxFanoutCap, 'max_fanout');
    maxPaths = intIn(p.max_paths, PATH_DEFAULTS.maxPaths, 1, PATH_DEFAULTS.maxPathsCap, 'max_paths');
    asOf = asOfOf(p.as_of);
    kinds = kindsOf(p.kinds);
    resolveStartKey(String(p.from ?? ''), p.from_type || 'auto');
    resolveStartKey(String(p.to ?? ''), p.to_type || 'auto');
  } catch (e) {
    if (e instanceof ConnectionsInputError) return { found: false, error: e.message };
    throw e;
  }
  const includeHubs = !!p.include_hubs;
  const started = Date.now();
  return withGraphReader(pool, async (db) => {
    const sources = await graphSources(db, schema);
    if (!sources) return { found: false, message: NOT_BUILT };
    const store = sqlGraphStore(db, schema);
    const A = await findStartNode(db, store, String(p.from), p.from_type || 'auto');
    const B = await findStartNode(db, store, String(p.to), p.to_type || 'auto');
    const query = {
      from: String(p.from).trim(), from_type: A.inferred, to: String(p.to).trim(), to_type: B.inferred,
      max_depth: maxDepth, as_of: asOf, kinds, max_fanout: maxFanout, include_hubs: includeHubs,
    };
    const anyPersonStart = A.inferred === 'person' || B.inferred === 'person';
    const missing = [!A.node && `from («${query.from}»)`, !B.node && `to («${query.to}»)`].filter(Boolean);
    if (missing.length) {
      return {
        found: false, query,
        message: `Немає в графі зв'язків: ${missing.join(', ')}. Граф містить юрособи (не ФОП) зі знімків ЄДР; ПІБ і адресу треба писати повністю.`,
        warnings: anyPersonStart ? [PERSON_NAME_WARNING] : [], data_limits: DATA_LIMITS, sources,
      };
    }
    const filter: EdgeFilter = { kinds, asOf, currentOnly: false };
    const r = await bidirectionalSearch(store, A.node!, B.node!, { maxDepth, filter, maxFanout, includeHubs, visitBudget: PATH_DEFAULTS.visitBudget });
    const gap = snapshotGap(asOf, sources);
    const hubs = r.truncated.hubs.slice(0, 20).map(id => { const n = r.nodes.get(id)!; return { id: nid(id), type: n.kind, label: n.label, degree: n.degree }; });
    const base = {
      query,
      from: outNode(A.node!, { full: true }), to: outNode(B.node!, { full: true }),
      explored: { nodes: r.visited, depth_from: r.a.depth, depth_to: r.b.depth },
      truncated: { hubs, hubs_total: r.truncated.hubs.length, fanout: r.truncated.fanout.length, visit_budget: r.truncated.budget },
      data_limits: DATA_LIMITS, sources,
    };
    if (r.length === null) {
      const notes: string[] = [];
      if (r.truncated.hubs.length) notes.push(`Пошук не йшов крізь ${r.truncated.hubs.length} хаб(ів); зв'язок може бути через них — спробуйте include_hubs: true.`);
      if (r.truncated.fanout.length) notes.push(`У ${r.truncated.fanout.length} вузл(ів) враховано лише перші ${maxFanout} зв'язків (max_fanout).`);
      if (r.truncated.budget) notes.push(`Пошук зупинено на ліміті ${PATH_DEFAULTS.visitBudget} вузлів.`);
      return {
        found: false, ...base,
        message: `Зв'язку довжиною до ${maxDepth} кроків не знайдено${notes.length ? ' в межах обмежень пошуку' : ''}.`,
        notes,
        warnings: warningsFor(anyPersonStart ? 'person' : 'auto', false, gap),
        elapsed_ms: Date.now() - started,
      };
    }
    const list = enumeratePaths(r, maxPaths);
    const paths = list.map(x => describePath(x.nodes, x.edges, r.nodes, r.edges));
    const nodeIds = new Set(list.flatMap(x => x.nodes));
    const edgeIds = new Set(list.flatMap(x => x.edges));
    const nodes = [...nodeIds].map(id => {
      const n = r.nodes.get(id)!;
      const da = r.a.dist.get(id), db2 = r.b.dist.get(id);
      return outNode({ ...n, depth: da ?? (r.length! - (db2 ?? 0)) });
    });
    const edges = [...edgeIds].sort((x, y) => x - y).map(id => outEdge(r.edges.get(id)!, { sourceRefs: !!p.include_source_refs }));
    const hasPerson = [...nodeIds].some(id => r.nodes.get(id)!.kind === 'person_name');
    const notes: string[] = [];
    if (list.length >= maxPaths) notes.push(`Показано перші ${maxPaths} найкоротших шляхів (max_paths); їх може бути більше.`);
    if (r.truncated.hubs.length) notes.push(`Пошук не йшов крізь ${r.truncated.hubs.length} хаб(ів); з include_hubs: true може знайтися коротший шлях через них.`);
    if (hasPerson) notes.push('Шлях через особу (person_name) — лише гіпотеза: це може бути двоє тезок.');
    return {
      found: true, ...base,
      length: r.length,
      paths,
      graph: {
        root: { id: nid(A.node!.id), type: A.node!.kind, key: A.node!.key, label: A.node!.label },
        target: { id: nid(B.node!.id), type: B.node!.kind, key: B.node!.key, label: B.node!.label },
        nodes, edges, truncated: !!(r.truncated.hubs.length || r.truncated.fanout.length || r.truncated.budget),
      },
      notes,
      warnings: warningsFor(anyPersonStart ? 'person' : 'auto', hasPerson, gap),
      legend: LEGEND,
      elapsed_ms: Date.now() - started,
    };
  });
}
