/**
 * Read-only access to npa.* for the public /zakon pages. Never fetches from
 * zakon.rada.gov.ua: a crawler requesting unknown URLs must not trigger
 * network work (unlike LegislationService.ensureLegislationExists).
 */
import type { BaseDatabase } from '@secondlayer/shared';
import { parseStructure, normArtNo, type CodeStructure } from './zakon-text.js';

export interface EditionInfo {
  edDate: string; // YYYY-MM-DD
  statusCode: number | null;
}

export interface ArticleIndexEntry {
  artNo: string;
  /** Heading line after "Стаття N." (for the Constitution: start of the text). */
  head: string;
}

export interface ArticleVersion {
  /** Date of the first edition with this text (YYYY-MM-DD). */
  from: string;
  /** Null for older versions the page lists by date only. */
  body: string | null;
}

export interface CodeData {
  edition: EditionInfo;
  index: ArticleIndexEntry[];
  structure: CodeStructure;
}

const ARTICLE_HEAD = /^Стаття\s+\d+(?:\s*-\s*\d+)?\s*\.\s*/;

export class ZakonRepository {
  constructor(private readonly db: BaseDatabase) {}

  async currentEdition(nreg: string): Promise<EditionInfo | null> {
    const r = await this.db.query(
      `SELECT to_char(e.ed_date, 'YYYY-MM-DD') AS ed_date, a.status_code
         FROM npa.act a
         JOIN npa.edition e ON e.nreg = a.nreg AND e.is_current AND e.http_status = 200
        WHERE a.nreg = $1
        ORDER BY e.ed_date DESC
        LIMIT 1`,
      [nreg],
    );
    const row = r.rows[0];
    return row ? { edDate: row.ed_date, statusCode: row.status_code } : null;
  }

  async articleIndex(nreg: string, edDate: string): Promise<ArticleIndexEntry[]> {
    const r = await this.db.query(
      `SELECT art_no, split_part(body, E'\\n', 1) AS first_line
         FROM npa.article
        WHERE nreg = $1 AND ed_date = $2
        ORDER BY art_ord`,
      [nreg, edDate],
    );
    return r.rows.map((row: { art_no: string; first_line: string }) => ({
      artNo: normArtNo(row.art_no),
      head: row.first_line.replace(ARTICLE_HEAD, '').trim(),
    }));
  }

  async articleBody(nreg: string, edDate: string, artNo: string): Promise<string | null> {
    const r = await this.db.query(
      `SELECT body FROM npa.article WHERE nreg = $1 AND ed_date = $2 AND art_no = $3`,
      [nreg, edDate, artNo],
    );
    return r.rows[0]?.body ?? null;
  }

  /**
   * Every version of one article: the first edition carrying each new text, oldest
   * first. Whitespace is ignored (scrapes of the same text differ in spacing), and a
   * text that returns after a change counts as a new version. Includes editions
   * dated after `currentEd`: amendments not yet in force. Bodies come only for the
   * versions a page shows in full (the `keep` newest up to `currentEd`, and the
   * future ones); some ПКУ articles have 80+ versions and 14 MB of text.
   */
  async articleVersions(nreg: string, artNo: string, currentEd: string, keep = 6): Promise<ArticleVersion[]> {
    const r = await this.db.query(
      `WITH x AS (
         SELECT a.ed_date, a.body, md5(regexp_replace(a.body, '\s+', ' ', 'g')) AS h
           FROM npa.article a
           JOIN npa.edition e ON e.nreg = a.nreg AND e.ed_date = a.ed_date AND e.http_status = 200 AND NOT e.date_suspect
          WHERE a.nreg = $1 AND a.art_no = $2),
       r AS (SELECT ed_date, body, h IS DISTINCT FROM lag(h) OVER (ORDER BY ed_date) AS starts FROM x),
       v AS (SELECT ed_date, body,
                    CASE WHEN ed_date <= $3::date THEN row_number() OVER (PARTITION BY ed_date <= $3::date ORDER BY ed_date DESC) END AS back
               FROM r WHERE starts)
       SELECT to_char(ed_date, 'YYYY-MM-DD') AS ed_date, CASE WHEN (back IS NULL OR back <= $4) AND length(body) <= 150000 THEN body END AS body
         FROM v ORDER BY ed_date`,
      [nreg, artNo, currentEd, keep],
    );
    return r.rows.map((x: { ed_date: string; body: string | null }) => ({ from: x.ed_date, body: x.body }));
  }

  async structure(nreg: string, edDate: string): Promise<CodeStructure> {
    const r = await this.db.query(
      `SELECT body FROM npa.edition_text WHERE nreg = $1 AND ed_date = $2`,
      [nreg, edDate],
    );
    return parseStructure(r.rows[0]?.body ?? '');
  }
}

/**
 * Per-process memo of the per-code data (13 codes; the parsed structure of
 * the largest, ПКУ, comes from a ~7 MB text, so it is parsed at most once
 * per edition). The current edition date is re-checked every `ttlMs`.
 */
export class ZakonDataCache {
  private readonly entries = new Map<string, { at: number; data: CodeData }>();

  constructor(private readonly repo: ZakonRepository, private readonly ttlMs = 60 * 60 * 1000) {}

  async get(nreg: string): Promise<CodeData | null> {
    const hit = this.entries.get(nreg);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.data;

    const edition = await this.repo.currentEdition(nreg);
    if (!edition) return null;
    if (hit && hit.data.edition.edDate === edition.edDate) {
      hit.at = Date.now();
      hit.data.edition = edition;
      return hit.data;
    }
    const [index, structure] = await Promise.all([
      this.repo.articleIndex(nreg, edition.edDate),
      this.repo.structure(nreg, edition.edDate),
    ]);
    const data = { edition, index, structure };
    this.entries.set(nreg, { at: Date.now(), data });
    return data;
  }
}
