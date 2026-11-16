/**
 * PlCitationTools: Polish case law by the act and article it applies (LEXAI-2241).
 *
 * Reads pl_decision_citations (migration 272, built by scripts/pl/build_decision_citations.py
 * from the legal bases hf-pl-nsa, hf-pl-court-raw and SAOS already carry). act_eli is the base
 * act: a citation of a consolidated text (obwieszczenie) is folded onto it, so a query on the
 * Kodeks cywilny also finds decisions citing DU/2024/1061. The table copies each decision's date
 * and court type, so the counts never touch the 105 GB pl_court_decisions table; only the page
 * of newest decisions is joined back for case number and court name.
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';
import { COURT_TYPES, caseNumberSql, courtNameSql } from './pl-legal-tools.js';
import { isTimeout, isoDate, normalizeArticle, pageOf, runQuery } from './pl-tool-utils.js';

/** Rows read per decision on the page: one decision cites an article in several editions. */
const ROWS_PER_DECISION = 5;

/** The source label of a court type folded into the COURT_TYPES key the tools accept. */
export function courtTypeKey(raw: string | null): string {
  if (!raw) return 'unknown';
  for (const [key, labels] of Object.entries(COURT_TYPES)) if (labels.includes(raw)) return key;
  return raw;
}

export function normalizeEli(value: unknown): string | null {
  const m = String(value ?? '').trim().match(/^(DU|MP)\/(\d{4})\/(\d+)$/i);
  return m ? `${m[1].toUpperCase()}/${m[2]}/${Number(m[3])}` : null;
}

export class PlCitationTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'pl_find_decisions_by_article',
        annotations: { title: 'Практика Польщі за статтею акта', readOnlyHint: true },
        description: `Судова практика Польщі, що застосовує конкретний акт або його статтю: скільки рішень за видом суду і роками та найновіші рішення з цитатою правової підстави.

Джерело: правові підстави, які публікують самі суди (NSA/WSA, суди загальної юрисдикції, Верховний суд, TK, KIO у SAOS). Рішення без структурованих підстав (ncourt, CBOSA, KIO, OTK ZU) не враховані, тож це нижня межа, а не повна кількість.

eli: ELI основного акта (DU/1964/93 = Kodeks cywilny); посилання на консолідовані тексти цього акта враховуються. ELI консолідованого тексту теж приймається. article: "415", "art. 415", "22^1", "22¹"; без нього рахуються всі посилання на акт. court_type: common, supreme, administrative, constitutional, appeal_chamber. Далі: pl_get_court_decision (за id), pl_get_act_article.`,
        inputSchema: {
          type: 'object',
          properties: {
            eli: { type: 'string', description: 'ELI акта, напр. DU/1964/93 (Kodeks cywilny)' },
            article: { type: 'string', description: 'Номер статті; без нього весь акт' },
            court_type: { type: 'string', enum: Object.keys(COURT_TYPES), description: 'Вид суду' },
            date_from: { type: 'string', description: 'Від (YYYY-MM-DD)' },
            date_to: { type: 'string', description: 'До (YYYY-MM-DD, включно)' },
            limit: { type: 'number', default: 20, maximum: 50, description: 'Макс. рішень у списку' },
            offset: { type: 'number', default: 0, maximum: 1000, description: 'Зсув для пагінації' },
          },
          required: ['eli'],
        },
      },
    ];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    if (name !== 'pl_find_decisions_by_article') return null;
    try {
      return await this.findByArticle(args || {});
    } catch (err) {
      if (isTimeout(err)) {
        return this.wrapError('Запит виконувався задовго. Звузьте його: вкажіть article, court_type або період.');
      }
      logger.error('[PlCitationTools] query failed', { tool: name, error: (err as Error).message });
      return this.wrapError(`Не вдалося виконати запит: ${(err as Error).message}`);
    }
  }

  private async findByArticle(args: Record<string, unknown>): Promise<ToolResult> {
    const eli = normalizeEli(args.eli);
    if (!eli) return this.wrapError('eli має бути у форматі DU/1964/93 або MP/2020/12.');
    const article = args.article === undefined || args.article === '' ? null : normalizeArticle(String(args.article));
    if (args.article !== undefined && args.article !== '' && !article) return this.wrapError('Некоректний article.');

    const params: unknown[] = [];
    const where: string[] = [];
    const add = (sql: (n: number) => string, value: unknown) => {
      params.push(value);
      where.push(sql(params.length));
    };

    const acts = await runQuery(this.db,
      `SELECT eli, title, in_force, is_consolidation, consolidates_eli FROM pl_acts WHERE eli = $1`, [eli]);
    let act: any = acts[0] ?? null;
    let resolvedFrom: string | undefined;
    if (act?.is_consolidation && act.consolidates_eli) {
      const base = await runQuery(this.db,
        `SELECT eli, title, in_force, is_consolidation, consolidates_eli FROM pl_acts WHERE eli = $1`,
        [act.consolidates_eli]);
      resolvedFrom = eli;
      act = base[0] ?? { eli: act.consolidates_eli };
    }
    const baseEli: string = act?.eli ?? eli;

    add((n) => `act_eli = $${n}`, baseEli);
    if (article) add((n) => `art_no = $${n}`, article);
    if (args.court_type) {
      const types = COURT_TYPES[String(args.court_type)];
      if (!types) return this.wrapError(`court_type має бути одним з: ${Object.keys(COURT_TYPES).join(', ')}.`);
      add((n) => `court_type = ANY($${n}::text[])`, types);
    }
    for (const [arg, op] of [['date_from', '>='], ['date_to', '<=']] as const) {
      if (args[arg] === undefined || args[arg] === '') continue;
      const d = isoDate(args[arg]);
      if (!d) return this.wrapError('Дати мають бути у форматі YYYY-MM-DD.');
      add((n) => `decision_date ${op} $${n}::date`, d);
    }
    const page = pageOf(args);
    const cond = where.join(' AND ');

    // A decision has one date and one court type, so the group counts add up to the total.
    const counts = await runQuery(this.db,
      `SELECT court_type, extract(year FROM decision_date)::int AS year, count(DISTINCT decision_id)::int AS n
       FROM pl_decision_citations WHERE ${cond} GROUP BY 1, 2`, params);

    const scan = (page.offset + page.limit + 1) * ROWS_PER_DECISION;
    const rows = await runQuery(this.db,
      `WITH hits AS MATERIALIZED (
         SELECT decision_id, decision_date, cited_eli, art_no, raw FROM pl_decision_citations
         WHERE ${cond} ORDER BY decision_date DESC NULLS LAST, decision_id LIMIT ${scan}
       ), page AS MATERIALIZED (
         SELECT decision_id, max(decision_date) AS decision_date,
                jsonb_agg(DISTINCT jsonb_build_object('cited_eli', cited_eli, 'art_no', art_no, 'raw', raw)) AS citations
         FROM hits GROUP BY decision_id
         ORDER BY max(decision_date) DESC NULLS LAST, decision_id
         LIMIT ${page.limit + 1} OFFSET ${page.offset}
       )
       SELECT d.id, ${caseNumberSql('d.')} AS case_number, ${courtNameSql('d.')} AS court_name, d.court_type,
              d.decision_type, d.decision_date::text AS decision_date, p.citations
       FROM page p JOIN pl_court_decisions d ON d.id = p.decision_id
       ORDER BY p.decision_date DESC NULLS LAST, p.decision_id`, params);

    const byCourt = new Map<string, number>();
    const byYear = new Map<number | null, number>();
    let total = 0;
    for (const r of counts) {
      const n = Number(r.n);
      total += n;
      const key = courtTypeKey(r.court_type);
      byCourt.set(key, (byCourt.get(key) ?? 0) + n);
      const y = r.year === null || r.year === undefined ? null : Number(r.year);
      byYear.set(y, (byYear.get(y) ?? 0) + n);
    }

    return this.wrapResponse({
      act: act ? { eli: baseEli, title: act.title ?? null, in_force: act.in_force ?? null } : { eli, found_in_register: false },
      ...(resolvedFrom ? { resolved_from: resolvedFrom } : {}),
      article,
      total_decisions: total,
      by_court_type: [...byCourt].map(([court_type, decisions]) => ({ court_type, decisions }))
        .sort((a, b) => b.decisions - a.decisions),
      by_year: [...byYear].map(([year, decisions]) => ({ year, decisions }))
        .sort((a, b) => (b.year ?? -1) - (a.year ?? -1)),
      decisions: rows.slice(0, page.limit).map((r: any) => ({ ...r, court_type: courtTypeKey(r.court_type) })),
      has_more: rows.length > page.limit,
      limit: page.limit,
      offset: page.offset,
      note: 'Лише рішення, де суд сам навів правові підстави (NSA/WSA, SAOS). Інші джерела не враховані, тож це нижня межа.',
    });
  }
}
