/**
 * UkJudgmentTools — full-text search over the UK judgments in `uk_court_decisions`
 * (54,453 Find Case Law records), ranked over the stored vectors in
 * `uk_court_decision_fts` (migration 221).
 *
 * Licensing: these records are covered by the Find Case Law transactional licence
 * (TNA ref CAS-349914-B9P5B8), not by the Open Government Licence that covers the
 * statute book. The per-user gate lives in services/uk-judgment-access.ts and is
 * applied by the transport before this handler runs — this file must never be the
 * only thing standing between a caller and the corpus.
 *
 * What the licence answers commit this tool to, and where each is kept:
 *   - an extract plus a link back to the authoritative record, never the whole
 *     judgment (principles 7 and 9) — `extract` + `source_url`, no full_text;
 *   - no searching or profiling by judge (principle 2) — there is deliberately no
 *     `judge` filter, and results are never grouped by decision-maker;
 *   - users told where the holding is incomplete at the point of search
 *     (principle 3) — `coverage` rides on every response, including empty ones,
 *     because a nil result is exactly where a lawyer would draw the wrong inference.
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';
import { datesToDays } from './uk-dates.js';
import { isValidIsoDate } from './ch-date-utils.js';

const ATTRIBUTION =
  'Contains information licensed under the Open Justice - Licence v2.0. Source: Find Case Law, The National Archives.';

const COVERAGE =
  'The corpus is incomplete: 54,453 judgments of about 95,800 on Find Case Law, loaded up to May 2026. ' +
  'The Court of Appeal (Criminal Division) and the King’s Bench Division are missing; the Administrative Court stops in April 2016; ' +
  'Scotland and Northern Ireland are not covered. No result does NOT mean no such judgment exists.';

const EXTRACT_NOTE_QUERY =
  'extract: verbatim passages of the judgment around the query matches (marked «»); the full text is at source_url.';
const EXTRACT_NOTE_OPENING =
  'extract: the first 400 characters of the judgment (no query, so there are no matches to mark); the full text is at source_url.';

// Delimiters for ts_headline. Plain text rather than <b>, since MCP clients render
// the payload as JSON, not HTML.
const HEADLINE_OPTS = 'StartSel=«,StopSel=»,MaxFragments=3,MaxWords=35,MinWords=12,FragmentDelimiter=" … "';

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

export class UkJudgmentTools extends BaseToolHandler {
  /** Every reply goes through here, so DATE columns leave as calendar days (see uk-dates.ts). */
  protected override wrapResponse(data: any): ToolResult {
    return super.wrapResponse(datesToDays(data));
  }

  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'uk_search_judgments',
        annotations: { title: 'Search UK judgments', readOnlyHint: true },
        description: `Full-text search of UK judgments from Find Case Law (The National Archives).

Corpus: 54,453 judgments, 2001–2026: Supreme Court, Privy Council, Court of Appeal (Civil Division), High Court (Chancery, Administrative, Commercial, Family, TCC and others), Family Court, Court of Protection, tribunals (UKFTT, UKUT, EAT).
⚠ ${COVERAGE}

query is in English with search-engine syntax: "exact phrase", OR, -exclusion. Results are ordered by relevance (sort='date' orders by date).
citation is a neutral citation, e.g. '[2021] UKSC 20' (query is optional then).
court is a court code: uksc, ukpc, ewca/civ, ewhc/ch, ewhc/admin, ewhc/comm, ewhc/fam, ewhc/tcc, ewfc, ewcop, eat, ukftt/tc, ukftt/grc, ukut/iac, ukut/lc, etc.
Each result: neutral citation, parties, court, date, a verbatim extract (with query, passages around the matches; without, the start of the judgment) and a link to the full text on caselaw.nationalarchives.gov.uk. The tool does not return full judgment text.
Access is limited to verified lawyers and researchers (a condition of the TNA licence).`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "Search query in English, e.g. 'unfair prejudice petition quasi-partnership'" },
            citation: { type: 'string', description: "Neutral citation or part of one, e.g. '[2021] UKSC 20'" },
            court: { type: 'string', description: "Court code, e.g. 'uksc', 'ewca/civ', 'ewhc/ch'" },
            parties: { type: 'string', description: 'Part of the case name or parties' },
            date_from: { type: 'string', description: 'Judgment date from (YYYY-MM-DD)' },
            date_to: { type: 'string', description: 'Judgment date to (YYYY-MM-DD)' },
            sort: { type: 'string', enum: ['relevance', 'date'], default: 'relevance', description: 'Order: relevance (default when query is given) or date (newest first)' },
            limit: { type: 'number', default: 10, maximum: 20, description: 'Maximum results' },
            offset: { type: 'number', default: 0, description: 'Pagination offset' },
          },
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    switch (name) {
      case 'uk_search_judgments': return this.searchJudgments(args);
      default: return null;
    }
  }

  private async searchJudgments(args: Record<string, unknown>): Promise<ToolResult> {
    const a = args as any;
    const query = typeof a.query === 'string' ? a.query.trim() : '';
    const citation = typeof a.citation === 'string' ? a.citation.trim() : '';
    const court = typeof a.court === 'string' ? a.court.trim().toLowerCase() : '';
    const parties = typeof a.parties === 'string' ? a.parties.trim() : '';
    // Integers only: both are interpolated into LIMIT/OFFSET, which reject 2.5.
    const limit = Math.min(Math.max(Math.floor(Number(a.limit)) || 10, 1), 20);
    const offset = Math.max(Math.floor(Number(a.offset)) || 0, 0);

    if (!query && !citation && !parties) {
      return this.wrapResponse({
        error: 'missing_query',
        message: 'Provide query (text search), citation (neutral citation) or parties.',
        coverage: COVERAGE,
      });
    }
    for (const k of ['date_from', 'date_to']) {
      if (a[k] !== undefined && a[k] !== null && a[k] !== '' && !isValidIsoDate(String(a[k]))) {
        return this.wrapResponse({ error: 'bad_date', message: `${k} must be a real date in YYYY-MM-DD format.` });
      }
    }

    const values: any[] = [];
    // Placeholders and empty rows the 28.09 audit found (migration 222): kept in the
    // holding, never served.
    const where: string[] = ['NOT EXISTS (SELECT 1 FROM uk_court_decision_hidden h WHERE h.id = d.id)'];
    const push = (v: any) => { values.push(v); return `$${values.length}`; };

    // One parameter for the query text, shared by the match, the rank and the
    // headline. Pushed only when present: an unused $n has no inferable type and
    // Postgres rejects the whole statement.
    const qParam = query ? push(query) : '';
    if (query) where.push(`f.fts @@ websearch_to_tsquery('english', ${qParam})`);
    if (citation) where.push(`d.neutral_citation ILIKE ${push('%' + escapeLike(citation) + '%')}`);
    if (court) where.push(`d.court_code = ${push(court)}`);
    if (parties) where.push(`d.parties ILIKE ${push('%' + escapeLike(parties) + '%')}`);
    if (a.date_from) where.push(`d.decision_date >= ${push(String(a.date_from))}::date`);
    if (a.date_to) where.push(`d.decision_date <= ${push(String(a.date_to))}::date`);

    const byRelevance = !!query && a.sort !== 'date';
    const rankExpr = byRelevance
      ? `ts_rank_cd(f.fts, websearch_to_tsquery('english', ${qParam}))`
      : 'NULL::real';

    // Rank and page over the narrow side table first, then fetch full_text for the
    // page alone: ts_headline over 20 judgments is ~0.3 s, over every hit it would
    // be the 20-second query migration 221 exists to avoid.
    const sql = `
      WITH page AS (
        SELECT COUNT(*) OVER() AS _total_count, d.id, ${rankExpr} AS rank, d.decision_date
          FROM uk_court_decisions d
          ${query ? 'JOIN uk_court_decision_fts f ON f.id = d.id' : ''}
         WHERE ${where.join(' AND ')}
         ORDER BY rank DESC NULLS LAST, d.decision_date DESC NULLS LAST, d.id
         LIMIT ${limit} OFFSET ${offset}
      )
      SELECT p._total_count, d.neutral_citation, d.parties AS case_name, d.court_code,
             d.court_name, d.decision_date::text AS decision_date, d.case_number, d.source_url,
             ${query
               ? `ts_headline('english', COALESCE(d.full_text, ''), websearch_to_tsquery('english', ${qParam}), '${HEADLINE_OPTS}')`
               : `left(COALESCE(d.full_text, ''), 400)`} AS extract
        FROM page p JOIN uk_court_decisions d ON d.id = p.id
       ORDER BY p.rank DESC NULLS LAST, p.decision_date DESC NULLS LAST, p.id`;

    try {
      const [rows, unindexed] = await Promise.all([
        this.db.query(sql, values).then((r: any) => r.rows),
        query ? this.unindexedCount() : Promise.resolve(0),
      ]);

      const extra: Record<string, unknown> = { coverage: COVERAGE };
      if (unindexed === null) {
        extra.index_incomplete =
          'Could not check that the text index is complete; query results may be incomplete.';
      } else if (unindexed > 0) {
        // Honest rather than silently partial: the backfill has not finished, so a
        // text query cannot see these judgments yet.
        extra.index_incomplete =
          `${unindexed} judgments are not yet indexed for text search; query results may be incomplete.`;
      }

      if (!rows.length) {
        // An empty page is not an empty result: past the last match the window
        // count has no row to ride on, so count the matches on their own.
        const total = offset > 0
          ? Number((await this.db.query(
              `SELECT count(*) AS n FROM uk_court_decisions d
                 ${query ? 'JOIN uk_court_decision_fts f ON f.id = d.id' : ''}
                WHERE ${where.join(' AND ')}`, values)).rows[0]?.n) || 0
          : 0;
        return this.wrapResponse({
          results: [], total_count: total, has_more: false, limit, offset, ...extra,
          note: total > 0
            ? `Offset ${offset} is past the end of the results: ${total} matches in total.`
            : 'Nothing found. Try a broader query, another court or another period.',
        });
      }
      const result = this.wrapSearchResults(rows, limit, offset, ATTRIBUTION);
      const body = JSON.parse(result.content[0].text as string);
      return this.wrapResponse({
        ...body, ...extra, extract_note: query ? EXTRACT_NOTE_QUERY : EXTRACT_NOTE_OPENING,
      });
    } catch (err: any) {
      logger.error('[uk_search_judgments] failed', { error: err?.message });
      return this.wrapResponse({ error: 'query_failed', message: 'The UK judgments search failed.' });
    }
  }

  /** Judgments with no stored vector yet, or null when that cannot be told.
   *  Both counts are index-only scans on 54K rows. */
  private async unindexedCount(): Promise<number | null> {
    try {
      const r = await this.db.query(
        `SELECT (SELECT count(*) FROM uk_court_decisions) - (SELECT count(*) FROM uk_court_decision_fts) AS n`
      );
      return Math.max(Number(r.rows[0]?.n) || 0, 0);
    } catch (err: any) {
      logger.warn('[uk_search_judgments] index completeness check failed', { error: err?.message });
      return null;
    }
  }
}
