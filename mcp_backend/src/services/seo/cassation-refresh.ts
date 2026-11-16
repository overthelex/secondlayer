/**
 * Weekly refresh of the cassation decisions behind /praktyka-vs.
 *
 * Selection: постанови (judgment_code 2) of the four cassation courts of the
 * Supreme Court (КГС 9911, КАС 9921, КЦС 9931, ККС 9941) with a full text of at
 * least MIN_TEXT characters, ranked by how many distinct ЄДРСР decisions cite
 * their case (case_citation_links, self-citations excluded). One page per case:
 * the longest text wins, so a separately published resolutive part never does.
 * Cases decided by the Grand Chamber are left to /pozytsiia-vs.
 *
 * The published set is capped (SEO_CASSATION_CAP, default 5000) and only grows:
 * a slug, once published, is a permanent URL. Each run refreshes the citation
 * counts of published pages, fills free slots with the best-ranked new ones,
 * and loads code articles and case-to-case links for pages not yet checked.
 *
 * Cost (measured on the local copy): the ranking reads one edrsr_documents
 * partition at a time, 6-40 s each (cold cache), ≈3-5 min for 2018 onwards.
 */
import type { BaseDatabase } from '@secondlayer/shared';
import { logger } from '../../utils/logger.js';
import { ZAKON_ACTS } from './zakon-codes.js';
import { slugify } from './translit.js';

export const CASSATION_COURTS = [9911, 9921, 9931, 9941];
const MIN_TEXT = 3000;
const DEFAULT_CAP = 5000;
const BATCH = 500;

export function cassationCap(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SEO_CASSATION_CAP);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_CAP;
}

export interface RankedDecision {
  doc_id: string;
  cause_num: string;
  court_code: number;
  adj_date: string;
  judge: string | null;
  category_code: number | null;
  ft_year: number;
  text_length: number;
  cited_by: number;
}

/** Best decision per case (longest text), most cited first, ties by newer date. */
export function mergeRanked(rows: RankedDecision[]): RankedDecision[] {
  const byCase = new Map<string, RankedDecision>();
  for (const r of rows) {
    const cur = byCase.get(r.cause_num);
    if (!cur || r.text_length > cur.text_length) byCase.set(r.cause_num, r);
  }
  return [...byCase.values()].sort((a, b) =>
    b.cited_by - a.cited_by || b.adj_date.localeCompare(a.adj_date) || a.doc_id.localeCompare(b.doc_id));
}

export class CassationRefresh {
  private running = false;
  constructor(private readonly db: BaseDatabase, private readonly cap = cassationCap()) {}

  async isEmpty(): Promise<boolean> {
    const r = await this.db.query('SELECT NOT EXISTS (SELECT 1 FROM seo_cassation_decisions) AS empty');
    return r.rows[0].empty;
  }

  async run(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    const t0 = Date.now();
    try {
      const ranked = await this.rank();
      const { added, updated } = await this.publish(ranked);
      const articles = await this.linkArticles();
      const links = await this.loadLinks();
      logger.info('[seo-cassation] refresh done', { ranked: ranked.length, added, updated, articleLinks: articles, caseLinks: links, cap: this.cap, ms: Date.now() - t0 });
      return true;
    } finally {
      this.running = false;
    }
  }

  /** Per year partition, the `cap` most cited cases with a cassation постанова; merged across years. */
  private async rank(): Promise<RankedDecision[]> {
    if (this.cap === 0) return [];
    const parts = await this.db.query(
      `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'edrsr_documents'::regclass AND c.relname ~ '^edrsr_documents_p_(201[89]|20[2-9][0-9])$'
        ORDER BY 1`,
    );
    const rows: RankedDecision[] = [];
    for (const { relname } of parts.rows as Array<{ relname: string }>) {
      const t = Date.now();
      // relname comes from pg_class and matches the pattern above, so it is safe to interpolate.
      const r = await this.db.query(
        `WITH c AS (
           SELECT d.doc_id, btrim(d.cause_num) AS cause_num, d.court_code, d.adjudication_date, d.judge, d.category_code
             FROM ${relname} d
            WHERE d.court_code = ANY($1::int[]) AND d.judgment_code = 2
              AND d.cause_num IS NOT NULL AND btrim(d.cause_num) <> '' AND d.adjudication_date IS NOT NULL
         ), r AS (
           SELECT x.cause_num, count(DISTINCT l.from_doc_id)::int AS n
             FROM (SELECT DISTINCT cause_num FROM c
                    WHERE NOT EXISTS (SELECT 1 FROM seo_vp_decisions v WHERE v.cause_num = c.cause_num)) x
             JOIN case_citation_links l ON l.to_case_number = x.cause_num AND NOT l.is_self_citation
            GROUP BY 1 ORDER BY 2 DESC LIMIT $2
         )
         SELECT c.doc_id::text, c.cause_num, c.court_code, c.judge, c.category_code, r.n AS cited_by,
                to_char((c.adjudication_date AT TIME ZONE 'Europe/Kyiv')::date, 'YYYY-MM-DD') AS adj_date,
                f.adj_year AS ft_year, f.text_length
           FROM r JOIN c USING (cause_num)
           JOIN edrsr_fulltext f ON f.doc_id = c.doc_id
          WHERE f.text_length >= $3 AND f.adj_year IS NOT NULL`,
        [CASSATION_COURTS, this.cap, MIN_TEXT],
      );
      rows.push(...r.rows);
      logger.info('[seo-cassation] ranked partition', { relname, rows: r.rows.length, ms: Date.now() - t });
    }
    return mergeRanked(rows);
  }

  private async publish(ranked: RankedDecision[]): Promise<{ added: number; updated: number }> {
    const cur = await this.db.query('SELECT doc_id::text AS doc_id, cause_num, slug FROM seo_cassation_decisions');
    const published = new Set(cur.rows.map((x: { doc_id: string }) => x.doc_id));
    const publishedCases = new Set(cur.rows.map((x: { cause_num: string }) => x.cause_num));
    const taken = new Set(cur.rows.map((x: { slug: string }) => x.slug));

    let updated = 0;
    const known = ranked.filter(r => published.has(r.doc_id));
    for (let i = 0; i < known.length; i += BATCH) {
      const b = known.slice(i, i + BATCH);
      const u = await this.db.query(
        `UPDATE seo_cassation_decisions s SET cited_by = x.n
           FROM unnest($1::bigint[], $2::int[]) AS x(doc_id, n)
          WHERE s.doc_id = x.doc_id AND s.cited_by <> x.n`,
        [b.map(r => r.doc_id), b.map(r => r.cited_by)],
      );
      updated += u.rowCount ?? 0;
    }

    let free = this.cap - published.size;
    let added = 0;
    for (const x of ranked) {
      if (free <= 0) break;
      if (published.has(x.doc_id) || publishedCases.has(x.cause_num)) continue;
      let slug = `${slugify(x.cause_num, 60) || 'sprava'}-${x.adj_date}`;
      if (taken.has(slug)) slug = `${slug}-${x.doc_id}`;
      const ins = await this.db.query(
        `INSERT INTO seo_cassation_decisions (doc_id, slug, court_code, cause_num, adj_date, ft_year, judge, category_code, text_length, cited_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
        [x.doc_id, slug, x.court_code, x.cause_num, x.adj_date, x.ft_year, x.judge, x.category_code, x.text_length, x.cited_by],
      );
      if (ins.rowCount) { taken.add(slug); publishedCases.add(x.cause_num); added++; free--; }
    }
    return { added, updated };
  }

  /** Links only to articles that exist in the current edition, so every link resolves (as in VpRefresh). */
  private async linkArticles(): Promise<number> {
    let total = 0;
    for (;;) {
      const r = await this.db.query(
        `WITH todo AS (
           SELECT doc_id FROM seo_cassation_decisions
            WHERE articles_checked_at IS NULL
               OR (adj_date > current_date - 180 AND articles_checked_at < now() - interval '7 days')
            ORDER BY doc_id LIMIT $2
         ), ins AS (
           INSERT INTO seo_cassation_articles (doc_id, nreg, art_no)
           SELECT DISTINCT l.doc_id, lg.rada_id, regexp_replace(l.article_number, '\\s+', '', 'g')
             FROM legislation_citation_links l
             JOIN public.legislation lg ON lg.id = l.legislation_id AND lg.rada_id = ANY($1::text[])
            WHERE l.doc_id IN (SELECT doc_id FROM todo) AND l.resolved
              AND EXISTS (
                SELECT 1 FROM npa.edition e JOIN npa.article a ON a.nreg = e.nreg AND a.ed_date = e.ed_date
                 WHERE e.nreg = lg.rada_id AND e.is_current AND a.art_no = regexp_replace(l.article_number, '\\s+', '', 'g'))
           ON CONFLICT DO NOTHING
           RETURNING 1
         ), upd AS (
           UPDATE seo_cassation_decisions SET articles_checked_at = now() WHERE doc_id IN (SELECT doc_id FROM todo)
           RETURNING 1
         )
         SELECT (SELECT count(*) FROM ins)::int AS n, (SELECT count(*) FROM upd)::int AS docs`,
        [ZAKON_ACTS.map(c => c.nreg), BATCH],
      );
      total += r.rows[0].n;
      if (r.rows[0].docs < BATCH) return total;
    }
  }

  /**
   * Outgoing case citations of published pages (cassation and Grand Chamber),
   * resolved to pages at read time. Citation edges are rebuilt rarely, so
   * recent decisions are re-checked weekly, like the articles.
   */
  private async loadLinks(): Promise<number> {
    let total = 0;
    for (const table of ['seo_cassation_decisions', 'seo_vp_decisions']) {
      for (;;) {
        const r = await this.db.query(
          `WITH todo AS (
             SELECT doc_id, cause_num FROM ${table}
              WHERE links_checked_at IS NULL
                 OR (adj_date > current_date - 180 AND links_checked_at < now() - interval '7 days')
              ORDER BY doc_id LIMIT $1
           ), ins AS (
             INSERT INTO seo_cassation_links (from_doc_id, to_cause)
             SELECT DISTINCT l.from_doc_id, l.to_case_number
               FROM case_citation_links l JOIN todo t ON t.doc_id = l.from_doc_id
              WHERE l.resolved AND NOT l.is_self_citation AND l.to_case_number <> t.cause_num
             ON CONFLICT DO NOTHING
             RETURNING 1
           ), upd AS (
             UPDATE ${table} SET links_checked_at = now() WHERE doc_id IN (SELECT doc_id FROM todo)
             RETURNING 1
           )
           SELECT (SELECT count(*) FROM ins)::int AS n, (SELECT count(*) FROM upd)::int AS docs`,
          [BATCH],
        );
        total += r.rows[0].n;
        if (r.rows[0].docs < BATCH) break;
      }
    }
    return total;
  }
}
