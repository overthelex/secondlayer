/**
 * CitationGraphService — the EDRSR citation graph, served from Postgres (LEXAI-2323).
 *
 * Until November 2026 this class talked to a Neo4j store (neo4j-citation, 156 GB). Every
 * layer it read now lives in Postgres, in the same database as the EDRSR corpus:
 *
 *   decision -> article     decision_statute_citations (+ statute_article_stats for the
 *                           old (:Article {total_citations, unique_decisions}) properties)
 *   decision -> case        case_citation_links (resolved, suffix-aware; LEXAI-2314)
 *                           + case_citation_counts (the old Case.cited_by_count)
 *   case dimension          edrsr_case_index (member_count, latest_doc_id)
 *   instance status         decision_supersession / decision_dissent / decision_instance_status
 *                           (the old SUPERSEDED_BY / HAS_DISSENT / Decision.status, LEXAI-1861)
 *   Grand Chamber departure case_position_departures (the old DEPARTS_FROM, LEXAI-1779)
 *
 * The method names and result shapes are the ones the Neo4j version had, so callers did
 * not change beyond the `backend` label. Two Neo4j-era behaviours are kept on purpose:
 * - Articles cited by fewer than MIN_ARTICLE_DECISIONS distinct decisions are left out of
 *   summaries and graphs: the Neo4j build dropped them as noise (raw law_number values are
 *   often fragments of decision text), and the raw rows stay in decision_statute_citations.
 * - Depth 2 used to add COCITED edges; that layer was never loaded (0 edges), so depth is
 *   accepted and ignored rather than faked.
 *
 * isEnabled() no longer depends on CITATION_BACKEND: the service is on whenever its tables
 * exist in the database it is given (checked once, lazily), and off otherwise, so a
 * deployment without them (lawrider.*) degrades exactly as before. CITATION_BACKEND=off
 * still switches it off.
 */

import { logger } from '../utils/logger.js';

export interface ArticleCitation {
  law: string;
  article: string;
  citationType?: string | null;
  context?: string | null;
}

export interface CitedArticleStat {
  law: string;
  article: string;
  totalCitations: number;
  uniqueDecisions: number;
}

export interface CitedArticleRef {
  law: string;
  article: string;
  citationType?: string | null;
  /** How often this cited article is referenced corpus-wide — a cheap authority signal. */
  popularity: number;
}

export interface DecisionCitationSummary {
  /** Statute-article citations of this decision (noise-filtered, see MIN_ARTICLE_DECISIONS). */
  citedCount: number;
  /** Top cited articles, ordered by corpus-wide popularity (most authoritative first). */
  topCitedArticles: CitedArticleRef[];
}

/** Precedent stats for a case from the decision↔case layer. */
export interface CaseStat {
  causeNum: string;
  /** How many decisions cite this case (resolved, not self-citations). */
  citingDecisions: number;
  /** Number of documents in the case across instances. */
  memberCount: number;
  /** Most recent document of the case; null if unknown. */
  latestDocId: string | null;
  /** Latest Grand Chamber decision that departed from this case's legal position, and when. */
  departedByDecision: string | null;
  departedOn: string | null;
}

/** Whether a specific decision was overruled/modified by a higher court, or is a dissent. */
export interface DecisionSupersession {
  /** 'overruled' | 'dissent' | null (null = no mark = good law / not covered). */
  status: string | null;
  /** The higher-court decision that reversed/modified it; null if none. */
  supersededBy: { docId: string; disposition: string | null; on: string | null } | null;
}

/** A case cited by a decision (precedent outbound). */
export interface CitedCaseRef {
  causeNum: string;
  memberCount: number;
  latestDocId: string | null;
}

export interface CitationGraphNode {
  id: string;
  type: 'decision' | 'article' | 'law';
  label: string;
}

export interface CitationGraphEdge {
  from: string;
  to: string;
  type: 'CITES_ARTICLE' | 'OF_LAW';
  weight?: number;
}

export interface CitationGraphResult {
  root: { docId: string };
  nodes: CitationGraphNode[];
  edges: CitationGraphEdge[];
  truncated: boolean;
}

export interface CitationGraphHealth {
  ok: boolean;
  enabled: boolean;
  backend: 'postgres';
  error?: string;
  counts?: Record<string, number>;
}

/** Articles cited by fewer distinct decisions are noise (the Neo4j build's min_dec=5). */
export const MIN_ARTICLE_DECISIONS = 5;

/** Tables the service needs; all must exist for it to switch on. */
const REQUIRED_TABLES = [
  'decision_statute_citations',
  'statute_article_stats',
  'decision_supersession',
  'decision_instance_status',
  'case_position_departures',
  'case_citation_counts',
  'case_citation_links',
  'edrsr_case_index',
];

type Queryable = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> };

function toNum(v: any): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function iso(v: any): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

export class CitationGraphService {
  private db: Queryable | null;
  private readonly disabledByEnv: boolean;
  private ready: Promise<boolean> | null = null;
  /** Result of the table check: null until it has run. */
  private known: boolean | null = null;

  constructor(db?: Queryable | null) {
    this.db = db ?? null;
    this.disabledByEnv = (process.env.CITATION_BACKEND || '').toLowerCase() === 'off';
  }

  /** Point the service at the pool holding the EDRSR corpus (see edrsrPool in tool-utils). */
  setDatabase(db: Queryable | null | undefined): void {
    if (db && db !== this.db) {
      this.db = db;
      this.ready = null;
      this.known = null;
    }
  }

  /**
   * True when the graph can answer. Synchronous for the callers' guards: it reports the
   * last known state and starts the one-off table check; the first call before that check
   * completes answers true, and a query against a missing table then fails non-fatally in
   * the caller, after which isEnabled() turns false.
   */
  isEnabled(): boolean {
    if (this.disabledByEnv || !this.db) return false;
    if (this.known === false) return false;
    void this.ensureReady();
    return true;
  }

  private ensureReady(): Promise<boolean> {
    if (!this.ready) {
      this.ready = (async () => {
        try {
          const { rows } = await this.db!.query(
            `SELECT count(*)::int AS n FROM unnest($1::text[]) t WHERE to_regclass('public.' || t) IS NOT NULL`,
            [REQUIRED_TABLES],
          );
          this.known = Number(rows[0]?.n) === REQUIRED_TABLES.length;
          if (!this.known) logger.warn('[CitationGraphService] citation-graph tables missing; graph disabled');
        } catch (error: any) {
          logger.warn('[CitationGraphService] table check failed; graph disabled', { error: error?.message });
          this.known = false;
        }
        return this.known;
      })();
    }
    return this.ready;
  }

  private async q(sql: string, params: any[] = []): Promise<any[]> {
    if (!this.db) throw new Error('citation graph database is not configured');
    const { rows } = await this.db.query(sql, params);
    return rows;
  }

  /** Connectivity + table sizes (planner estimates, no scans). */
  async healthCheck(): Promise<CitationGraphHealth> {
    const base = { enabled: this.isEnabled(), backend: 'postgres' as const };
    try {
      const rows = await this.q(
        `SELECT c.relname, greatest(c.reltuples, 0)::bigint AS n
           FROM pg_class c WHERE c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[])`,
        [REQUIRED_TABLES],
      );
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.relname] = toNum(r.n);
      return { ...base, ok: (await this.ensureReady()) === true, counts };
    } catch (error: any) {
      logger.error('[CitationGraphService] healthCheck failed', { error: error?.message });
      return { ...base, ok: false, error: error?.message };
    }
  }

  /**
   * Articles cited by a given decision, most popular first (noise-filtered). The decision's
   * rows are fetched first (MATERIALIZED): a misestimate once made the planner start from
   * statute_article_stats instead, and get_court_decision timed out (migration 298).
   */
  async getDecisionCitations(docId: string | number, limit = 200): Promise<ArticleCitation[]> {
    const rows = await this.q(
      `WITH c AS MATERIALIZED (SELECT * FROM decision_statute_citations WHERE doc_id = $1::bigint)
       SELECT c.law_number AS law, c.law_article AS article, c.citation_type AS ct
         FROM c
         JOIN statute_article_stats s USING (law_number, law_article)
        WHERE s.unique_decisions >= $3
        ORDER BY s.total_citations DESC, c.law_number, c.law_article
        LIMIT $2`,
      [String(docId), limit, MIN_ARTICLE_DECISIONS],
    );
    return rows.map((r) => ({ law: r.law, article: r.article, citationType: r.ct, context: null }));
  }

  /** What a decision cites, with corpus-wide popularity, for get_court_decision. */
  async getDecisionCitationSummary(docId: string | number, limit = 20): Promise<DecisionCitationSummary> {
    const rows = await this.q(
      `WITH c AS MATERIALIZED (SELECT * FROM decision_statute_citations WHERE doc_id = $1::bigint)
       SELECT c.law_number AS law, c.law_article AS article, c.citation_type AS ct,
              s.total_citations AS pop, count(*) OVER () AS total
         FROM c
         JOIN statute_article_stats s USING (law_number, law_article)
        WHERE s.unique_decisions >= $3
        ORDER BY s.total_citations DESC, c.law_number, c.law_article
        LIMIT $2`,
      [String(docId), limit, MIN_ARTICLE_DECISIONS],
    );
    return {
      citedCount: rows[0] ? toNum(rows[0].total) : 0,
      topCitedArticles: rows.map((r) => ({ law: r.law, article: r.article, citationType: r.ct, popularity: toNum(r.pop) })),
    };
  }

  /** Decisions that cite a given article, plus the total count (from the stats row). */
  async getArticleCitedBy(law: string, article: string, limit = 100): Promise<{ count: number; decisions: string[] }> {
    const [stat, rows] = await Promise.all([
      this.getArticleStats(law, article),
      this.q(
        `SELECT doc_id::text AS doc_id FROM decision_statute_citations
          WHERE law_number = $1 AND law_article = $2 LIMIT $3`,
        [law, article, limit],
      ),
    ]);
    return { count: stat?.totalCitations ?? 0, decisions: rows.map((r) => r.doc_id) };
  }

  /** Precomputed citation stats for an article. */
  async getArticleStats(law: string, article: string): Promise<CitedArticleStat | null> {
    const rows = await this.q(
      `SELECT law_number, law_article, total_citations, unique_decisions
         FROM statute_article_stats WHERE law_number = $1 AND law_article = $2`,
      [law, article],
    );
    const r = rows[0];
    return r
      ? { law: r.law_number, article: r.law_article, totalCitations: toNum(r.total_citations), uniqueDecisions: toNum(r.unique_decisions) }
      : null;
  }

  /**
   * Precedent stats for a case. Accepts case-number variations and picks the most-cited
   * case among them; adds the latest Grand Chamber departure from its legal position.
   */
  async getCaseStats(causeNums: string[]): Promise<CaseStat | null> {
    if (!causeNums || causeNums.length === 0) return null;
    const rows = await this.q(
      `WITH c AS (
         SELECT i.cause_num, COALESCE(i.member_count, 0) AS member_count, i.latest_doc_id,
                COALESCE(n.citing_decisions, 0) AS citing
           FROM edrsr_case_index i
           LEFT JOIN case_citation_counts n ON n.cause_num = i.cause_num
          WHERE i.cause_num = ANY($1::text[])
          ORDER BY citing DESC, member_count DESC
          LIMIT 1
       )
       SELECT c.*, d.departing_doc_id::text AS dep_by, d.departed_on AS dep_on
         FROM c
         LEFT JOIN LATERAL (
           SELECT departing_doc_id, departed_on FROM case_position_departures
            WHERE departed_cause_num = c.cause_num
            ORDER BY departed_on DESC NULLS LAST LIMIT 1) d ON true`,
      [causeNums],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      causeNum: r.cause_num,
      citingDecisions: toNum(r.citing),
      memberCount: toNum(r.member_count),
      latestDocId: r.latest_doc_id != null ? String(r.latest_doc_id) : null,
      departedByDecision: r.dep_by ?? null,
      departedOn: iso(r.dep_on),
    };
  }

  /**
   * Whether a specific decision was overruled/modified by a higher court, or is a dissent.
   * {status: null, supersededBy: null} when it carries no mark.
   */
  async getDecisionSupersession(docId: string | number): Promise<DecisionSupersession | null> {
    const rows = await this.q(
      `SELECT (SELECT status FROM decision_instance_status WHERE doc_id = $1::bigint) AS status,
              s.superseded_by_doc_id::text AS by_doc, s.disposition, s.reversed_date
         FROM (SELECT 1) one
         LEFT JOIN LATERAL (
           SELECT superseded_by_doc_id, disposition, reversed_date FROM decision_supersession
            WHERE doc_id = $1::bigint ORDER BY reversed_date DESC NULLS LAST LIMIT 1) s ON true`,
      [String(docId)],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      status: r.status ?? null,
      supersededBy: r.by_doc
        ? { docId: r.by_doc, disposition: r.disposition ?? null, on: iso(r.reversed_date) }
        : null,
    };
  }

  /**
   * The decision of a case to draw the article graph for, when the caller gave a case
   * number: the member with the most article citations, newest doc_id on a tie (a case's
   * newest document is often an ухвала that cites nothing). Null when the case is unknown.
   */
  async resolveCaseDocId(causeNum: string): Promise<string | null> {
    const rows = await this.q(
      `SELECT d.doc_id::text AS doc_id,
              (SELECT count(*) FROM decision_statute_citations c WHERE c.doc_id = d.doc_id) AS edges
         FROM edrsr_documents d
        WHERE d.cause_num = $1
        ORDER BY edges DESC, d.doc_id DESC
        LIMIT 1`,
      [causeNum],
    );
    return rows[0]?.doc_id ?? null;
  }

  /** Decisions that cite a given case (newest first). */
  async getCaseCitedBy(causeNum: string, limit = 100): Promise<string[]> {
    const rows = await this.q(
      `SELECT from_doc_id::text AS doc_id FROM case_citation_links
        WHERE to_case_number = $1 AND resolved AND NOT is_self_citation
        ORDER BY from_doc_id DESC LIMIT $2`,
      [causeNum, limit],
    );
    return rows.map((r) => r.doc_id);
  }

  /** Cases that a given decision cites. */
  async getDecisionCitedCases(docId: string | number, limit = 100): Promise<CitedCaseRef[]> {
    const rows = await this.q(
      `SELECT DISTINCT ON (l.to_case_number) l.to_case_number AS cause_num,
              COALESCE(i.member_count, 0) AS member_count, i.latest_doc_id::text AS latest
         FROM case_citation_links l
         LEFT JOIN edrsr_case_index i ON i.cause_num = l.to_case_number
        WHERE l.from_doc_id = $1::bigint AND l.resolved AND NOT l.is_self_citation
        ORDER BY l.to_case_number LIMIT $2`,
      [String(docId), limit],
    );
    return rows.map((r) => ({ causeNum: r.cause_num, memberCount: toNum(r.member_count), latestDocId: r.latest ?? null }));
  }

  /**
   * Bounded decision -> article -> law neighbourhood for visualisation. `depth` is accepted
   * for compatibility: the co-citation layer it used to add was never loaded.
   */
  async getCitationGraph(docId: string | number, _depth = 1, articleLimit = 50): Promise<CitationGraphResult> {
    const id = String(docId);
    const nodes = new Map<string, CitationGraphNode>();
    const edges: CitationGraphEdge[] = [];
    const decisionKey = `decision:${id}`;
    nodes.set(decisionKey, { id: decisionKey, type: 'decision', label: id });

    const cited = await this.getDecisionCitations(id, articleLimit);
    for (const a of cited) {
      const artKey = `article:${a.law}|${a.article}`;
      const lawKey = `law:${a.law}`;
      if (!nodes.has(artKey)) nodes.set(artKey, { id: artKey, type: 'article', label: `${a.law} ст.${a.article}` });
      if (!nodes.has(lawKey)) nodes.set(lawKey, { id: lawKey, type: 'law', label: a.law });
      edges.push({ from: decisionKey, to: artKey, type: 'CITES_ARTICLE' });
      edges.push({ from: artKey, to: lawKey, type: 'OF_LAW' });
    }
    return { root: { docId: id }, nodes: Array.from(nodes.values()), edges, truncated: cited.length >= articleLimit };
  }

  async close(): Promise<void> {
    /* the pool belongs to the caller */
  }
}
