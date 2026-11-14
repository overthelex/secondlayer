/**
 * Daily refresh of the Grand Chamber decisions behind /pozytsiia-vs:
 * registers new постанови (court 9951, judgment form 2) that have a full
 * text of at least MIN_TEXT characters, gives each a permanent slug, and
 * records which /zakon code articles it applies. Citation links are
 * extracted after publication, so recent decisions are re-checked weekly.
 */
import type { BaseDatabase } from '@secondlayer/shared';
import { logger } from '../../utils/logger.js';
import { ZAKON_CODES } from './zakon-codes.js';
import { slugify } from './translit.js';

const VP_COURT = 9951;
const MIN_TEXT = 3000;

export class VpRefresh {
  private running = false;
  constructor(private readonly db: BaseDatabase) {}

  async isEmpty(): Promise<boolean> {
    const r = await this.db.query('SELECT NOT EXISTS (SELECT 1 FROM seo_vp_decisions) AS empty');
    return r.rows[0].empty;
  }

  async run(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    const t0 = Date.now();
    try {
      const added = await this.addDecisions();
      const linked = await this.linkArticles();
      logger.info('[seo-vp] refresh done', { added, articleLinks: linked, ms: Date.now() - t0 });
      return true;
    } finally {
      this.running = false;
    }
  }

  private async addDecisions(): Promise<number> {
    const parts = await this.db.query(
      `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'edrsr_documents'::regclass AND c.relname ~ '^edrsr_documents_p_(201[89]|20[2-9][0-9])$'
        ORDER BY 1`,
    );
    const taken = new Set((await this.db.query('SELECT slug FROM seo_vp_decisions')).rows.map((x: { slug: string }) => x.slug));
    // After the first full load (≈7 min) only the last two years can gain decisions.
    const minYear = taken.size ? new Date().getFullYear() - 1 : 0;
    let added = 0;
    for (const { relname } of parts.rows as Array<{ relname: string }>) {
      if (Number(relname.slice(-4)) < minYear) continue;
      const r = await this.db.query(
        `SELECT d.doc_id, btrim(d.cause_num) AS cause_num,
                to_char((d.adjudication_date AT TIME ZONE 'Europe/Kyiv')::date, 'YYYY-MM-DD') AS adj_date,
                d.judge, d.category_code, f.adj_year, f.text_length
           FROM ${relname} d
           JOIN edrsr_fulltext f ON f.doc_id = d.doc_id
          WHERE d.court_code = $1 AND d.judgment_code = 2 AND d.cause_num IS NOT NULL
            AND d.adjudication_date IS NOT NULL AND f.text_length >= $2 AND f.adj_year IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM seo_vp_decisions v WHERE v.doc_id = d.doc_id)
          ORDER BY d.adjudication_date, d.doc_id`,
        [VP_COURT, MIN_TEXT],
      );
      for (const x of r.rows as Array<{ doc_id: string; cause_num: string; adj_date: string; judge: string | null; category_code: number | null; adj_year: number; text_length: number }>) {
        let slug = `${slugify(x.cause_num, 60) || 'sprava'}-${x.adj_date}`;
        if (taken.has(slug)) slug = `${slug}-${x.doc_id}`;
        const ins = await this.db.query(
          `INSERT INTO seo_vp_decisions (doc_id, slug, cause_num, adj_date, ft_year, judge, category_code, text_length)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
          [x.doc_id, slug, x.cause_num, x.adj_date, x.adj_year, x.judge, x.category_code, x.text_length],
        );
        if (ins.rowCount) { taken.add(slug); added++; }
      }
    }
    return added;
  }

  /** Links only to articles that exist in the current edition, so every link resolves. */
  private async linkArticles(): Promise<number> {
    const r = await this.db.query(
      `WITH todo AS (
         SELECT doc_id FROM seo_vp_decisions
          WHERE articles_checked_at IS NULL
             OR (adj_date > current_date - 180 AND articles_checked_at < now() - interval '7 days')
       ), ins AS (
         INSERT INTO seo_vp_articles (doc_id, nreg, art_no)
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
         UPDATE seo_vp_decisions SET articles_checked_at = now() WHERE doc_id IN (SELECT doc_id FROM todo)
       )
       SELECT count(*)::int AS n FROM ins`,
      [ZAKON_CODES.map(c => c.nreg)],
    );
    return r.rows[0].n;
  }
}
