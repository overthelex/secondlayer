/**
 * Decision↔case citation graph (LEXAI-2314), read from Postgres.
 *
 * Source: case_citation_links, built by scripts/citation-graph/rebuild-case-graph-01-finalize.sql
 * from case_citation_edges, which rebuild-case-edges.py / extract-citations.py fill with every
 * "№ 761/9584/15-ц" found anywhere in a decision's text (case_numbers.py has the pattern).
 *   from_doc_id      — the citing decision (ЄДРСР doc_id)
 *   to_case_number   — resolved: the cited case's cause_num exactly as edrsr_case_index spells it;
 *                      unresolved: the cited number normalized ("base" or "base-suffix", lowercase)
 *   resolved         — the number (or its unique suffixed / bare counterpart) is a case in the index
 *   is_self_citation — the citing decision belongs to the cited case (suffix-aware)
 *   citation_context — the reference as written in the text, so it can be found again with strpos
 *   adj_year         — the citing decision's year (Kyiv time), i.e. its edrsr_documents and
 *                      edrsr_fulltext partition, which the queries below use for pruning
 *
 * Things measured on prod that shape this module:
 * - Bare citations ("№ 761/9584/15") of a base number that several real cases share
 *   ("…-ц" and "…-к") are left unresolved (unresolved_reason = ambiguous_suffix) rather than
 *   attributed to either; asked about the bare number, both cases are answered together.
 * - A cited case is a case, not a decision: which decision of the cited case is meant is
 *   not recorded. For outgoing citations the top decision of the cited case (highest
 *   instance, final form first) stands in for it.
 * - Fan-out: the most cited case (826/3858/18) has 184K citing decisions. Incoming
 *   citations are counted in full, but only the WINDOW most recently published ones are
 *   joined to their documents and ranked, so the answer stays sub-second.
 * - These queries trip Postgres JIT (cost estimates over 25 partitions), which added
 *   ~1.4s to a 200ms query; they run in a read-only transaction with jit off.
 */
import { logger } from '../utils/logger.js';
import { causeNumRangeEnd, formatCourtDate } from './tool-utils.js';

/** How many most recent incoming citations are ranked by instance (all are counted). */
export const CITED_BY_WINDOW = 10000;
/** How many cited case numbers of a decision/case are resolved and ranked. */
const CITES_ENRICH_CAP = 100;
export const MAX_CITATION_LIMIT = 50;
const SNIPPET_RADIUS = 220;
const GRAND_CHAMBER = 9951;
/** Supreme Court (since 15.12.2017): the plenary code and its five benches. */
const SUPREME_COURT_CODES = new Set([9901, 9911, 9921, 9931, 9941, 9951]);

export const COVERAGE_NOTE =
  'Граф цитувань між справами перебудовано 20.11.2026 за повними текстами рішень ЄДРСР, наявних у корпусі на цю дату ' +
  '(найновіші — від __NEWEST__): пізніші рішення в ньому ще не враховано. Посилання розпізнано за номером справи ' +
  'з процесуальним суфіксом (наприклад, 761/9584/15-ц) у всьому тексті рішення.';

const INSTANCE_LABELS: Record<number, string> = { 1: 'касаційна', 2: 'апеляційна', 3: 'перша' };
const JUDGMENT_FORMS: Record<number, string> = {
  1: 'Вирок', 2: 'Постанова', 3: 'Рішення', 4: 'Судовий наказ', 5: 'Ухвала',
  6: 'Окрема ухвала', 7: 'Додаткове рішення', 10: 'Окрема думка',
};

type Query = (sql: string, params?: any[]) => Promise<{ rows: any[] }>;

/**
 * Run `fn` in a read-only transaction with JIT off and a statement timeout. Accepts a
 * BaseDatabase (getPool()), a pg Pool, or anything with query() (tests); the last runs the
 * queries as they are.
 */
export async function withCitationSession<T>(db: any, fn: (q: Query) => Promise<T>): Promise<T> {
  // BaseDatabase.connect() is a health check, not a checkout, so only its getPool() counts;
  // a bare pg Pool is recognised by its pool counters.
  const pool = typeof db?.getPool === 'function'
    ? db.getPool()
    : db && typeof db.connect === 'function' && 'totalCount' in db ? db : null;
  if (!pool) return fn((sql, params) => db.query(sql, params));
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL jit = off`);
    await client.query(`SET LOCAL statement_timeout = '20s'`);
    const out = await fn((sql, params) => client.query(sql, params));
    await client.query('COMMIT');
    return out;
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch (e: any) { broken = e; }
    throw error;
  } finally {
    client.release(broken);
  }
}

/** Suffixes kept by the extractor (case_numbers.py SUFFIXES), lowercased Cyrillic. */
const SUFFIXES = new Set(['ц', 'к', 'п', 'а', 'г', 'е', 'ап', 'нр', 'б', 'н', 'на', 'зн', 'кр']);
/** Latin look-alikes and the w/r/g/f layout typos for ц/к/п/а (case_numbers.py _SUFFIX_MAP). */
const SUFFIX_MAP: Record<string, string> = {
  a: 'а', e: 'е', k: 'к', c: 'с', o: 'о', p: 'р', x: 'х', h: 'н', w: 'ц', r: 'к', g: 'п', f: 'а',
};
const CASE_NUMBER_RE = /^(\d{1,4}\/\d{1,10}\/\d{2,4})(?:\s*[-\u2010-\u2015\u2212]\s*([A-Za-zА-Яа-яІіЇїЄєҐґ]{1,3}))?$/;

/**
 * The key a case number is stored under in case_citation_edges and matched by in the
 * resolver: "base" or "base-suffix" with an ASCII hyphen and a lowercased Cyrillic suffix.
 * Null for shapes the extractor never captures (e.g. pre-2017 "5-15кс12" or "2а-2258/2011")
 * or for a suffix outside the measured set.
 */
export function normalizeCaseNumber(caseNumber: string): string | null {
  const m = String(caseNumber || '').trim().match(CASE_NUMBER_RE);
  if (!m) return null;
  if (!m[2]) return m[1];
  const suffix = [...m[2].toLowerCase()].map((ch) => SUFFIX_MAP[ch] ?? ch).join('');
  return SUFFIXES.has(suffix) ? `${m[1]}-${suffix}` : null;
}

function baseOf(normalized: string): string {
  return normalized.split('-')[0];
}

/** The same number in its other year spelling ("…/15" ↔ "…/2015"), suffix kept. */
function yearVariants(normalized: string): string[] {
  const m = normalized.match(/^(\d+\/\d+\/)(\d{2}|\d{4})(-.+)?$/);
  if (!m) return [normalized];
  const [, prefix, year, suffix = ''] = m;
  const other = year.length === 2 ? `20${year}` : year.startsWith('20') ? year.slice(2) : null;
  return other ? [normalized, `${prefix}${other}${suffix}`] : [normalized];
}

/**
 * The normalized spellings a citation of this case can be stored under when it did not
 * resolve: the number itself in both year spellings. Empty when the number has a shape the
 * extractor never captures.
 */
export function citationKeys(caseNumber: string): string[] {
  const n = normalizeCaseNumber(caseNumber);
  return n ? [...new Set(yearVariants(n))] : [];
}

/** Real case numbers in edrsr_case_index that share one of these bare numbers. */
async function siblingCases(q: Query, bases: string[]): Promise<Map<string, Array<{ cause_num: string; member_count: number; first_date: any; last_date: any }>>> {
  const out = new Map<string, any[]>();
  const lo: string[] = [];
  const hi: string[] = [];
  for (const b of bases) {
    const end = causeNumRangeEnd(b);
    if (!end) continue;
    lo.push(b);
    hi.push(end);
  }
  if (lo.length === 0) return out;
  // Btree range on the primary key + exact LIKE inside it (see hasSuffixedSibling in tool-utils).
  const { rows } = await q(
    `SELECT x.base, s.cause_num, s.member_count, s.first_date, s.last_date
       FROM unnest($1::text[], $2::text[]) AS x(base, hi)
       JOIN LATERAL (
         SELECT cause_num, COALESCE(member_count, 0)::int AS member_count, first_date, last_date
           FROM edrsr_case_index
          WHERE cause_num >= x.base AND cause_num < x.hi
            AND (cause_num = x.base OR cause_num LIKE x.base || '-%')
          ORDER BY member_count DESC NULLS LAST
          LIMIT 20) s ON true`,
    [lo, hi],
  );
  for (const r of rows) {
    const list = out.get(r.base) ?? [];
    list.push({ cause_num: r.cause_num, member_count: Number(r.member_count), first_date: r.first_date, last_date: r.last_date });
    out.set(r.base, list);
  }
  return out;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Snippets around the first mention of `key` in each citing decision's text. */
async function snippets(q: Query, items: Array<{ doc_id: string; adj_year: number; key: string }>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const valid = items.filter((i) => i.adj_year);
  if (valid.length === 0) return out;
  const { rows } = await q(
    `SELECT x.doc_id::text AS doc_id, x.key,
            substr(f.full_text, greatest(strpos(f.full_text, x.key) - $4::int, 1), 2 * $4::int + length(x.key)) AS snippet
       FROM unnest($1::bigint[], $2::int[], $3::text[]) AS x(doc_id, adj_year, key)
       JOIN edrsr_fulltext f ON f.doc_id = x.doc_id AND f.adj_year = x.adj_year
      WHERE strpos(f.full_text, x.key) > 0`,
    [valid.map((i) => i.doc_id), valid.map((i) => i.adj_year), valid.map((i) => i.key), SNIPPET_RADIUS],
  );
  for (const r of rows) {
    if (r.snippet) out.set(`${r.doc_id}|${r.key}`, collapse(String(r.snippet)));
  }
  return out;
}

function decisionView(r: any) {
  const courtCode = r.court_code == null ? null : Number(r.court_code);
  const instance = r.instance_code == null ? null : Number(r.instance_code);
  return {
    doc_id: String(r.doc_id),
    case_number: r.cause_num ?? undefined,
    court: r.court_name ?? undefined,
    court_code: courtCode ?? undefined,
    instance: instance ? INSTANCE_LABELS[instance] : undefined,
    judgment_form: r.judgment_code != null ? JUDGMENT_FORMS[Number(r.judgment_code)] : undefined,
    date: formatCourtDate(r.adjudication_date),
    ...(courtCode != null && SUPREME_COURT_CODES.has(courtCode) ? { supreme_court: true } : {}),
    ...(courtCode === GRAND_CHAMBER ? { grand_chamber: true } : {}),
    url: `https://reyestr.court.gov.ua/Review/${r.doc_id}`,
  };
}

export interface CitedByResult {
  case_number: string;
  /** The to_case_number values looked up: the case's spellings in the index, plus its normalized form. */
  citation_keys: string[];
  /** Citing decisions outside the case itself, over the whole graph. */
  total_citing_decisions: number;
  scanned: {
    window: number;
    citing_decisions: number;
    truncated: boolean;
    by_instance: { cassation: number; supreme_court: number; grand_chamber: number; appeal: number; first: number };
  };
  citing_decisions: any[];
  /** Asked by a bare number that several real cases share: all of them, answered together. */
  same_number_cases?: string[];
}

/**
 * Which edrsr_case_index spellings a citation of `caseNumber` is stored under, and whether
 * the answer is the union of several real cases (a bare number shared by "…-ц" and "…-к").
 */
async function caseSpellings(q: Query, caseNumber: string): Promise<{ keys: string[]; sameNumber: string[] } | null> {
  const norm = normalizeCaseNumber(caseNumber);
  if (!norm) return null;
  const variants = yearVariants(norm);
  const siblings = await siblingCases(q, [...new Set(variants.map(baseOf))]);
  const all = [...siblings.values()].flat().map((s) => s.cause_num);
  const byNorm = new Map<string, string[]>();
  for (const c of all) {
    const n = normalizeCaseNumber(c);
    if (!n) continue;
    byNorm.set(n, [...(byNorm.get(n) ?? []), c]);
  }
  const exact = variants.flatMap((v) => byNorm.get(v) ?? []);
  let spellings: string[];
  let sameNumber: string[] = [];
  if (exact.length > 0) {
    spellings = exact;
  } else if (norm === baseOf(norm) && byNorm.size > 0) {
    // Bare number, stored only with suffixes: one case completes it, several are answered together.
    spellings = [...byNorm.values()].flat();
    if (byNorm.size > 1) sameNumber = [...byNorm.values()].map((v) => v[0]);
  } else if (byNorm.size === 1 && [...byNorm.keys()][0] === baseOf(norm)) {
    // Suffix typed, EDRSR keeps the case bare (the resolver drops it the same way).
    spellings = [...byNorm.values()][0];
  } else {
    spellings = [];
  }
  return { keys: [...new Set([...spellings, ...variants, ...(sameNumber.length ? variants.map(baseOf) : [])])], sameNumber };
}

/** Which decisions cite the case (by number), highest instance first, newest first. */
export async function citedBy(
  q: Query,
  caseNumber: string,
  opts: { limit: number; window?: number; withContext?: boolean; onlySupremeCourt?: boolean },
): Promise<CitedByResult | null> {
  const spell = await caseSpellings(q, caseNumber);
  if (!spell) return null;
  const { keys, sameNumber } = spell;
  const window = opts.window ?? CITED_BY_WINDOW;

  const { rows } = await q(
    `WITH l AS MATERIALIZED (
       SELECT from_doc_id, adj_year, to_case_number, citation_context, count(*) OVER () AS total
         FROM case_citation_links
        WHERE to_case_number = ANY($1::text[]) AND NOT is_self_citation AND adj_year IS NOT NULL
        ORDER BY from_doc_id + 0 DESC
        LIMIT $2
     ), j AS (
       SELECT d.doc_id, d.court_code, d.judgment_code, d.cause_num, d.adjudication_date,
              l.adj_year, l.to_case_number, l.citation_context, l.total, c.instance_code, c.name AS court_name
         FROM l
         JOIN edrsr_documents d ON d.doc_id = l.from_doc_id
          AND d.adjudication_date >= make_timestamptz(l.adj_year, 1, 1, 0, 0, 0, 'Europe/Kyiv')
          AND d.adjudication_date <  make_timestamptz(l.adj_year + 1, 1, 1, 0, 0, 0, 'Europe/Kyiv')
         LEFT JOIN edrsr_courts c ON c.court_code = d.court_code
        WHERE d.cause_num IS NULL OR d.cause_num <> ALL($3::text[])
     ), ranked AS (
       SELECT j.*,
              count(*) OVER () AS scanned,
              count(*) FILTER (WHERE instance_code = 1) OVER () AS n_cass,
              count(*) FILTER (WHERE court_code = ANY($5::int[])) OVER () AS n_sc,
              count(*) FILTER (WHERE court_code = ${GRAND_CHAMBER}) OVER () AS n_gc,
              count(*) FILTER (WHERE instance_code = 2) OVER () AS n_app,
              count(*) FILTER (WHERE instance_code = 3) OVER () AS n_first
         FROM j
     )
     SELECT doc_id::text AS doc_id, court_code, judgment_code, cause_num, adjudication_date, adj_year,
            to_case_number, citation_context, instance_code, court_name, total::int, scanned::int,
            n_cass::int, n_sc::int, n_gc::int, n_app::int, n_first::int
       FROM ranked
      WHERE NOT $6::boolean OR court_code = ANY($5::int[])
      ORDER BY instance_code NULLS LAST, (court_code = ${GRAND_CHAMBER}) DESC, adjudication_date DESC
      LIMIT $4`,
    [keys, window, keys, opts.limit, [...SUPREME_COURT_CODES], Boolean(opts.onlySupremeCourt)],
  );

  const first = rows[0];
  let total = first ? Number(first.total) : 0;
  let scanned = first ? Number(first.scanned) : 0;
  if (!first) {
    // Nothing ranked (no citations, or no supreme-court ones): the total still has to come from somewhere.
    const { rows: t } = await q(
      `SELECT count(*)::int AS n FROM case_citation_links WHERE to_case_number = ANY($1::text[]) AND NOT is_self_citation`,
      [keys],
    );
    total = Number(t[0]?.n ?? 0);
    scanned = 0;
  }

  let ctx = new Map<string, string>();
  if (opts.withContext !== false && rows.length > 0) {
    try {
      ctx = await snippets(q, rows.map((r) => ({ doc_id: r.doc_id, adj_year: Number(r.adj_year), key: snippetKey(r) })));
    } catch (error: any) {
      logger.warn('[case-citation-graph] context snippets failed (non-fatal)', { caseNumber, error: error?.message });
    }
  }

  return {
    case_number: caseNumber,
    citation_keys: keys,
    total_citing_decisions: total,
    scanned: {
      window,
      citing_decisions: scanned,
      truncated: total > window,
      by_instance: {
        cassation: first ? Number(first.n_cass) : 0,
        supreme_court: first ? Number(first.n_sc) : 0,
        grand_chamber: first ? Number(first.n_gc) : 0,
        appeal: first ? Number(first.n_app) : 0,
        first: first ? Number(first.n_first) : 0,
      },
    },
    citing_decisions: rows.map((r) => {
      const snippet = ctx.get(`${r.doc_id}|${snippetKey(r)}`);
      return { ...decisionView(r), ...(snippet ? { context: snippet } : {}) };
    }),
    ...(sameNumber.length > 1 ? { same_number_cases: sameNumber } : {}),
  };
}

/** What to look for in the citing text: the reference as written, else the stored number. */
function snippetKey(r: { citation_context?: string | null; to_case_number: string }): string {
  const c = String(r.citation_context ?? '').trim();
  return c && !c.startsWith('№') ? c : r.to_case_number;
}

export interface CitesResult {
  documents_scanned: number;
  total_cited_cases: number;
  cited_cases: any[];
  truncated: boolean;
}

/** Which cases the given decisions cite, the cited case's top decision first by instance. */
export async function cites(
  q: Query,
  docIds: string[],
  ownCaseNumber: string | null,
  opts: { limit: number; withContext?: boolean },
): Promise<CitesResult> {
  const own = ownCaseNumber ? [...new Set([ownCaseNumber, ...citationKeys(ownCaseNumber)])] : [];
  const { rows: edges } = await q(
    `SELECT l.to_case_number, bool_or(l.resolved) AS resolved, count(*)::int AS n_docs,
            (array_agg(l.from_doc_id::text ORDER BY l.from_doc_id))[1] AS sample_doc_id,
            (array_agg(l.adj_year ORDER BY l.from_doc_id))[1]::int AS sample_year,
            (array_agg(l.citation_context ORDER BY l.from_doc_id))[1] AS sample_context,
            count(*) OVER ()::int AS total
       FROM case_citation_links l
      WHERE l.from_doc_id = ANY($1::bigint[]) AND NOT l.is_self_citation
        AND l.to_case_number <> ALL($2::text[])
      GROUP BY l.to_case_number
      ORDER BY count(*) DESC, l.to_case_number
      LIMIT $3`,
    [docIds, own, CITES_ENRICH_CAP],
  );
  const total = edges[0] ? Number(edges[0].total) : 0;
  if (edges.length === 0) return { documents_scanned: docIds.length, total_cited_cases: 0, cited_cases: [], truncated: false };

  // Resolved edges carry the index spelling itself; unresolved bare ones may still have
  // several candidate cases on their base, which are listed but not chosen between.
  const resolvedNums = edges.filter((e) => e.resolved).map((e) => e.to_case_number);
  const known = new Map<string, any>();
  if (resolvedNums.length > 0) {
    const { rows } = await q(
      `SELECT cause_num, COALESCE(member_count, 0)::int AS member_count, first_date, last_date
         FROM edrsr_case_index WHERE cause_num = ANY($1::text[])`,
      [resolvedNums],
    );
    for (const r of rows) known.set(r.cause_num, { ...r, member_count: Number(r.member_count) });
  }
  const unresolvedBases = edges.filter((e) => !e.resolved).map((e) => baseOf(e.to_case_number));
  const siblings = unresolvedBases.length > 0 ? await siblingCases(q, [...new Set(unresolvedBases)]) : new Map();

  const resolved = [...known.values()];
  const top = new Map<string, any>();
  if (resolved.length > 0) {
    // first/last_date bound the case's documents, so each lookup touches its own partitions only.
    const { rows } = await q(
      `SELECT x.cause_num, b.*
         FROM unnest($1::text[], $2::timestamptz[], $3::timestamptz[]) AS x(cause_num, first_date, last_date)
         JOIN LATERAL (
           SELECT d.doc_id::text AS doc_id, d.court_code, d.judgment_code, d.adjudication_date,
                  c.instance_code, c.name AS court_name
             FROM edrsr_documents d
             LEFT JOIN edrsr_courts c ON c.court_code = d.court_code
            WHERE d.cause_num = x.cause_num
              AND d.adjudication_date >= x.first_date AND d.adjudication_date <= x.last_date
            ORDER BY c.instance_code NULLS LAST, (d.judgment_code NOT IN (1, 2, 3, 7)), d.adjudication_date DESC
            LIMIT 1) b ON true`,
      [resolved.map((r) => r.cause_num), resolved.map((r) => r.first_date), resolved.map((r) => r.last_date)],
    );
    for (const r of rows) top.set(r.cause_num, r);
  }

  const items = edges.map((e) => {
    const match = e.resolved ? known.get(e.to_case_number) ?? null : null;
    const candidates: any[] = e.resolved ? [] : siblings.get(baseOf(e.to_case_number)) ?? [];
    const best = match ? top.get(match.cause_num) : null;
    return {
      edge: e,
      instance: best?.instance_code ?? 9,
      gc: best?.court_code === GRAND_CHAMBER,
      date: best?.adjudication_date ? new Date(best.adjudication_date).getTime() : 0,
      view: {
        cited_case_number: e.to_case_number,
        ...(match ? { case_number: match.cause_num, documents_in_case: match.member_count } : {}),
        in_corpus: Boolean(match),
        ...(candidates.length > 0 ? { candidate_cases: candidates.map((s) => s.cause_num) } : {}),
        cited_in_documents: e.n_docs,
        ...(best ? { top_decision: decisionView({ ...best, cause_num: match!.cause_num }) } : {}),
      } as any,
    };
  });
  items.sort((a, b) => a.instance - b.instance || Number(b.gc) - Number(a.gc) || b.date - a.date
    || b.edge.n_docs - a.edge.n_docs);
  const shown = items.slice(0, opts.limit);

  if (opts.withContext !== false && shown.length > 0) {
    try {
      const keyOf = (e: any) => snippetKey({ citation_context: e.sample_context, to_case_number: e.to_case_number });
      const ctx = await snippets(q, shown.map((s) => ({ doc_id: s.edge.sample_doc_id, adj_year: Number(s.edge.sample_year), key: keyOf(s.edge) })));
      for (const s of shown) {
        const snippet = ctx.get(`${s.edge.sample_doc_id}|${keyOf(s.edge)}`);
        if (snippet) s.view.context = snippet;
      }
    } catch (error: any) {
      logger.warn('[case-citation-graph] context snippets failed (non-fatal)', { error: error?.message });
    }
  }

  return {
    documents_scanned: docIds.length,
    total_cited_cases: total,
    cited_cases: shown.map((s) => s.view),
    truncated: total > shown.length,
  };
}

/** ЄДРСР doc_ids of one case (exact cause_num), and the case of one doc_id. */
export async function caseDocIds(q: Query, causeNum: string, cap = 500): Promise<string[]> {
  const { rows } = await q(
    `SELECT doc_id::text AS doc_id FROM edrsr_documents WHERE cause_num = $1 ORDER BY doc_id LIMIT $2`,
    [causeNum, cap],
  );
  return rows.map((r) => r.doc_id);
}

export async function docCaseNumber(q: Query, docId: string): Promise<string | null> {
  const { rows } = await q(`SELECT cause_num FROM edrsr_documents WHERE doc_id = $1::bigint LIMIT 1`, [docId]);
  return rows[0]?.cause_num ?? null;
}
