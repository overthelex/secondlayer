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
 *  - The newest editions are often PDF-only (verdict 906). Most are split into articles from
 *    the PDF (scripts/pl/segment_eli_pdf.py, pdf_split = 200); the rest carry no article rows,
 *    so an article lookup is answered from an older edition and the response lists the newer
 *    editions it had to skip.
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
export const COURT_TYPES: Record<string, string[]> = {
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

/**
 * ISAP's relation lists, keyed in English. Each row of pl_act_references is one entry of the
 * list `category` on the page of act src_eli, so every key reads from the asked act's side:
 * amended_by on the Kodeks cywilny lists the acts that amend it.
 */
export const RELATIONS: Record<string, string> = {
  amended_by: 'Akty zmieniające',
  amends: 'Akty zmienione',
  amended_after_consolidation: 'Nowelizacje po tekście jednolitym',
  implementing_acts: 'Akty wykonawcze',
  legal_basis: 'Podstawa prawna',
  legal_basis_article: 'Podstawa prawna z art.',
  references: 'Odesłania',
  repealed_by: 'Akty uchylające',
  repeals: 'Akty uchylone',
  deemed_repealed: 'Akty uznane za uchylone',
  repealed_as_result_of: 'Uchylenia wynikające z',
  consolidated_texts: 'Inf. o tekście jednolitym',
  consolidates: 'Tekst jednolity dla aktu',
  tk_rulings: 'Orzeczenie TK',
  tk_ruling_on: 'Orzeczenie TK dla aktu',
  corrections: 'Sprostowanie',
  corrects: 'Sprostowanie dla aktów',
  introducing_acts: 'Przepisy wprowadzające',
  introduced_acts: 'Przepisy wprowadzane',
};
const RELATION_KEY = Object.fromEntries(Object.entries(RELATIONS).map(([k, v]) => [v, k]));
const RELATION_PREVIEW = 5;

/** pl_act_units heading types, outermost first; articles are 'arti'. */
const HEADING_TYPES = ['part', 'book', 'titl', 'sect', 'bran', 'chpt', 'schp'];
const MAX_HEADINGS = 600;

/** Party names are matched as a phrase; short tokens (sp, z, o) are not inflected. */
const PARTY_MIN_INFLECT = 4;
const PARTY_LATEST = 10;

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

/** A tsquery literal for one lexeme. */
function tsLexeme(lexeme: string): string {
  return `'${lexeme.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/**
 * Consecutive words joined with <N>, N = the gap between their positions, so "sp. z o.o."
 * (sp z o o) stays one phrase. Each word may match any of its forms.
 */
export function phraseTsQuery(words: { word: string; pos: number; forms: string[] }[]): string | null {
  if (!words.length) return null;
  let out = '';
  words.forEach((w, i) => {
    const alts = [...new Set([w.word, ...w.forms])].map(tsLexeme);
    const term = alts.length > 1 ? `(${alts.join(' | ')})` : alts[0];
    out += i === 0 ? term : ` <${Math.max(w.pos - words[i - 1].pos, 1)}> ${term}`;
  });
  return out;
}

interface OutlineUnit { ord: number; depth: number; unit_type: string; name: string | null; title: string | null; in_annex: boolean }

/**
 * Headings in document order with the first and last article under each. An article belongs
 * to every heading that is still open when it appears; a heading closes at the next heading of
 * the same or a shallower depth.
 */
export function buildOutline(units: OutlineUnit[]) {
  const headings: any[] = [];
  const open: any[] = [];
  const articles = { count: 0, first: null as string | null, last: null as string | null };
  for (const u of units) {
    if (u.unit_type === 'arti') {
      // Unit names write superscripts as 43_10; articles are looked up as 43^10.
      const name = String(u.name ?? u.title ?? '').replace(/_/g, '^');
      articles.count += 1;
      articles.first ??= name;
      articles.last = name;
      for (const h of open) {
        h.first_article ??= name;
        h.last_article = name;
        h.article_count += 1;
      }
      continue;
    }
    while (open.length && open[open.length - 1].depth >= u.depth) open.pop();
    const h = {
      type: u.unit_type,
      depth: u.depth,
      title: u.title ?? u.name,
      ...(u.in_annex ? { in_annex: true } : {}),
      first_article: null as string | null,
      last_article: null as string | null,
      article_count: 0,
    };
    headings.push(h);
    open.push(h);
  }
  // Consolidated texts sit wholly inside the annex: the flag only helps when an act has both.
  if (headings.every((h) => h.in_annex) || !headings.some((h) => h.in_annex)) {
    for (const h of headings) delete h.in_annex;
  }
  return { headings, articles };
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
      {
        name: 'pl_get_act_relations',
        annotations: { title: 'Зв’язки польського акта', readOnlyHint: true },
        description: `Зв’язки польського акта за ELI з реєстру ISAP: які акти його змінюють і які змінює він, виконавчі акти, правова підстава, відсилання, скасування, консолідовані тексти, рішення Конституційного трибуналу щодо нього.

Без relation повертає кількість у кожному виді зв’язку і по ${RELATION_PREVIEW} найновіших записів; з relation повертає повний список із пагінацією. Ключі relation читаються з боку запитаного акта: amended_by = акти, що його змінюють; tk_rulings = рішення TK щодо нього; repealed_by = акти, що його скасували. Далі: pl_get_act.`,
        inputSchema: {
          type: 'object',
          properties: {
            eli: ELI_PROP,
            relation: { type: 'string', enum: Object.keys(RELATIONS), description: 'Вид зв’язку; без нього підсумок за всіма' },
            ...PAGING,
          },
          required: ['eli'],
        },
      },
      {
        name: 'pl_get_act_structure',
        annotations: { title: 'Структура польського акта', readOnlyHint: true },
        description: `Зміст польського акта: частини, книги, титули, розділи, глави з діапазоном статей у кожній, для редакції на дату. Лише редакції з поділом на статті; найновіші редакції, доступні тільки в PDF, пропускаються з попередженням. Далі: pl_get_act_article.`,
        inputSchema: {
          type: 'object',
          properties: {
            eli: ELI_PROP,
            as_of: AS_OF_PROP,
            max_depth: { type: 'number', description: 'Найбільша глибина заголовків (0 = верхній рівень)' },
          },
          required: ['eli'],
        },
      },
      {
        name: 'pl_count_cases_by_party',
        annotations: { title: 'Справи за учасником (Польща)', readOnlyHint: true },
        description: `Скільки рішень судів Польщі згадують учасника: розподіл за видом суду і роками та ${PARTY_LATEST} найновіших рішень. Назва шукається як фраза в тексті рішення в усіх граматичних формах (PKN Orlen знаходить і PKN Orlenu).

Підходить для компаній, установ і органів влади. Фізичні особи в польських рішеннях знеособлені, тож пошук за прізвищем майже нічого не дасть. Підрахунок рахує згадки, а не лише сторони справи. Рішення Верховного суду в корпусі є лише до червня 2016 р. Дуже поширена назва без фільтрів може не вкластися в час запиту. Далі: pl_search_court_decisions, pl_get_court_decision.`,
        inputSchema: {
          type: 'object',
          properties: {
            party: { type: 'string', description: 'Назва учасника, напр. "PKN Orlen", "Zakład Ubezpieczeń Społecznych"' },
            court_type: { type: 'string', enum: Object.keys(COURT_TYPES), description: 'Вид суду' },
            date_from: { type: 'string', description: 'Від (YYYY-MM-DD)' },
            date_to: { type: 'string', description: 'До (YYYY-MM-DD, включно)' },
          },
          required: ['party'],
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
        case 'pl_get_act_relations': return await this.getRelations(args);
        case 'pl_get_act_structure': return await this.getStructure(args);
        case 'pl_count_cases_by_party': return await this.countByParty(args);
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

  private async getRelations(args: Record<string, unknown>): Promise<ToolResult> {
    const resolved = await this.resolveAct(args.eli);
    if ('error' in resolved) return resolved.error;
    const { act } = resolved;
    const head = {
      act: { eli: act.eli, title: act.title, in_force: act.in_force, repeal_date: act.repeal_date },
      ...(resolved.resolvedFrom ? { resolved_from: resolved.resolvedFrom } : {}),
    };
    const ITEM = `r.dst_eli AS eli, r.effective_date::text AS effective_date, r.art_ref,
                  a.title, a.act_type, a.in_force, a.announcement_date::text AS announcement_date`;
    const ORDER = 'r.effective_date DESC NULLS LAST, a.announcement_date DESC NULLS LAST, r.dst_eli DESC';

    if (args.relation !== undefined && args.relation !== '') {
      const category = RELATIONS[String(args.relation)];
      if (!category) return this.wrapError(`relation має бути одним з: ${Object.keys(RELATIONS).join(', ')}.`);
      const page = pageOf(args);
      const [rows, total] = await Promise.all([
        runQuery(this.db,
          `SELECT ${ITEM} FROM pl_act_references r LEFT JOIN pl_acts a ON a.eli = r.dst_eli
           WHERE r.src_eli = $1 AND r.category = $2
           ORDER BY ${ORDER} LIMIT ${page.limit + 1} OFFSET ${page.offset}`, [act.eli, category]),
        runQuery(this.db,
          'SELECT count(*)::int AS n FROM pl_act_references WHERE src_eli = $1 AND category = $2', [act.eli, category]),
      ]);
      return this.wrapResponse({
        ...head,
        relation: args.relation,
        category,
        total: total[0]?.n ?? 0,
        ...pageResponse(rows, page),
      });
    }

    const rows = await runQuery(this.db,
      `SELECT * FROM (
         SELECT r.category, count(*) OVER (PARTITION BY r.category)::int AS total,
                row_number() OVER (PARTITION BY r.category ORDER BY ${ORDER}) AS rn, ${ITEM}
         FROM pl_act_references r LEFT JOIN pl_acts a ON a.eli = r.dst_eli
         WHERE r.src_eli = $1
       ) x WHERE rn <= ${RELATION_PREVIEW} ORDER BY category, rn`, [act.eli]);
    const groups = new Map<string, { relation: string; category: string; total: number; latest: any[] }>();
    for (const { category, total, rn, ...item } of rows) {
      const relation = RELATION_KEY[category] ?? category;
      if (!groups.has(relation)) groups.set(relation, { relation, category, total, latest: [] });
      groups.get(relation)!.latest.push(item);
    }
    const order = Object.keys(RELATIONS);
    const relations = [...groups.values()].sort((a, b) => order.indexOf(a.relation) - order.indexOf(b.relation));
    return this.wrapResponse({
      ...head,
      relations,
      ...(relations.length ? {} : { note: 'ISAP не містить зв’язків для цього акта.' }),
    });
  }

  private async getStructure(args: Record<string, unknown>): Promise<ToolResult> {
    const asOf = this.asOfArg(args.as_of);
    if (asOf === false) return this.wrapError('as_of має бути у форматі YYYY-MM-DD.');
    const maxDepth = args.max_depth === undefined || args.max_depth === '' ? null : Number(args.max_depth);
    if (maxDepth !== null && !(Number.isInteger(maxDepth) && maxDepth >= 0)) {
      return this.wrapError('max_depth має бути цілим числом від 0.');
    }
    const resolved = await this.resolveAct(args.eli);
    if ('error' in resolved) return resolved.error;
    const snaps = await this.snapshots(resolved.act.eli);
    const { chosen, skipped } = pickSnapshot(snaps, asOf, (s) => (s.article_count ?? 0) > 0);
    if (!chosen) {
      return this.wrapResponse({
        error: 'no_segmented_edition',
        eli: resolved.act.eli,
        as_of: asOf,
        note: 'На цю дату немає редакції з поділом на статті. Спробуйте pl_get_act_text.',
      });
    }
    const units = await runQuery(this.db,
      `SELECT ord, depth, unit_type, name, title, in_annex FROM pl_act_units
       WHERE snapshot_eli = $1 AND unit_type = ANY($2::text[]) ORDER BY ord`,
      [chosen.snapshot_eli, [...HEADING_TYPES, 'arti']]);
    const { headings, articles } = buildOutline(units);
    const shown = headings.filter((h) => maxDepth === null || h.depth <= maxDepth);
    return this.wrapResponse({
      act: { eli: resolved.act.eli, title: resolved.act.title, in_force: resolved.act.in_force },
      as_of: asOf,
      snapshot: { snapshot_eli: chosen.snapshot_eli, exact_on: chosen.exact_on, valid_to: chosen.valid_to },
      article_count: articles.count,
      first_article: articles.first,
      last_article: articles.last,
      headings: shown.slice(0, MAX_HEADINGS),
      ...(shown.length > MAX_HEADINGS ? { truncated: true, total_headings: shown.length } : {}),
      warnings: snapshotWarnings(chosen, skipped, 'поділу на статті'),
    });
  }

  private async countByParty(args: Record<string, unknown>): Promise<ToolResult> {
    const party = String(args.party ?? '').trim().replace(/\s+/g, ' ');
    if (party.length < 3) return this.wrapError('Вкажіть party: назву учасника (щонайменше 3 символи).');
    const tsquery = await this.partyTsQuery(party);
    if (!tsquery) return this.wrapError('У назві учасника немає слів для пошуку.');

    const params: unknown[] = [tsquery];
    const where = [`${COURT_FTS} @@ $1::tsquery`, 'decision_date <= CURRENT_DATE'];
    if (args.court_type) {
      const types = COURT_TYPES[String(args.court_type)];
      if (!types) return this.wrapError(`court_type має бути одним з: ${Object.keys(COURT_TYPES).join(', ')}.`);
      params.push(types);
      where.push(`court_type = ANY($${params.length}::text[])`);
    }
    for (const [arg, op] of [['date_from', '>='], ['date_to', '<=']] as const) {
      if (args[arg] === undefined || args[arg] === '') continue;
      const d = isoDate(args[arg]);
      if (!d) return this.wrapError('Дати мають бути у форматі YYYY-MM-DD.');
      params.push(d);
      where.push(`decision_date ${op} $${params.length}::date`);
    }
    const rows = await runSearchQuery(this.db,
      `WITH m AS MATERIALIZED (
         SELECT id, court_type, decision_date FROM pl_court_decisions WHERE ${where.join(' AND ')}
       )
       SELECT (SELECT count(*)::int FROM m) AS total,
              (SELECT coalesce(json_agg(x ORDER BY x.n DESC), '[]') FROM
                 (SELECT court_type, count(*)::int AS n FROM m GROUP BY 1) x) AS by_court_type,
              (SELECT coalesce(json_agg(x ORDER BY x.year), '[]') FROM
                 (SELECT extract(year FROM decision_date)::int AS year, count(*)::int AS n FROM m GROUP BY 1) x) AS by_year,
              (SELECT coalesce(json_agg(d ORDER BY d.decision_date DESC, d.id), '[]') FROM
                 (SELECT p.id, p.case_number, p.court_type, p.court_name, p.decision_type,
                         p.decision_date::text AS decision_date
                  FROM pl_court_decisions p
                  JOIN (SELECT id FROM m ORDER BY decision_date DESC, id LIMIT ${PARTY_LATEST}) l USING (id)) d) AS latest`,
      params);
    const r = rows[0] ?? { total: 0, by_court_type: [], by_year: [], latest: [] };
    const courtKey = (raw: string | null) =>
      Object.entries(COURT_TYPES).find(([, values]) => raw !== null && values.includes(raw))?.[0] ?? raw;
    // Several source labels share one key (COMMON, ordinary_court): sum them.
    const byCourt = new Map<string, number>();
    for (const { court_type, n } of r.by_court_type) {
      const key = String(courtKey(court_type) ?? 'unknown');
      byCourt.set(key, (byCourt.get(key) ?? 0) + n);
    }
    return this.wrapResponse({
      party,
      total: r.total,
      by_court_type: Object.fromEntries([...byCourt.entries()].sort((a, b) => b[1] - a[1])),
      by_year: Object.fromEntries(r.by_year.map((y: any) => [String(y.year), y.n])),
      latest: r.latest.map((d: any) => ({ ...d, court_type: courtKey(d.court_type) })),
      note: 'Рахуються рішення, у тексті яких є ця назва, а не лише ті, де учасник є стороною.',
    });
  }

  /** The party's words as a phrase, each longer word in any inflected form. */
  private async partyTsQuery(party: string): Promise<string | null> {
    const rows = await runQuery(this.db,
      `SELECT q.lexeme AS word, p.pos::int AS pos,
              CASE WHEN length(q.lexeme) >= ${PARTY_MIN_INFLECT} AND q.lexeme !~ '[0-9]'
                   THEN array_remove(array_agg(DISTINCT g.form), NULL) ELSE '{}'::text[] END AS forms
       FROM unnest(to_tsvector('simple'::regconfig, $1)) AS q CROSS JOIN LATERAL unnest(q.positions) AS p(pos)
       LEFT JOIN pl_word_forms f ON f.form = q.lexeme
       LEFT JOIN pl_word_forms g ON g.lemma = f.lemma AND g.pos = f.pos
       GROUP BY q.lexeme, p.pos ORDER BY p.pos`, [party]);
    return phraseTsQuery(rows.map((r: any) => ({ word: r.word, pos: r.pos, forms: r.forms ?? [] })));
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
