/**
 * search_offshore_leaks (LEXAI-2311): the ICIJ Offshore Leaks graph by name.
 *
 * Tables icij_nodes (2.0M) and icij_relationships (3.3M), migration 287, loaded monthly by
 * scripts/icij/load_icij.py. A node is matched on name_key, the loader's normalised name;
 * icijNameKey below is the same function, so a query key and a stored key agree.
 *
 * Licence: ODbL 1.0 (database), CC BY-SA 3.0 (contents), ICIJ must be cited. ICIJ also asks
 * that every use carry its caveat: being in the database does not imply wrongdoing, and many
 * people and entities share names. Both go into every response, found or not.
 *
 * Fan-out: some intermediaries and addresses have tens of thousands of edges, so edges are
 * capped per node (and per direction), counted only up to EDGE_COUNT_CAP, and the second hop
 * is capped in nodes and in edges.
 */
import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';

export const ICIJ_ATTRIBUTION =
  'Джерело: база даних ICIJ Offshore Leaks Міжнародного консорціуму журналістів-розслідувачів (ICIJ), ' +
  'https://offshoreleaks.icij.org. База даних поширюється за ліцензією Open Database License (ODbL) 1.0, ' +
  'її вміст — за ліцензією Creative Commons Attribution-ShareAlike 3.0 (CC BY-SA 3.0).';
export const ICIJ_CAVEAT =
  'Застереження ICIJ: наявність особи чи компанії в базі Offshore Leaks не означає і не свідчить про незаконну ' +
  'або неналежну поведінку. Багато людей і компаній мають однакові чи схожі імена й назви: збіг назви не доводить, ' +
  'що це та сама особа, тож його слід підтвердити іншими даними (адреса, дати, юрисдикція, документи).';
export const ICIJ_SOURCE_NAME = 'ICIJ Offshore Leaks Database (offshoreleaks.icij.org; ODbL 1.0, вміст CC BY-SA 3.0)';

export const SOURCE_LEAKS = ['Panama Papers', 'Paradise Papers', 'Pandora Papers', 'Offshore Leaks', 'Bahamas Leaks'] as const;
const NODE_TYPES = ['entity', 'officer', 'intermediary', 'address', 'other'] as const;

const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 10;
const MAX_NAMES = 50;
const MAX_EDGES_PER_NODE = 50;
const DEFAULT_EDGES_PER_NODE = 20;
/** Edges are counted up to this; a hub's exact degree is not worth a full index scan. */
export const EDGE_COUNT_CAP = 10_000;
/** contains: candidate rows read before ranking, so a common word cannot sort 500K rows. */
const CONTAINS_CANDIDATES = 2_000;
/** Second hop: neighbours expanded and edges shown per expanded neighbour. */
const HOP2_NODES = 20;
const HOP2_EDGES_PER_NODE = 5;
const STATEMENT_TIMEOUT_MS = 15_000;

export const NODE_TYPE_LABELS: Record<string, string> = {
  entity: 'офшорна компанія, траст чи фонд',
  officer: 'особа, пов’язана з компанією (директор, акціонер, бенефіціар тощо)',
  intermediary: 'посередник (реєстраційний агент, юридична чи консалтингова фірма)',
  address: 'адреса',
  other: 'інший запис',
};

export const REL_TYPE_LABELS: Record<string, string> = {
  officer_of: 'посадова особа, акціонер або бенефіціар компанії',
  intermediary_of: 'посередник компанії',
  registered_address: 'зареєстрована адреса',
  connected_to: 'пов’язаний запис',
  same_name_as: 'та сама назва',
  same_company_as: 'та сама компанія',
  similar_company_as: 'схожа компанія',
  same_as: 'той самий запис',
  same_id_as: 'той самий ідентифікатор',
  similar: 'схожий запис',
  underlying: 'базовий запис',
  probably_same_officer_as: 'імовірно та сама особа',
  same_address_as: 'та сама адреса',
  same_intermediary_as: 'той самий посередник',
};

/**
 * scripts/icij/load_icij.py name_key: NFKD, combining marks dropped, case-folded, every run
 * of non-alphanumerics (underscore included) collapsed to one space.
 */
export function icijNameKey(s: unknown): string | null {
  if (typeof s !== 'string' || !s) return null;
  const k = s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return k || null;
}

export const icijNodeUrl = (nodeId: string) => `https://offshoreleaks.icij.org/nodes/${encodeURIComponent(nodeId)}`;

const iso = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

const clampInt = (v: unknown, def: number, min: number, max: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

export interface IcijSearchArgs {
  name?: string;
  names?: string[];
  match?: 'exact' | 'contains';
  node_type?: string;
  jurisdiction?: string;
  country?: string;
  source_leak?: string;
  hops?: number;
  limit?: number;
  offset?: number;
  edges_per_node?: number;
}

const NODE_COLS = `node_id, node_type, name, name_key, original_name, former_name, jurisdiction, jurisdiction_description,
  country_codes, countries, company_type, status, service_provider, incorporation_date, inactivation_date,
  struck_off_date, address, source_id, source_leak, note`;

export class OffshoreLeaksTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [{
      name: 'search_offshore_leaks',
      annotations: { title: 'ICIJ Offshore Leaks: офшорні компанії та особи', readOnlyHint: true },
      description: `Пошук у базі ICIJ Offshore Leaks (Міжнародний консорціум журналістів-розслідувачів): Panama Papers, Paradise Papers, Pandora Papers, Offshore Leaks, Bahamas Leaks — 2 млн вузлів (офшорні компанії, особи, посередники, адреси) і 3,3 млн зв’язків між ними.

Пошук за назвою або іменем латиницею, як у витоку: match=contains (типово) шукає всі назви, що містять рядок; match=exact — лише точний збіг нормалізованої назви (регістр, діакритика й розділові знаки не враховуються). names — перевірка до ${MAX_NAMES} назв одним викликом, лише точний збіг. Фільтри: node_type (entity, officer, intermediary, address, other), jurisdiction (код ICIJ, наприклад BVI, PMA, SEY, або назва юрисдикції), country (код країни ISO 3166-1 alpha-3, наприклад UKR, CYP), source_leak.

Для кожного знайденого вузла — зв’язки на 1 крок (hops=1, типово) або 2 кроки (hops=2): тип зв’язку (officer_of, intermediary_of, registered_address тощо), опис ролі з витоку, дати початку й закінчення, назва витоку, і посилання на вузол на offshoreleaks.icij.org. Кількість зв’язків на вузол обмежено (edges_per_node, до ${MAX_EDGES_PER_NODE}); relationships.total показує загальну кількість.

Кожна відповідь містить атрибуцію ICIJ (ODbL 1.0) і застереження ICIJ: наявність у базі не означає незаконної чи неналежної поведінки, а однакові імена не доводять, що це та сама особа.`,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Назва компанії, ім’я особи, посередника чи адреса (латиницею, як у витоку), щонайменше 3 символи' },
          names: { type: 'array', items: { type: 'string' }, maxItems: MAX_NAMES, description: `Кілька назв для точної перевірки (до ${MAX_NAMES}); замість name` },
          match: { type: 'string', enum: ['contains', 'exact'], default: 'contains', description: 'contains — назва містить рядок; exact — точний збіг нормалізованої назви' },
          node_type: { type: 'string', enum: [...NODE_TYPES], description: 'Тип вузла: entity — компанія, officer — особа, intermediary — посередник, address — адреса, other — інше' },
          jurisdiction: { type: 'string', description: 'Юрисдикція реєстрації компанії: код ICIJ (BVI, PMA, SEY, BAH, MLT, CYP…) або назва англійською (British Virgin Islands)' },
          country: { type: 'string', description: 'Країна, пов’язана з вузлом, код ISO 3166-1 alpha-3 (UKR, CYP, RUS, GBR…)' },
          source_leak: { type: 'string', enum: [...SOURCE_LEAKS], description: 'Витік' },
          hops: { type: 'number', enum: [0, 1, 2], default: 1, description: 'Глибина зв’язків: 0 — без зв’язків, 1 — безпосередні, 2 — ще один крок (обмежено)' },
          limit: { type: 'number', default: DEFAULT_LIMIT, maximum: MAX_LIMIT, description: `Скільки вузлів повернути (до ${MAX_LIMIT})` },
          offset: { type: 'number', default: 0, description: 'Зсув для наступної сторінки' },
          edges_per_node: { type: 'number', default: DEFAULT_EDGES_PER_NODE, maximum: MAX_EDGES_PER_NODE, description: `Скільки зв’язків показати для кожного вузла (до ${MAX_EDGES_PER_NODE})` },
        },
      },
    }];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    if (name !== 'search_offshore_leaks') return null;
    try {
      return this.wrapResponse(await this.search(args ?? {}));
    } catch (e: any) {
      logger.error('search_offshore_leaks failed', { error: e?.message });
      const msg = e?.code === '57014'
        ? 'Запит перевищив ліміт часу: уточніть назву або додайте фільтр (node_type, jurisdiction, country, source_leak).'
        : `Помилка пошуку в ICIJ Offshore Leaks: ${e?.message ?? e}`;
      return { content: [{ type: 'text', text: JSON.stringify({ error: msg, attribution: ICIJ_ATTRIBUTION, caveat: ICIJ_CAVEAT }) }], isError: true };
    }
  }

  /** Compact JSON: a 25-node, 2-hop answer is already large. */
  protected override wrapResponse(data: any): ToolResult {
    return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] };
  }

  async search(args: IcijSearchArgs): Promise<any> {
    const names = Array.isArray(args.names) ? args.names : null;
    const keys = [...new Set((names ?? [args.name]).map(icijNameKey).filter((k): k is string => !!k))];
    const base = { attribution: ICIJ_ATTRIBUTION, caveat: ICIJ_CAVEAT };
    if (names && names.length > MAX_NAMES) return { ...base, error: `Не більше ${MAX_NAMES} назв за один виклик.` };
    if (keys.length === 0) return { ...base, error: 'Вкажіть name (назву чи ім’я латиницею) або names.' };
    const match: 'exact' | 'contains' = names ? 'exact' : args.match === 'exact' ? 'exact' : 'contains';
    if (match === 'contains' && keys[0].replace(/ /g, '').length < 3) {
      return { ...base, error: 'Для пошуку за частиною назви потрібно щонайменше 3 літери або цифри.' };
    }
    if (args.node_type && !(NODE_TYPES as readonly string[]).includes(args.node_type)) {
      return { ...base, error: `node_type має бути одним із: ${NODE_TYPES.join(', ')}.` };
    }
    if (args.source_leak && !(SOURCE_LEAKS as readonly string[]).includes(args.source_leak)) {
      return { ...base, error: `source_leak має бути одним із: ${SOURCE_LEAKS.join(', ')}.` };
    }
    const country = args.country ? String(args.country).trim().toUpperCase() : null;
    if (country && !/^[A-Z]{3}$/.test(country)) return { ...base, error: 'country — код країни ISO 3166-1 alpha-3, наприклад UKR.' };

    const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(args.offset, 0, 0, 10_000);
    const hops = clampInt(args.hops ?? 1, 1, 0, 2);
    const edgesPerNode = clampInt(args.edges_per_node, DEFAULT_EDGES_PER_NODE, 1, MAX_EDGES_PER_NODE);

    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (match === 'exact') where.push(`name_key = ANY(${p(keys)}::text[])`);
    else where.push(`name_key LIKE ${p(`%${keys[0].replace(/[\\%_]/g, (c) => `\\${c}`)}%`)}`);
    if (args.node_type) where.push(`node_type = ${p(args.node_type)}`);
    if (args.source_leak) where.push(`source_leak = ${p(args.source_leak)}`);
    if (country) where.push(`country_codes @> ARRAY[${p(country)}]::text[]`);
    if (args.jurisdiction) {
      const j = String(args.jurisdiction).trim();
      where.push(`(jurisdiction = ${p(j.toUpperCase())} OR jurisdiction_description ILIKE ${p(j)})`);
    }

    let sql: string;
    if (match === 'exact') {
      sql = `SELECT ${NODE_COLS}, COUNT(*) OVER() AS _total FROM icij_nodes WHERE ${where.join(' AND ')}
             ORDER BY name_key, node_type, node_id LIMIT ${p(limit)} OFFSET ${p(offset)}`;
    } else {
      // Read a bounded candidate set, then rank: the exact key first, then the shortest names.
      // Exact matches are read separately so a common word cannot push them out of the set.
      const exactP = p(keys[0]);
      const exactWhere = [`name_key = ${exactP}`, ...where.slice(1)].join(' AND ');
      sql = `SELECT *, COUNT(*) OVER() AS _total FROM (
               (SELECT ${NODE_COLS} FROM icij_nodes WHERE ${exactWhere} LIMIT ${CONTAINS_CANDIDATES})
               UNION
               (SELECT ${NODE_COLS} FROM icij_nodes WHERE ${where.join(' AND ')} LIMIT ${CONTAINS_CANDIDATES + 1})
             ) c
             ORDER BY (name_key = ${exactP}) DESC, length(name_key), name_key, node_id LIMIT ${p(limit)} OFFSET ${p(offset)}`;
    }

    const [rows, snapshot] = await Promise.all([this.q(sql, params), this.snapshot()]);
    const total = rows.length ? Number(rows[0]._total) : 0;
    const totalCapped = match === 'contains' && total > CONTAINS_CANDIDATES;

    const nodes = rows.map((r) => this.node(r));
    if (hops > 0 && nodes.length) await this.attachEdges(nodes, edgesPerNode, hops);

    return {
      query: { ...(names ? { names: keys } : { name: args.name, name_key: keys[0] }), match,
        ...(args.node_type ? { node_type: args.node_type } : {}), ...(args.jurisdiction ? { jurisdiction: args.jurisdiction } : {}),
        ...(country ? { country } : {}), ...(args.source_leak ? { source_leak: args.source_leak } : {}), hops, limit, offset },
      source: { name: ICIJ_SOURCE_NAME, as_of: snapshot?.generated_on ?? null,
        as_of_basis: 'дата формування архіву ICIJ (GENERATED_ON)', loaded_at: snapshot?.loaded_at ?? null },
      total: totalCapped ? CONTAINS_CANDIDATES : total,
      ...(totalCapped ? { total_is_lower_bound: true, note: `Збігів більше ${CONTAINS_CANDIDATES}: уточніть назву або додайте фільтр.` } : {}),
      returned: nodes.length,
      more_available: totalCapped || offset + nodes.length < total,
      results: nodes,
      ...(nodes.length ? {} : { message: 'У базі ICIJ Offshore Leaks збігів не знайдено. Відсутність збігу не означає, що особа чи компанія не має офшорних зв’язків: база охоплює лише п’ять витоків.' }),
      ...base,
    };
  }

  private node(r: any): any {
    const out: Record<string, unknown> = {
      node_id: r.node_id, node_type: r.node_type, node_type_label: NODE_TYPE_LABELS[r.node_type] ?? r.node_type,
      name: r.name, name_key: r.name_key,
    };
    const opt: Record<string, unknown> = {
      original_name: r.original_name !== r.name ? r.original_name : null, former_name: r.former_name,
      jurisdiction: r.jurisdiction, jurisdiction_description: r.jurisdiction_description,
      country_codes: r.country_codes?.length ? r.country_codes : null, countries: r.countries?.length ? r.countries : null,
      company_type: r.company_type, status: r.status, service_provider: r.service_provider,
      incorporation_date: iso(r.incorporation_date), inactivation_date: iso(r.inactivation_date), struck_off_date: iso(r.struck_off_date),
      address: r.address, note: r.note,
    };
    for (const [k, v] of Object.entries(opt)) if (v != null && v !== '') out[k] = v;
    out.source_leak = r.source_leak;
    out.source_id = r.source_id;
    out.url = icijNodeUrl(r.node_id);
    return out;
  }

  /** Edges of the given nodes, capped per node and per direction, with the far node's card. */
  private async edgesOf(ids: string[], perNode: number): Promise<{ edges: Map<string, any[]>; totals: Map<string, number> }> {
    const rows = await this.q(
      `SELECT n.id AS origin, e.*
         FROM unnest($1::text[]) AS n(id)
         CROSS JOIN LATERAL (
           (SELECT 'out' AS direction, r.node_id_end AS other_id, r.rel_type, r.link, r.start_date, r.end_date, r.status, r.source_leak
              FROM icij_relationships r WHERE r.node_id_start = n.id LIMIT $2)
           UNION ALL
           (SELECT 'in', r.node_id_start, r.rel_type, r.link, r.start_date, r.end_date, r.status, r.source_leak
              FROM icij_relationships r WHERE r.node_id_end = n.id LIMIT $2)
         ) e`,
      [ids, perNode]);
    const counts = await this.q(
      `SELECT n.id AS origin,
              (SELECT count(*) FROM (SELECT 1 FROM icij_relationships r WHERE r.node_id_start = n.id LIMIT $2) a)
            + (SELECT count(*) FROM (SELECT 1 FROM icij_relationships r WHERE r.node_id_end = n.id LIMIT $2) b) AS total
         FROM unnest($1::text[]) AS n(id)`,
      [ids, EDGE_COUNT_CAP]);
    const totals = new Map<string, number>(counts.map((c) => [c.origin, Number(c.total)]));
    const edges = new Map<string, any[]>();
    for (const r of rows) {
      const list = edges.get(r.origin) ?? [];
      if (list.length < perNode) list.push(r);
      edges.set(r.origin, list);
    }
    return { edges, totals };
  }

  private async cards(ids: string[]): Promise<Map<string, any>> {
    if (!ids.length) return new Map();
    const rows = await this.q(
      `SELECT DISTINCT ON (node_id) node_id, node_type, name, jurisdiction, jurisdiction_description, country_codes, address, source_leak
         FROM icij_nodes WHERE node_id = ANY($1::text[]) ORDER BY node_id, node_type`, [ids]);
    return new Map(rows.map((r) => [r.node_id, r]));
  }

  private edge(r: any, card: any): any {
    const node: Record<string, unknown> = { node_id: r.other_id };
    if (card) {
      node.node_type = card.node_type;
      node.name = card.name ?? card.address ?? null;
      if (card.jurisdiction_description || card.jurisdiction) node.jurisdiction = card.jurisdiction_description || card.jurisdiction;
      if (card.country_codes?.length) node.country_codes = card.country_codes;
    }
    node.url = icijNodeUrl(r.other_id);
    const out: Record<string, unknown> = {
      direction: r.direction, rel_type: r.rel_type, rel_label: REL_TYPE_LABELS[r.rel_type] ?? r.rel_type,
    };
    if (r.link && r.link !== r.rel_type) out.link = r.link;
    if (r.start_date) out.start_date = iso(r.start_date);
    if (r.end_date) out.end_date = iso(r.end_date);
    if (r.status) out.status = r.status;
    out.source_leak = r.source_leak;
    out.node = node;
    return out;
  }

  private async attachEdges(nodes: any[], perNode: number, hops: number): Promise<void> {
    const ids = [...new Set(nodes.map((n) => n.node_id as string))];
    const { edges, totals } = await this.edgesOf(ids, perNode);

    let hop2: { edges: Map<string, any[]>; totals: Map<string, number> } | null = null;
    const neighbourIds = [...new Set([...edges.values()].flat().map((e) => e.other_id as string))];
    const expand = hops >= 2 ? neighbourIds.filter((id) => !ids.includes(id)).slice(0, HOP2_NODES) : [];
    if (expand.length) hop2 = await this.edgesOf(expand, HOP2_EDGES_PER_NODE);
    const hop2Ids = hop2 ? [...hop2.edges.values()].flat().map((e) => e.other_id as string) : [];
    const cards = await this.cards([...new Set([...neighbourIds, ...hop2Ids])]);

    for (const n of nodes) {
      const list = edges.get(n.node_id) ?? [];
      const total = totals.get(n.node_id) ?? list.length;
      n.relationships = {
        total: total >= 2 * EDGE_COUNT_CAP ? `${2 * EDGE_COUNT_CAP}+` : total,
        shown: list.length,
        truncated: list.length < total,
        items: list.map((r) => {
          const e = this.edge(r, cards.get(r.other_id));
          const next = hop2?.edges.get(r.other_id);
          if (next) {
            const t = hop2!.totals.get(r.other_id) ?? next.length;
            const items = next.filter((x) => x.other_id !== n.node_id).map((x) => this.edge(x, cards.get(x.other_id)));
            e.next_hop = { total: t, shown: items.length, truncated: next.length < t, items };
          }
          return e;
        }),
      };
    }
    if (hops >= 2 && neighbourIds.length > expand.length) {
      nodes[0].relationships.second_hop_note = `Другий крок показано для ${expand.length} із ${neighbourIds.length} сусідніх вузлів (по ${HOP2_EDGES_PER_NODE} зв’язків).`;
    }
  }

  private async snapshot(): Promise<{ generated_on: string | null; loaded_at: string | null } | null> {
    try {
      const r = await this.q(`SELECT generated_on, loaded_at FROM icij_snapshots ORDER BY loaded_at DESC LIMIT 1`, []);
      return r[0] ? { generated_on: iso(r[0].generated_on), loaded_at: r[0].loaded_at ? new Date(r[0].loaded_at).toISOString() : null } : null;
    } catch {
      return null;
    }
  }

  /** One statement under a server-side timeout, so a pathological scan is cancelled by Postgres. */
  private async q(sql: string, values: unknown[]): Promise<any[]> {
    if (typeof this.db.transaction !== 'function') return (await this.db.query(sql, values)).rows;
    const res = await this.db.transaction(async (client: any) => {
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      return client.query(sql, values);
    });
    return res.rows;
  }
}
