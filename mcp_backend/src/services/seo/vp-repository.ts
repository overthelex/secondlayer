/** Read-only queries for /pozytsiia-vs (filled by VpRefresh). */
import type { BaseDatabase } from '@secondlayer/shared';

export interface VpListItem { slug: string; causeNum: string; date: string; category: string | null }

export interface VpDecision extends VpListItem {
  docId: string;
  judge: string | null;
  fullText: string;
}

export interface VpArticle { nreg: string; artNo: string }

const LIST_COLS = `v.slug, v.cause_num, to_char(v.adj_date, 'YYYY-MM-DD') AS d, cc.name AS category`;
const toItem = (x: { slug: string; cause_num: string; d: string; category: string | null }): VpListItem =>
  ({ slug: x.slug, causeNum: x.cause_num, date: x.d, category: x.category });

export class VpRepository {
  constructor(private readonly db: BaseDatabase) {}

  async bySlug(slug: string): Promise<VpDecision | null> {
    const r = await this.db.query(
      `SELECT ${LIST_COLS}, v.doc_id::text AS doc_id, v.judge,
              (SELECT f.full_text FROM edrsr_fulltext f WHERE f.doc_id = v.doc_id AND f.adj_year = v.ft_year) AS full_text
         FROM seo_vp_decisions v LEFT JOIN edrsr_cause_categories cc ON cc.category_code = v.category_code
        WHERE v.slug = $1`,
      [slug],
    );
    const x = r.rows[0];
    if (!x || !x.full_text) return null;
    return { ...toItem(x), docId: x.doc_id, judge: x.judge, fullText: x.full_text };
  }

  async articles(slug: string): Promise<VpArticle[]> {
    const r = await this.db.query(
      `SELECT a.nreg, a.art_no FROM seo_vp_articles a JOIN seo_vp_decisions v USING (doc_id)
        WHERE v.slug = $1 ORDER BY a.nreg, (substring(a.art_no from '^\\d+'))::int, a.art_no`,
      [slug],
    );
    return r.rows.map((x: { nreg: string; art_no: string }) => ({ nreg: x.nreg, artNo: x.art_no }));
  }

  async years(): Promise<Array<{ year: number; count: number }>> {
    const r = await this.db.query(
      `SELECT extract(year FROM adj_date)::int AS year, count(*)::int AS count FROM seo_vp_decisions GROUP BY 1 ORDER BY 1 DESC`,
    );
    return r.rows;
  }

  async byYear(year: number): Promise<VpListItem[]> {
    const r = await this.db.query(
      `SELECT ${LIST_COLS} FROM seo_vp_decisions v LEFT JOIN edrsr_cause_categories cc ON cc.category_code = v.category_code
        WHERE v.adj_date >= make_date($1, 1, 1) AND v.adj_date < make_date($1 + 1, 1, 1)
        ORDER BY v.adj_date DESC, v.cause_num`,
      [year],
    );
    return r.rows.map(toItem);
  }

  async latest(limit: number): Promise<VpListItem[]> {
    const r = await this.db.query(
      `SELECT ${LIST_COLS} FROM seo_vp_decisions v LEFT JOIN edrsr_cause_categories cc ON cc.category_code = v.category_code
        ORDER BY v.adj_date DESC, v.doc_id DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map(toItem);
  }

  /** Grand Chamber decisions applying one article, newest first, and their total. */
  async forArticle(nreg: string, artNo: string, limit: number): Promise<{ total: number; items: VpListItem[] }> {
    const r = await this.db.query(
      `SELECT ${LIST_COLS}, count(*) OVER () AS total
         FROM seo_vp_articles a JOIN seo_vp_decisions v USING (doc_id)
         LEFT JOIN edrsr_cause_categories cc ON cc.category_code = v.category_code
        WHERE a.nreg = $1 AND a.art_no = $2
        ORDER BY v.adj_date DESC LIMIT $3`,
      [nreg, artNo, limit],
    );
    return { total: r.rows.length ? Number(r.rows[0].total) : 0, items: r.rows.map(toItem) };
  }

  async sitemap(): Promise<Array<{ slug: string; lastmod: string }>> {
    const r = await this.db.query(`SELECT slug, to_char(adj_date, 'YYYY-MM-DD') AS lastmod FROM seo_vp_decisions ORDER BY adj_date DESC`);
    return r.rows;
  }
}
