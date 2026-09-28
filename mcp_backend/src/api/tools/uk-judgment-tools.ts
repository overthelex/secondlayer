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
import { isValidIsoDate } from './ch-date-utils.js';

const ATTRIBUTION =
  'Contains information licensed under the Open Justice - Licence v2.0. Source: Find Case Law, The National Archives.';

const COVERAGE =
  'Корпус неповний: 54,453 рішення з приблизно 95,800 на Find Case Law, завантажені до травня 2026. ' +
  'Немає Court of Appeal (Criminal Division) і King’s Bench Division; Administrative Court обривається у квітні 2016; ' +
  'немає Шотландії та Північної Ірландії. Відсутність результату НЕ означає, що такого рішення не існує.';

const EXTRACT_NOTE_QUERY =
  'extract — дослівні уривки з тексту рішення навколо збігів із query (виділені «»); повний текст — за посиланням source_url.';
const EXTRACT_NOTE_OPENING =
  'extract — перші 400 символів тексту рішення (запит без query, тож збігів для виділення немає); повний текст — за посиланням source_url.';

// Delimiters for ts_headline. Plain text rather than <b>, since MCP clients render
// the payload as JSON, not HTML.
const HEADLINE_OPTS = 'StartSel=«,StopSel=»,MaxFragments=3,MaxWords=35,MinWords=12,FragmentDelimiter=" … "';

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

export class UkJudgmentTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'uk_search_judgments',
        annotations: { title: 'Пошук судових рішень Великої Британії', readOnlyHint: true },
        description: `Повнотекстовий пошук у судових рішеннях Великої Британії з Find Case Law (The National Archives).

Корпус: 54,453 рішення 2001–2026: Supreme Court, Privy Council, Court of Appeal (Civil Division), High Court (Chancery, Administrative, Commercial, Family, TCC та ін.), Family Court, Court of Protection, трибунали (UKFTT, UKUT, EAT).
⚠ ${COVERAGE}

query — англійською, синтаксис як у пошуковику: "точна фраза", OR, -виключення. Результати впорядковані за релевантністю (sort='date' — за датою).
citation — нейтральне посилання, напр. '[2021] UKSC 20' (можна без query).
court — код суду: uksc, ukpc, ewca/civ, ewhc/ch, ewhc/admin, ewhc/comm, ewhc/fam, ewhc/tcc, ewfc, ewcop, eat, ukftt/tc, ukftt/grc, ukut/iac, ukut/lc тощо.
Кожен результат: нейтральне посилання, сторони, суд, дата, дослівний уривок (з query — фрагменти навколо збігів; без query — початок рішення) і посилання на повний текст на caselaw.nationalarchives.gov.uk. Повний текст рішення інструмент не віддає.
Доступ — лише для підтверджених юристів і дослідників (умова ліцензії TNA).`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "Пошуковий запит англійською, напр. 'unfair prejudice petition quasi-partnership'" },
            citation: { type: 'string', description: "Нейтральне посилання або його частина, напр. '[2021] UKSC 20'" },
            court: { type: 'string', description: "Код суду, напр. 'uksc', 'ewca/civ', 'ewhc/ch'" },
            parties: { type: 'string', description: 'Фрагмент назви справи / сторін' },
            date_from: { type: 'string', description: 'Дата рішення від (YYYY-MM-DD)' },
            date_to: { type: 'string', description: 'Дата рішення до (YYYY-MM-DD)' },
            sort: { type: 'string', enum: ['relevance', 'date'], default: 'relevance', description: 'Порядок: relevance (за замовчуванням, якщо є query) або date (новіші першими)' },
            limit: { type: 'number', default: 10, maximum: 20, description: 'Макс. результатів' },
            offset: { type: 'number', default: 0, description: 'Зсув для пагінації' },
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
        message: 'Вкажіть query (текстовий запит), citation (нейтральне посилання) або parties.',
        coverage: COVERAGE,
      });
    }
    for (const k of ['date_from', 'date_to']) {
      if (a[k] !== undefined && a[k] !== null && a[k] !== '' && !isValidIsoDate(String(a[k]))) {
        return this.wrapResponse({ error: 'bad_date', message: `${k} має бути реальною датою у форматі YYYY-MM-DD.` });
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
          'Не вдалося перевірити повноту текстового індексу — результати query можуть бути неповними.';
      } else if (unindexed > 0) {
        // Honest rather than silently partial: the backfill has not finished, so a
        // text query cannot see these judgments yet.
        extra.index_incomplete =
          `${unindexed} рішень ще не проіндексовано для текстового пошуку — результати query можуть бути неповними.`;
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
            ? `Зсув ${offset} за межами результатів: усього збігів ${total}.`
            : 'Нічого не знайдено. Спробуйте ширший запит, інший суд або період.',
        });
      }
      const result = this.wrapSearchResults(rows, limit, offset, ATTRIBUTION);
      const body = JSON.parse(result.content[0].text as string);
      return this.wrapResponse({
        ...body, ...extra, extract_note: query ? EXTRACT_NOTE_QUERY : EXTRACT_NOTE_OPENING,
      });
    } catch (err: any) {
      logger.error('[uk_search_judgments] failed', { error: err?.message });
      return this.wrapResponse({ error: 'query_failed', message: 'Пошук судових рішень Великої Британії не виконано.' });
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
