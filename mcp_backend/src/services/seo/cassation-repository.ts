/** Read-only queries for /praktyka-vs (filled by CassationRefresh). */
import type { BaseDatabase } from '@secondlayer/shared';
import type { VpArticle } from './vp-repository.js';

export interface CassationCourt { code: number; name: string; abbr: string }

/** The cassation courts of the Supreme Court, as named in ЄДРСР. */
export const CASSATION_COURT_INFO: CassationCourt[] = [
  { code: 9931, name: 'Касаційний цивільний суд', abbr: 'КЦС ВС' },
  { code: 9911, name: 'Касаційний господарський суд', abbr: 'КГС ВС' },
  { code: 9921, name: 'Касаційний адміністративний суд', abbr: 'КАС ВС' },
  { code: 9941, name: 'Касаційний кримінальний суд', abbr: 'ККС ВС' },
];
export const COURT_BY_CODE = new Map(CASSATION_COURT_INFO.map(c => [c.code, c]));

export interface CassationListItem {
  slug: string;
  courtCode: number;
  causeNum: string;
  date: string;
  category: string | null;
  citedBy: number;
}

export interface CassationDecision extends CassationListItem {
  docId: string;
  judge: string | null;
  fullText: string;
  /** /sud/<slug> of the court, when the court page exists. */
  courtSlug: string | null;
}

/** A published page (cassation or Grand Chamber) linked from another one. */
export interface LinkedDecision {
  href: string;
  /** 'vp' for the Grand Chamber, else the cassation court's code. */
  court: 'vp' | number;
  causeNum: string;
  date: string;
}

const LIST_COLS = `s.slug, s.court_code, s.cause_num, to_char(s.adj_date, 'YYYY-MM-DD') AS d, cc.name AS category, s.cited_by`;
const FROM = `seo_cassation_decisions s LEFT JOIN edrsr_cause_categories cc ON cc.category_code = s.category_code`;
type Row = { slug: string; court_code: number; cause_num: string; d: string; category: string | null; cited_by: number };
const toItem = (x: Row): CassationListItem =>
  ({ slug: x.slug, courtCode: Number(x.court_code), causeNum: x.cause_num, date: x.d, category: x.category, citedBy: Number(x.cited_by) });

type LinkRow = { kind: 'vp' | 'cass'; slug: string; court_code: number | null; cause_num: string; d: string };
const toLink = (x: LinkRow): LinkedDecision => ({
  href: x.kind === 'vp' ? `/pozytsiia-vs/${x.slug}` : `/praktyka-vs/${x.slug}`,
  court: x.kind === 'vp' ? 'vp' : Number(x.court_code),
  causeNum: x.cause_num,
  date: x.d,
});

const MAX_LINKS = 40;

export class CassationRepository {
  constructor(private readonly db: BaseDatabase) {}

  async bySlug(slug: string): Promise<CassationDecision | null> {
    const r = await this.db.query(
      `SELECT ${LIST_COLS}, s.doc_id::text AS doc_id, s.judge, sc.slug AS court_slug,
              (SELECT f.full_text FROM edrsr_fulltext f WHERE f.doc_id = s.doc_id AND f.adj_year = s.ft_year) AS full_text
         FROM ${FROM} LEFT JOIN seo_courts sc ON sc.court_code = s.court_code
        WHERE s.slug = $1`,
      [slug],
    );
    const x = r.rows[0];
    if (!x || !x.full_text) return null;
    return { ...toItem(x), docId: x.doc_id, judge: x.judge, fullText: x.full_text, courtSlug: x.court_slug ?? null };
  }

  async articles(slug: string): Promise<VpArticle[]> {
    const r = await this.db.query(
      `SELECT a.nreg, a.art_no FROM seo_cassation_articles a JOIN seo_cassation_decisions s USING (doc_id)
        WHERE s.slug = $1 ORDER BY a.nreg, (substring(a.art_no from '^\\d+'))::int, a.art_no`,
      [slug],
    );
    return r.rows.map((x: { nreg: string; art_no: string }) => ({ nreg: x.nreg, artNo: x.art_no }));
  }

  /** Published pages whose case this decision cites. */
  async cites(docId: string): Promise<LinkedDecision[]> {
    const r = await this.db.query(
      `SELECT * FROM (
         SELECT 'cass' AS kind, s.slug, s.court_code, s.cause_num, to_char(s.adj_date, 'YYYY-MM-DD') AS d, s.cited_by AS w
           FROM seo_cassation_links l JOIN seo_cassation_decisions s ON s.cause_num = l.to_cause
          WHERE l.from_doc_id = $1 AND s.doc_id <> $1
         UNION ALL
         SELECT 'vp', v.slug, NULL, v.cause_num, to_char(v.adj_date, 'YYYY-MM-DD'), 1000000000
           FROM seo_cassation_links l JOIN seo_vp_decisions v ON v.cause_num = l.to_cause
          WHERE l.from_doc_id = $1 AND v.doc_id <> $1
       ) q ORDER BY w DESC, d DESC LIMIT $2`,
      [docId, MAX_LINKS],
    );
    return r.rows.map(toLink);
  }

  /** Published pages citing this case, newest first, and their total. */
  async citedBy(causeNum: string, docId: string): Promise<{ total: number; items: LinkedDecision[] }> {
    const r = await this.db.query(
      `SELECT *, count(*) OVER () AS total FROM (
         SELECT 'cass' AS kind, s.slug, s.court_code, s.cause_num, to_char(s.adj_date, 'YYYY-MM-DD') AS d
           FROM seo_cassation_links l JOIN seo_cassation_decisions s ON s.doc_id = l.from_doc_id
          WHERE l.to_cause = $1 AND s.doc_id <> $2
         UNION ALL
         SELECT 'vp', v.slug, NULL, v.cause_num, to_char(v.adj_date, 'YYYY-MM-DD')
           FROM seo_cassation_links l JOIN seo_vp_decisions v ON v.doc_id = l.from_doc_id
          WHERE l.to_cause = $1 AND v.doc_id <> $2
       ) q ORDER BY d DESC LIMIT $3`,
      [causeNum, docId, MAX_LINKS],
    );
    return { total: r.rows.length ? Number(r.rows[0].total) : 0, items: r.rows.map(toLink) };
  }

  async courts(): Promise<Array<{ courtCode: number; count: number }>> {
    const r = await this.db.query('SELECT court_code, count(*)::int AS count FROM seo_cassation_decisions GROUP BY 1');
    return r.rows.map((x: { court_code: number; count: number }) => ({ courtCode: Number(x.court_code), count: x.count }));
  }

  async years(): Promise<Array<{ year: number; count: number }>> {
    const r = await this.db.query(
      `SELECT extract(year FROM adj_date)::int AS year, count(*)::int AS count FROM seo_cassation_decisions GROUP BY 1 ORDER BY 1 DESC`,
    );
    return r.rows;
  }

  async byYear(year: number): Promise<CassationListItem[]> {
    const r = await this.db.query(
      `SELECT ${LIST_COLS} FROM ${FROM}
        WHERE s.adj_date >= make_date($1, 1, 1) AND s.adj_date < make_date($1 + 1, 1, 1)
        ORDER BY s.cited_by DESC, s.adj_date DESC, s.cause_num`,
      [year],
    );
    return r.rows.map(toItem);
  }

  /** The most cited pages of one court (or of all, when courtCode is null). */
  async topCited(courtCode: number | null, limit: number): Promise<CassationListItem[]> {
    const r = await this.db.query(
      `SELECT ${LIST_COLS} FROM ${FROM}
        WHERE ($1::int IS NULL OR s.court_code = $1)
        ORDER BY s.cited_by DESC, s.adj_date DESC LIMIT $2`,
      [courtCode, limit],
    );
    return r.rows.map(toItem);
  }

  async sitemap(): Promise<Array<{ slug: string; lastmod: string }>> {
    const r = await this.db.query(
      `SELECT slug, to_char(adj_date, 'YYYY-MM-DD') AS lastmod FROM seo_cassation_decisions ORDER BY cited_by DESC, adj_date DESC`,
    );
    return r.rows;
  }
}
