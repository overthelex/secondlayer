/**
 * PlLegalTools: Polish court decisions (pl_court_decisions) and legislation (pl_acts and
 * the snapshot tables, migrations 190-192).
 *
 * Poland has no point-in-time service. An act's history here is the chain of texts that were
 * actually published: the act as announced, then each consolidated text. Nothing is
 * interpolated between them, so a snapshot can be older than the law on the date asked about.
 * Two facts make that visible in every answer:
 *
 *  - `amendments_after` counts amendments that took effect after the snapshot.
 *  - The newest editions are often PDF-only. They carry no article rows (and verdict 906 means
 *    extracted text without article segmentation), so an article lookup can only be answered
 *    from an older edition. The response lists the newer editions it had to skip.
 *
 * A snapshot's text lives in one of two places: segmented HTML editions keep it in
 * pl_act_articles with pl_snapshot_texts.text NULL, everything else in pl_snapshot_texts.text.
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';
import {
  INFLECTED_SEARCH_NOTE, isTimeout, isoDate, normalizeArticle, pageOf, pageResponse, plainText, runQuery,
  runSearchQuery, sliceText, toTsQuery, wordForms,
} from './pl-tool-utils.js';

const DECISION_TEXT_CHARS = 40_000;
const ACT_TEXT_CHARS = 40_000;
const SNIPPET_CHARS = 400;
// Read before the HTML of a SAOS judgment is stripped, so the snippet still fills up.
const SNIPPET_RAW_CHARS = 3000;
const VERDICT_TEXT = [200, 906];

// The sources label the same kind of court differently.
const COURT_TYPES: Record<string, string[]> = {
  common: ['COMMON', 'ordinary_court'],
  supreme: ['SUPREME'],
  administrative: ['administrative court'],
  constitutional: ['CONSTITUTIONAL_TRIBUNAL'],
  appeal_chamber: ['NATIONAL_APPEAL_CHAMBER'],
};

const COURT_FTS = `to_tsvector('simple'::regconfig, ((((COALESCE(parties, ''::text) || ' '::text) || COALESCE(abstract, ''::text)) || ' '::text) || COALESCE(full_text, ''::text)))`;
const DECISION_COLS = `id, ecli, source, court_type, court_name, division, case_number, decision_type,
  decision_date::text AS decision_date, judge, keywords`;
const ACT_COLS = `eli, publisher, year, pos, display_address, act_type, title, status, in_force,
  announcement_date, entry_into_force, repeal_date, is_consolidation, consolidates_eli,
  amends_count, amended_by_count, snapshot_count, text_html, text_pdf`;

const PAGING = {
  limit: { type: 'number', default: 20, maximum: 50, description: 'Макс. результатів' },
  offset: { type: 'number', default: 0, maximum: 1000, description: 'Зсув для пагінації' },
};
const ELI_PROP = { type: 'string', description: 'ELI акта, напр. DU/1964/93 (Kodeks cywilny)' };
const AS_OF_PROP = { type: 'string', description: 'Дата редакції YYYY-MM-DD; типово найновіша' };

interface Snapshot {
  snapshot_eli: string;
  seq: number;
  snapshot_kind: string;
  exact_on: string | null;
  valid_to: string | null;
  amendments_after: number | null;
  http_status: number | null;
  article_count: number | null;
  n_chars: number | null;
  has_text: boolean;
}

/** Picks the newest edition on the date that satisfies `usable`, and reports what it skipped. */
export function pickSnapshot(rows: Snapshot[], asOf: string | null, usable: (s: Snapshot) => boolean) {
  const applicable = rows.filter((s) => !asOf || (s.exact_on !== null && s.exact_on <= asOf));
  const index = applicable.findIndex(usable);
  if (index < 0) return { applicable, chosen: null, skipped: applicable };
  return { applicable, chosen: applicable[index], skipped: applicable.slice(0, index) };
}

function snapshotWarnings(chosen: Snapshot, skipped: Snapshot[], what: string): string[] {
  const out: string[] = [];
  if (skipped.length) {
    out.push(`Є новіші редакції без ${what}: ${skipped.map((s) => `${s.snapshot_eli} (${s.exact_on})`).join(', ')}. `
      + 'Відповідь взято зі старішої редакції, тож норма могла змінитися.');
  }
  if (chosen.amendments_after) {
    out.push(`Після цієї редакції набрали чинності зміни: ${chosen.amendments_after}. Текст їх не враховує.`);
  }
  return out;
}

export class PlLegalTools extends BaseToolHandler {
  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'pl_search_court_decisions',
        annotations: { title: 'Пошук судових рішень Польщі', readOnlyHint: true },
        description: `Пошук у 2,5 млн рішень судів Польщі (суди загальної юрисдикції, Верховний суд, адміністративні суди, Конституційний трибунал, KIO), найновіші першими.

Потрібен query (повний текст) або case_number (точна сигнатура, напр. "II CSKP 123/22"). ${INFLECTED_SEARCH_NOTE}
court_type: common, supreme, administrative, constitutional, appeal_chamber (KIO). Далі: pl_get_court_decision.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Слова для пошуку в тексті' },
            case_number: { type: 'string', description: 'Сигнатура справи' },
            court_type: { type: 'string', enum: Object.keys(COURT_TYPES), description: 'Вид суду' },
            decision_type: { type: 'string', description: 'Тип рішення, напр. SENTENCE, DECISION, RESOLUTION, REASONS' },
            date_from: { type: 'string', description: 'Від (YYYY-MM-DD)' },
            date_to: { type: 'string', description: 'До (YYYY-MM-DD, включно)' },
            ...PAGING,
          },
        },
      },
      {
        name: 'pl_get_court_decision',
        annotations: { title: 'Судове рішення Польщі', readOnlyHint: true },
        description: `Рішення суду Польщі за id із pl_search_court_decisions: реквізити і повний текст. Текст віддається вікном до 40 000 символів; наступне вікно задає text_offset.`,
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'id рішення' },
            text_offset: { type: 'number', default: 0, description: 'Позиція початку тексту' },
          },
          required: ['id'],
        },
      },
      {
        name: 'pl_search_legislation',
        annotations: { title: 'Пошук актів Польщі (ELI)', readOnlyHint: true },
        description: `Пошук актів Dziennik Ustaw і Monitor Polski (165 тис.) за словами в назві (у будь-якій граматичній формі) або за ELI (DU/1964/93). Чинні й найчастіше змінювані акти йдуть першими, тож основний кодекс випереджає акти про внесення змін до нього.

Оголошення консолідованих текстів типово не показуються; їх вмикає include_consolidated. Далі: pl_get_act, pl_get_act_article, pl_get_act_text.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Слова з назви акта (будь-який регістр) або ELI' },
            publisher: { type: 'string', enum: ['DU', 'MP'], description: 'Dziennik Ustaw або Monitor Polski' },
            in_force: { type: 'boolean', description: 'Лише чинні (true) або нечинні (false)' },
            act_type: { type: 'string', description: 'Вид акта, напр. Ustawa, Rozporządzenie' },
            year: { type: 'number', description: 'Рік видання' },
            include_consolidated: { type: 'boolean', default: false, description: 'Показувати оголошення консолідованих текстів' },
            ...PAGING,
          },
          required: ['query'],
        },
      },
      {
        name: 'pl_get_act',
        annotations: { title: 'Акт Польщі: картка і редакції', readOnlyHint: true },
        description: `Картка польського акта за ELI і перелік його опублікованих редакцій: дата, кількість змін після редакції, наявність статей або тексту.

У Польщі немає офіційної служби редакцій на дату: тут лише тексти, які реально публікувалися. Між ними норма могла змінюватися; це показує amendments_after.`,
        inputSchema: { type: 'object', properties: { eli: ELI_PROP }, required: ['eli'] },
      },
      {
        name: 'pl_get_act_article',
        annotations: { title: 'Стаття акта Польщі', readOnlyHint: true },
        description: `Текст статті польського акта на дату. Приймає "415", "art. 415", "22^1", "22¹".

Береться найновіша на дату редакція з поділом на статті. УВАГА: новітні редакції часто доступні лише в PDF і без поділу, тоді відповідь містить warnings зі списком пропущених редакцій. Перевірте їх через pl_get_act_text.`,
        inputSchema: {
          type: 'object',
          properties: {
            eli: ELI_PROP,
            article: { type: 'string', description: 'Номер статті' },
            as_of: AS_OF_PROP,
          },
          required: ['eli', 'article'],
        },
      },
      {
        name: 'pl_get_act_text',
        annotations: { title: 'Текст акта Польщі', readOnlyHint: true },
        description: `Повний текст редакції польського акта на дату, включно з текстами, отриманими з PDF. Текст віддається вікном до 40 000 символів; наступне вікно задає text_offset. Можна вказати конкретну редакцію через snapshot_eli із pl_get_act.`,
        inputSchema: {
          type: 'object',
          properties: {
            eli: ELI_PROP,
            as_of: AS_OF_PROP,
            snapshot_eli: { type: 'string', description: 'ELI конкретної редакції' },
            text_offset: { type: 'number', default: 0, description: 'Позиція початку тексту' },
          },
          required: ['eli'],
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    if (!this.handles(name)) return null;
    try {
      switch (name) {
        case 'pl_search_court_decisions': return await this.searchDecisions(args);
        case 'pl_get_court_decision': return await this.getDecision(args);
        case 'pl_search_legislation': return await this.searchLegislation(args);
        case 'pl_get_act': return await this.getAct(args);
        case 'pl_get_act_article': return await this.getArticle(args);
        case 'pl_get_act_text': return await this.getText(args);
        default: return null;
      }
    } catch (err) {
      logger.error('[PlLegalTools] query failed', { tool: name, error: (err as Error).message });
      return this.wrapError(isTimeout(err)
        ? 'Запит виконувався надто довго. Уточніть його або додайте фільтри.'
        : 'Не вдалося виконати запит.');
    }
  }

  private async searchDecisions(args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args.query ?? '').trim();
    const caseNumber = String(args.case_number ?? '').trim().replace(/\s+/g, ' ');
    if (!query && !caseNumber) return this.wrapError('Вкажіть query або case_number.');
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (sql: (n: number) => string, value: unknown) => {
      params.push(value);
      where.push(sql(params.length));
    };
    if (query) {
      add((n) => `${COURT_FTS} @@ $${n}::tsquery`, toTsQuery(await wordForms(this.db, query)));
      // Newest-first would otherwise always open with the source's typos (a 3013-12-04 judgment).
      // Such a row stays reachable by its case number.
      where.push('decision_date <= CURRENT_DATE');
    }
    if (caseNumber) add((n) => `case_number = $${n}`, caseNumber);
    if (args.court_type) {
      const types = COURT_TYPES[String(args.court_type)];
      if (!types) return this.wrapError(`court_type має бути одним з: ${Object.keys(COURT_TYPES).join(', ')}.`);
      add((n) => `court_type = ANY($${n}::text[])`, types);
    }
    if (args.decision_type) add((n) => `decision_type = $${n}`, String(args.decision_type).trim());
    for (const [arg, op] of [['date_from', '>='], ['date_to', '<=']] as const) {
      if (args[arg] === undefined || args[arg] === '') continue;
      const d = isoDate(args[arg]);
      if (!d) return this.wrapError('Дати мають бути у форматі YYYY-MM-DD.');
      add((n) => `decision_date ${op} $${n}::date`, d);
    }
    const page = pageOf(args);
    const rows = await (query ? runSearchQuery : runQuery)(this.db,
      // The page is picked first: a snippet in the sorted query is built from the full text of
      // every match, which is hundreds of thousands of rows for a common word.
      `WITH page AS MATERIALIZED (
         SELECT id FROM pl_court_decisions WHERE ${where.join(' AND ')}
         ORDER BY decision_date DESC, id LIMIT ${page.limit + 1} OFFSET ${page.offset}
       )
       SELECT ${DECISION_COLS},
              left(coalesce(nullif(abstract, ''), full_text), ${SNIPPET_RAW_CHARS}) AS snippet
       FROM pl_court_decisions JOIN page USING (id)
       ORDER BY pl_court_decisions.decision_date DESC, id`, params);
    for (const row of rows) row.snippet = plainText(row.snippet ?? '').slice(0, SNIPPET_CHARS);
    return this.wrapResponse(pageResponse(rows, page));
  }

  private async getDecision(args: Record<string, unknown>): Promise<ToolResult> {
    const id = String(args.id ?? '').trim();
    if (!id) return this.wrapError('Вкажіть id.');
    const rows = await runQuery(this.db,
      `SELECT ${DECISION_COLS}, judges, legal_bases,
              referenced_regulations, parties, abstract, full_text, source_url, enriched_outcome
       FROM pl_court_decisions WHERE id = $1`, [id]);
    if (!rows.length) return this.wrapResponse({ error: 'not_found', id });
    const { full_text, ...decision } = rows[0];
    return this.wrapResponse({
      ...decision,
      ...sliceText(plainText(full_text ?? ''), Number(args.text_offset) || 0, DECISION_TEXT_CHARS),
    });
  }

  private async searchLegislation(args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args.query ?? '').trim();
    if (query.length < 2) return this.wrapError('Вкажіть query: слова з назви або ELI.');
    const page = pageOf(args);
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (sql: (n: number) => string, value: unknown) => {
      params.push(value);
      where.push(sql(params.length));
    };
    const eli = this.normalizeEli(query);
    if (eli) {
      add((n) => `eli = $${n}`, eli);
    } else {
      const words = await wordForms(this.db, query);
      if (!words.length) return this.wrapError('Вкажіть query: слова з назви або ELI.');
      for (const { forms } of words) {
        add((n) => `title ILIKE ANY($${n}::text[])`, forms.map((form) => `%${form.replace(/[\\%_]/g, '\\$&')}%`));
      }
      if (!args.include_consolidated) where.push('NOT coalesce(is_consolidation, false)');
    }
    if (args.publisher) add((n) => `publisher = $${n}`, String(args.publisher));
    if (typeof args.in_force === 'boolean') add((n) => `in_force = $${n}`, args.in_force ? 'IN_FORCE' : 'NOT_IN_FORCE');
    if (args.act_type) add((n) => `act_type = $${n}`, String(args.act_type).trim());
    if (args.year) add((n) => `year = $${n}`, Number(args.year));
    const rows = await runQuery(this.db,
      `SELECT ${ACT_COLS} FROM pl_acts WHERE ${where.join(' AND ')}
       ORDER BY (in_force = 'IN_FORCE') DESC, coalesce(amended_by_count, 0) DESC, year DESC, pos DESC
       LIMIT ${page.limit + 1} OFFSET ${page.offset}`, params);
    return this.wrapResponse(pageResponse(rows, page));
  }

  private async getAct(args: Record<string, unknown>): Promise<ToolResult> {
    const resolved = await this.resolveAct(args.eli);
    if ('error' in resolved) return resolved.error;
    const snapshots = await this.snapshots(resolved.act.eli);
    return this.wrapResponse({
      act: resolved.act,
      ...(resolved.resolvedFrom ? { resolved_from: resolved.resolvedFrom } : {}),
      snapshots: snapshots.map((s) => ({
        snapshot_eli: s.snapshot_eli,
        kind: s.snapshot_kind,
        exact_on: s.exact_on,
        valid_to: s.valid_to,
        amendments_after: s.amendments_after,
        articles: s.article_count ?? 0,
        text_available: this.hasText(s),
      })),
    });
  }

  private async getArticle(args: Record<string, unknown>): Promise<ToolResult> {
    const article = normalizeArticle(String(args.article ?? ''));
    if (!article) return this.wrapError('Вкажіть article.');
    const asOf = this.asOfArg(args.as_of);
    if (asOf === false) return this.wrapError('as_of має бути у форматі YYYY-MM-DD.');
    const resolved = await this.resolveAct(args.eli);
    if ('error' in resolved) return resolved.error;

    const rows = await this.snapshots(resolved.act.eli);
    const { chosen, skipped } = pickSnapshot(rows, asOf, (s) => (s.article_count ?? 0) > 0);
    if (!chosen) {
      return this.wrapResponse({
        error: 'no_segmented_edition',
        eli: resolved.act.eli,
        as_of: asOf,
        note: 'На цю дату немає редакції з поділом на статті. Спробуйте pl_get_act_text.',
      });
    }
    const articles = await runQuery(this.db,
      `SELECT art_no, art_display, art_title, text, ord FROM pl_act_articles
       WHERE act_eli = $1 AND snapshot_eli = $2 AND art_no = $3 ORDER BY ord LIMIT 5`,
      [resolved.act.eli, chosen.snapshot_eli, article]);
    return this.wrapResponse({
      act: { eli: resolved.act.eli, title: resolved.act.title, in_force: resolved.act.in_force },
      article,
      as_of: asOf,
      found: articles.length > 0,
      snapshot: { snapshot_eli: chosen.snapshot_eli, exact_on: chosen.exact_on, valid_to: chosen.valid_to },
      articles,
      warnings: [
        ...snapshotWarnings(chosen, skipped, 'поділу на статті'),
        ...(articles.length ? [] : ['Статті немає в цій редакції: її могли скасувати або ще не додати.']),
      ],
    });
  }

  private async getText(args: Record<string, unknown>): Promise<ToolResult> {
    const asOf = this.asOfArg(args.as_of);
    if (asOf === false) return this.wrapError('as_of має бути у форматі YYYY-MM-DD.');
    const resolved = await this.resolveAct(args.eli);
    if ('error' in resolved) return resolved.error;

    const rows = await this.snapshots(resolved.act.eli);
    let chosen: Snapshot | null;
    let skipped: Snapshot[] = [];
    if (args.snapshot_eli) {
      chosen = rows.find((s) => s.snapshot_eli === String(args.snapshot_eli).trim()) ?? null;
      if (!chosen) return this.wrapResponse({ error: 'snapshot_not_found', snapshot_eli: args.snapshot_eli });
      if (!this.hasText(chosen)) return this.wrapResponse({ error: 'no_text', snapshot_eli: chosen.snapshot_eli, note: 'Для цієї редакції текст не завантажено.' });
    } else {
      ({ chosen, skipped } = pickSnapshot(rows, asOf, (s) => this.hasText(s)));
      if (!chosen) return this.wrapResponse({ error: 'no_text', eli: resolved.act.eli, as_of: asOf, note: 'На цю дату текст не завантажено.' });
    }

    const stored = await runQuery(this.db,
      `SELECT coalesce(t.text, (SELECT string_agg(coalesce(a.art_display, '') || ' ' || coalesce(a.text, ''), E'\n\n' ORDER BY a.ord)
                                FROM pl_act_articles a WHERE a.snapshot_eli = t.snapshot_eli AND a.act_eli = t.act_eli)) AS body
       FROM pl_snapshot_texts t WHERE t.snapshot_eli = $1`, [chosen.snapshot_eli]);
    return this.wrapResponse({
      act: { eli: resolved.act.eli, title: resolved.act.title, in_force: resolved.act.in_force },
      snapshot: { snapshot_eli: chosen.snapshot_eli, exact_on: chosen.exact_on, valid_to: chosen.valid_to },
      text_source: chosen.http_status === 906 ? 'pdf' : 'html',
      article_segmented: (chosen.article_count ?? 0) > 0,
      warnings: snapshotWarnings(chosen, skipped, 'завантаженого тексту'),
      ...sliceText(stored[0]?.body ?? '', Number(args.text_offset) || 0, ACT_TEXT_CHARS),
    });
  }

  private hasText(s: Snapshot): boolean {
    return VERDICT_TEXT.includes(Number(s.http_status)) && (s.has_text || (s.article_count ?? 0) > 0);
  }

  private async snapshots(actEli: string): Promise<Snapshot[]> {
    const rows = await runQuery(this.db,
      `SELECT s.snapshot_eli, s.seq, s.snapshot_kind, s.exact_on::text AS exact_on, s.valid_to::text AS valid_to,
              s.amendments_after, t.http_status, t.article_count, t.n_chars, (t.text IS NOT NULL) AS has_text
       FROM pl_act_snapshots s LEFT JOIN pl_snapshot_texts t ON t.snapshot_eli = s.snapshot_eli
       WHERE s.act_eli = $1 ORDER BY s.exact_on DESC NULLS LAST, s.seq DESC`, [actEli]);
    return rows.map((r) => ({ ...r, has_text: Boolean(r.has_text) }));
  }

  /** A consolidated text is a separate ELI; its history is the base act's history. */
  private async resolveAct(value: unknown): Promise<{ act: any; resolvedFrom?: string } | { error: ToolResult }> {
    const eli = this.normalizeEli(String(value ?? ''));
    if (!eli) return { error: this.wrapError('eli має бути у форматі DU/1964/93 або MP/2020/12.') };
    const rows = await runQuery(this.db, `SELECT ${ACT_COLS} FROM pl_acts WHERE eli = $1`, [eli]);
    if (!rows.length) return { error: this.wrapResponse({ error: 'not_found', eli }) };
    const act = rows[0];
    if (act.is_consolidation && act.consolidates_eli) {
      const base = await runQuery(this.db, `SELECT ${ACT_COLS} FROM pl_acts WHERE eli = $1`, [act.consolidates_eli]);
      if (base.length) return { act: base[0], resolvedFrom: eli };
    }
    return { act };
  }

  private normalizeEli(value: string): string | null {
    const m = value.trim().match(/^(DU|MP)\/(\d{4})\/(\d+)$/i);
    return m ? `${m[1].toUpperCase()}/${m[2]}/${m[3]}` : null;
  }

  /** null when absent, false when malformed. */
  private asOfArg(value: unknown): string | null | false {
    if (value === undefined || value === null || value === '') return null;
    return isoDate(value) ?? false;
  }
}
