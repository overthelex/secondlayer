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
