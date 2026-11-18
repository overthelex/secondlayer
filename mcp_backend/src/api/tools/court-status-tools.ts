/**
 * Court Case Status Tools
 *
 * 3 tools:
 * - search_court_case_status — стан розгляду справ (ДСА: КЦС, ККС, ВП та частина місцевих судів)
 * - search_case_status_by_party — справи за стороною (ПІБ або назва) з накопиченої історії
 *   стану розгляду справ ДСА та архіву розкладу засідань
 * - get_case_status_details — усі стадії, сторони та засідання у справі за номером
 *
 * Note: search_court_schedule was merged into search_court_hearing_schedule (court-session-tools.ts)
 */

import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { createHash } from 'crypto';
import { logger } from '../../utils/logger.js';
import {
  buildTsQuery,
  matchParticipants,
  parsePartyQuery,
  resolveRegion,
  REGIONS,
  type PartyMatch,
} from './court-party-match.js';

/**
 * Index expression for case-number lookups (LEXAI-2104). MUST stay byte-identical to the
 * expression in migration 230_court_case_status_number_norm.sql, otherwise the planner
 * cannot use idx_case_status_case_norm and every lookup seq-scans 1.25M rows.
 * Whitespace is stripped (the source has numbers like " 201/14253/25" and "16- ц") and the
 * case folded ("-Ц" and "-ц" are the same proceeding suffix).
 */
export const CASE_NUMBER_NORM_SQL = `lower(regexp_replace(case_number, '\\s+', '', 'g'))`;

/**
 * Sort key for stage_date (DD.MM.YYYY text): YYYYMMDD, or NULL when the value is not a real
 * calendar date or its year is implausible. The ДСА source has typed years such as
 * «01.12.2323» and «28.08.9022» (LEXAI-2173): the importer normalises incoming rows and
 * migration 233 cleaned the rows already stored; this key keeps any that remain from sorting
 * above every real stage. The nested CASEs never throw: each cast or make_date() runs only
 * after the previous level has validated its input.
 */
export function dmyDateKeySql(col: string): string {
  return `CASE WHEN ${col} ~ '^\\d{2}\\.\\d{2}\\.\\d{4}$' THEN
        CASE WHEN substr(${col}, 7, 4)::int BETWEEN 1991 AND extract(year FROM now())::int + 1
              AND substr(${col}, 4, 2)::int BETWEEN 1 AND 12 THEN
          CASE WHEN substr(${col}, 1, 2)::int BETWEEN 1 AND extract(day FROM make_date(
                  substr(${col}, 7, 4)::int, substr(${col}, 4, 2)::int, 1)
                  + interval '1 month - 1 day')::int
            THEN substr(${col}, 7, 4) || substr(${col}, 4, 2) || substr(${col}, 1, 2) END
        END
      END`;
}

export const STAGE_DATE_SORT_SQL = dmyDateKeySql('stage_date');

/** Same normalisation as CASE_NUMBER_NORM_SQL, applied to user input. */
export function normalizeCaseNumber(raw: string): string {
  return String(raw || '').replace(/\s+/g, '').toLowerCase();
}

/**
 * A case number "has a suffix" when it ends in -<letters> after the last digit group:
 * 522/9583/16-ц, 761/1/19-к, 9901/5/20-а. Anything ending in a digit (522/9583/16,
 * old-style 2-123/2010) has none.
 */
export function hasProceedingSuffix(normalized: string): boolean {
  return /\d-[^\d/-]+$/u.test(normalized);
}

/** Escape LIKE metacharacters so a user-typed % or _ is matched literally. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

/**
 * Build the WHERE fragment for a case number. Users rarely type the proceeding suffix,
 * and the registry stores the same case both bare (522/9583/16) and suffixed
 * (522/9583/16-ц), so a bare number also matches "<number>-<anything>". The "-" anchor
 * keeps 522/9583/16 from matching 522/9583/161. Both branches are served by the
 * text_pattern_ops expression index (equality + left-anchored LIKE).
 */
export function buildCaseNumberCondition(
  raw: string,
  paramIndex: number,
): { sql: string; values: string[] } {
  const norm = normalizeCaseNumber(raw);
  if (hasProceedingSuffix(norm)) {
    return { sql: `${CASE_NUMBER_NORM_SQL} = $${paramIndex}`, values: [norm] };
  }
  return {
    sql: `(${CASE_NUMBER_NORM_SQL} = $${paramIndex} OR ${CASE_NUMBER_NORM_SQL} LIKE $${paramIndex + 1})`,
    values: [norm, `${escapeLike(norm)}-%`],
  };
}

// ---------------------------------------------------------------------------------------
// search_case_status_by_party / get_case_status_details

export const STATUS_SOURCE_LABEL = 'ДСА: стан розгляду справ (відкриті дані)';
export const SESSIONS_SOURCE_LABEL = 'розклад засідань';
export const FAIR_URL = 'https://court.gov.ua/fair/';
export const VERIFY_NOTE =
  'Повну й актуальну історію руху справи можна перевірити на court.gov.ua/fair (сайт ДСА, потрібно пройти reCAPTCHA).';
export const COVERAGE_NOTE =
  'Джерела: відкриті дані ДСА «Інформація щодо стану розгляду справ» (накопичена історія щоденних знімків) та архів ' +
  'розкладу судових засідань. Охоплено переважно цивільні, господарські та адміністративні справи і справи про адмінправопорушення ' +
  'у судах першої інстанції і події останніх років; у кримінальних справах сторони в джерелі не зазначені. ' +
  'Порожній результат НЕ означає, що справ за участю цієї сторони немає.';

/** Rows read per source before grouping. A query that fills it is "too broad". */
export const STATUS_ROW_CAP = 3000;
export const SESSION_ROW_CAP = 2000;
/** A one-word query without initials or filters that yields more cases than this is "too broad". */
export const BROAD_CASES = 100;
const QUERY_TIMEOUT_MS = 20_000;
const AS_OF_TTL_MS = 10 * 60 * 1000;
const SOURCE_TTL_MS = 5 * 60 * 1000;

/** Proceeding suffixes the hearing archive stores ("201/8176/21-ц"), tried when only a bare number is known. */
const COMMON_SUFFIXES = ['ц', 'к', 'а', 'п', 'кп', 'кс', 'пц', 'ас', 'ап', 'г', 'с'];

interface StatusSource {
  table: 'court_case_status_history' | 'opendata_court_case_status';
  /** YYYYMMDD text keys, so both tables compare and sort the same way. */
  regKey: string;
  stageKey: string;
  orderDesc: string;
  orderAsc: string;
  lastSeen: string;
  causeDep: string;
}

export const HISTORY_SOURCE: StatusSource = {
  table: 'court_case_status_history',
  regKey: `to_char(registration_date, 'YYYYMMDD')`,
  stageKey: `to_char(stage_date, 'YYYYMMDD')`,
  orderDesc: 'stage_date DESC NULLS LAST, id DESC',
  orderAsc: 'stage_date ASC NULLS FIRST, id ASC',
  lastSeen: `to_char(last_seen, 'YYYY-MM-DD')`,
  causeDep: `NULLIF(btrim(cause_dep), '')`,
};

// The daily snapshot table: dates are DD.MM.YYYY text, cleaned to a key that never throws.
export const SNAPSHOT_SOURCE: StatusSource = {
  table: 'opendata_court_case_status',
  regKey: dmyDateKeySql('registration_date'),
  stageKey: dmyDateKeySql('stage_date'),
  orderDesc: `${dmyDateKeySql('stage_date')} DESC NULLS LAST`,
  orderAsc: `${dmyDateKeySql('stage_date')} ASC NULLS FIRST`,
  lastSeen: `NULL::text`,
  causeDep: `NULLIF(btrim(cause_dep), '')`,
};

function statusSelect(src: StatusSource): string {
  return `SELECT court_name, case_number, NULLIF(btrim(case_proc), '') AS case_proc,
        ${src.regKey} AS reg_key, NULLIF(btrim(judge), '') AS judge, NULLIF(btrim(judges), '') AS judges,
        participants, ${src.stageKey} AS stage_key,
        COALESCE(NULLIF(btrim(stage_name), ''), NULLIF(btrim(cause_result), '')) AS stage_name,
        NULLIF(btrim(cause_result), '') AS cause_result, ${src.causeDep} AS cause_dep,
        NULLIF(btrim(case_type), '') AS case_type, NULLIF(btrim(description), '') AS description,
        ${src.lastSeen} AS last_seen
      FROM ${src.table}`;
}

/** Same expression as the GIN indexes (migration 278 partial index needs IS NOT NULL). */
export const PARTICIPANTS_MATCH_SQL = (p: number) =>
  `participants IS NOT NULL AND to_tsvector('simple', participants) @@ to_tsquery('simple', $${p})`;
export const SESSIONS_MATCH_SQL = (p: number) =>
  `to_tsvector('simple', involved_parties) @@ to_tsquery('simple', $${p})`;

const SESSION_COLUMNS = `case_number, court_name, NULLIF(btrim(judge_name), '') AS judge_name,
        to_char(session_date, 'YYYY-MM-DD') AS session_date, NULLIF(btrim(session_time), '') AS session_time,
        NULLIF(btrim(session_form), '') AS session_form, NULLIF(btrim(session_place), '') AS session_place`;

export function keyToIso(key: string | null | undefined): string | null {
  const k = String(key ?? '');
  return /^\d{8}$/.test(k) ? `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}` : null;
}

/** Case number without whitespace, lower-cased, proceeding suffix dropped: "522/9583/16-Ц" → "522/9583/16". */
export function baseCaseNumber(raw: string): string {
  const n = normalizeCaseNumber(raw);
  return hasProceedingSuffix(n) ? n.replace(/-[^\d/-]+$/u, '') : n;
}

/** Numbers with the court code in front ("533/318/15") identify a case without the court name. */
function isCourtCodedNumber(base: string): boolean {
  return /^\d{2,4}\/\d+\/\d{2}$/.test(base);
}

function courtKey(court: string | null | undefined): string {
  return String(court ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function caseKey(court: string | null | undefined, caseNumber: string): string {
  return `${courtKey(court)}|${baseCaseNumber(caseNumber)}`;
}

/** Spellings to look a case up by in court_sessions (raw b-tree equality on case_number). */
export function caseNumberVariants(raw: string, known: string[] = []): string[] {
  const out = new Set<string>();
  const add = (v: string) => { const t = v.trim(); if (t) out.add(t); };
  add(raw);
  add(raw.replace(/\s+/g, ''));
  for (const k of known) { add(k); add(k.replace(/\s+/g, '')); }
  const base = baseCaseNumber(raw);
  add(base);
  if (!hasProceedingSuffix(normalizeCaseNumber(raw)) && known.length === 0) {
    for (const s of COMMON_SUFFIXES) add(`${base}-${s}`);
  }
  return [...out];
}

export function partyHash(party: string): string {
  return createHash('sha256').update(party.trim().toLowerCase()).digest('hex').slice(0, 12);
}

export function kyivToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One statement under a server-side timeout; Postgres cancels a runaway scan itself. */
async function timedQuery(db: any, sql: string, values: unknown[], settings: string[] = []): Promise<any[]> {
  if (typeof db.transaction !== 'function') return (await db.query(sql, values)).rows;
  const result = await db.transaction(async (client: any) => {
    await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
    for (const s of settings) await client.query(s);
    return client.query(sql, values);
  });
  return result.rows;
}

function dbErrorText(error: any): string {
  if (error?.code === '57014') return 'запит перевищив ліміт часу; звузьте пошук (регіон, суд, ініціали, період)';
  return String(error?.message ?? error);
}

interface Hearing {
  date: string | null;
  time: string | null;
  court: string;
  case_number: string;
  judge: string | null;
  form: string | null;
  room: string | null;
}

function toHearing(r: any): Hearing {
  return {
    date: r.session_date ?? null,
    time: r.session_time ?? null,
    court: String(r.court_name ?? '').trim(),
    case_number: String(r.case_number ?? '').trim(),
    judge: r.judge_name ?? null,
    form: r.session_form ?? null,
    room: r.session_place ?? null,
  };
}

function dedupeHearings(hs: Hearing[]): Hearing[] {
  const seen = new Set<string>();
  return hs.filter((h) => {
    const k = `${h.date}|${h.time}|${courtKey(h.court)}|${baseCaseNumber(h.case_number)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Last hearing on or before today and the nearest one after it. */
export function lastAndNext(hearings: Hearing[], today: string): { last: Hearing | null; next: Hearing | null } {
  const sorted = [...hearings].filter((h) => h.date).sort((a, b) =>
    `${a.date} ${a.time ?? ''}`.localeCompare(`${b.date} ${b.time ?? ''}`));
  const past = sorted.filter((h) => (h.date as string) <= today);
  const future = sorted.filter((h) => (h.date as string) > today);
  return { last: past[past.length - 1] ?? null, next: future[0] ?? null };
}

interface CaseGroup {
  key: string;
  court: string;
  case_number: string;
  case_proc: string | null;
  registration_date: string | null;
  judges: string | null;
  participants: string | null;
  subject: string | null;
  case_type: string | null;
  last_stage: { name: string | null; date: string | null; cause_result: string | null } | null;
  stage_events_seen: number;
  matched: PartyMatch[];
  sources: Set<string>;
  activity: string;
  caseNumbers: Set<string>;
  hearings: Hearing[];
}

function addMatches(g: CaseGroup, ms: PartyMatch[]): void {
  for (const m of ms) {
    if (!g.matched.some((x) => x.role === m.role && x.name === m.name)) g.matched.push(m);
  }
}

/**
 * Status rows (newest stage first) and archive sessions (newest first) → one entry per case.
 * Rows whose parties do not contain the query in one segment are dropped here.
 */
export function groupPartyRows(
  statusRows: any[],
  sessionRows: any[],
  q: ReturnType<typeof parsePartyQuery>,
): { groups: CaseGroup[]; rejected: number } {
  const groups = new Map<string, CaseGroup>();
  let rejected = 0;

  for (const r of statusRows) {
    const ms = matchParticipants(r.participants, q);
    if (ms.length === 0) { rejected++; continue; }
    const key = caseKey(r.court_name, r.case_number);
    let g = groups.get(key);
    const stageDate = keyToIso(r.stage_key);
    if (!g) {
      g = {
        key,
        court: String(r.court_name ?? '').trim(),
        case_number: String(r.case_number ?? '').trim(),
        case_proc: r.case_proc ?? null,
        registration_date: keyToIso(r.reg_key),
        judges: r.judges ?? r.judge ?? null,
        participants: r.participants,
        subject: r.description ?? null,
        case_type: r.case_type ?? null,
        last_stage: { name: r.stage_name ?? null, date: stageDate, cause_result: r.cause_result ?? null },
        stage_events_seen: 0,
        matched: [],
        sources: new Set(),
        activity: stageDate ?? '',
        caseNumbers: new Set(),
        hearings: [],
      };
      groups.set(key, g);
    }
    g.stage_events_seen++;
    g.sources.add(STATUS_SOURCE_LABEL);
    g.caseNumbers.add(String(r.case_number ?? '').trim());
    if (!g.subject && r.description) g.subject = r.description;
    if (!g.case_proc && r.case_proc) g.case_proc = r.case_proc;
    if (!g.registration_date && r.reg_key) g.registration_date = keyToIso(r.reg_key);
    if (stageDate && stageDate > g.activity) g.activity = stageDate;
    addMatches(g, ms);
  }

  for (const r of sessionRows) {
    const ms = matchParticipants(r.involved_parties, q);
    if (ms.length === 0) { rejected++; continue; }
    const key = caseKey(r.court_name, r.case_number);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        court: String(r.court_name ?? '').trim(),
        case_number: String(r.case_number ?? '').trim(),
        case_proc: null,
        registration_date: null,
        judges: r.judge_name ?? null,
        participants: r.involved_parties,
        subject: null,
        case_type: null,
        last_stage: null,
        stage_events_seen: 0,
        matched: [],
        sources: new Set(),
        activity: '',
        caseNumbers: new Set(),
        hearings: [],
      };
      groups.set(key, g);
    }
    g.sources.add(SESSIONS_SOURCE_LABEL);
    g.caseNumbers.add(String(r.case_number ?? ''));
    g.hearings.push(toHearing(r));
    if (r.session_date && r.session_date > g.activity) g.activity = r.session_date;
    addMatches(g, ms);
  }

  const list = [...groups.values()].sort((a, b) =>
    b.activity.localeCompare(a.activity) || a.court.localeCompare(b.court) || a.case_number.localeCompare(b.case_number));
  return { groups: list, rejected };
}

/** Attach archive hearings to the cases they belong to (court + number; number alone when it carries the court code). */
export function attachHearings(groups: CaseGroup[], rows: any[]): void {
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const byBase = new Map<string, CaseGroup[]>();
  for (const g of groups) {
    const b = baseCaseNumber(g.case_number);
    byBase.set(b, [...(byBase.get(b) ?? []), g]);
  }
  for (const r of rows) {
    const h = toHearing(r);
    let g = byKey.get(caseKey(r.court_name, r.case_number));
    if (!g) {
      const b = baseCaseNumber(String(r.case_number ?? ''));
      const cands = byBase.get(b) ?? [];
      if (isCourtCodedNumber(b) && cands.length === 1) g = cands[0];
    }
    if (g) g.hearings.push(h);
  }
  for (const g of groups) g.hearings = dedupeHearings(g.hearings);
}

export class CourtStatusTools extends BaseToolHandler {
  private sourceCache: { src: StatusSource; at: number } | null = null;
  private asOfCache = new Map<string, { value: any; at: number }>();

  constructor(private db: any) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'search_court_case_status',
        annotations: { title: 'Статус судової справи', readOnlyHint: true },
        description: `Пошук стану розгляду судових справ за відкритими даними ДСА.

💰 Примерная стоимость: $0.001-$0.005 USD
Пошук за номером справи, суддею, описом або назвою суду. Покриття: Касаційний цивільний суд, Касаційний кримінальний суд і Велика Палата Верховного Суду, а також частина справ місцевих та апеляційних судів. Касаційний господарський і Касаційний адміністративний суди у джерелі майже відсутні, тому порожній результат для них не означає, що справи немає.`,
        inputSchema: {
          type: 'object',
          properties: {
            case_number: {
              type: 'string',
              description: 'Номер справи (наприклад, 352/923/16-ц)',
            },
            judge: {
              type: 'string',
              description: 'Прізвище судді',
            },
            description: {
              type: 'string',
              description: 'Ключові слова з опису справи',
            },
            court_name: {
              type: 'string',
              description: 'Назва суду',
            },
            limit: {
              type: 'number',
              default: 50,
              maximum: 100,
              description: 'Максимальна кількість результатів',
            },
          },
        },
      },
      {
        name: 'search_case_status_by_party',
        annotations: { title: 'Справи за стороною', readOnlyHint: true },
        description: `Пошук судових справ ЗА СТОРОНОЮ справи (позивач, відповідач, третя особа, заявник, представник): прізвище, повне ПІБ, прізвище з ініціалами («Яворська Л.Г.») або назва юридичної особи.

💰 Орієнтовна вартість: $0.024 USD (≈1 грн за виклик)
Джерела: відкриті дані ДСА «Інформація щодо стану розгляду справ» (накопичена історія) та архів розкладу засідань. Для кожної справи: суд, номер, номер провадження, дата реєстрації, судді, сторони, предмет, остання стадія розгляду, останнє й найближче засідання, роль знайденої сторони. Фільтри: регіон (область або «м. Київ»), суд, номер справи чи провадження (початок), період.
Покриття: переважно цивільні, господарські, адміністративні справи та справи про адмінправопорушення в судах першої інстанції, події останніх років; у кримінальних справах сторони в джерелі не зазначені. Порожній результат НЕ означає, що справ немає: повна історія — на court.gov.ua/fair.`,
        inputSchema: {
          type: 'object',
          properties: {
            party: {
              type: 'string',
              description: 'Сторона справи: прізвище, ПІБ, прізвище з ініціалами або назва юрособи (щонайменше 3 символи)',
            },
            region: {
              type: 'string',
              description: 'Регіон: область (напр. «Львівська») або «м. Київ»',
            },
            court_name: {
              type: 'string',
              description: 'Назва суду або її частина',
            },
            case_number: {
              type: 'string',
              description: 'Номер справи або його початок (напр. 757/12345/24)',
            },
            proceeding_number: {
              type: 'string',
              description: 'Номер провадження або його початок (напр. 2/757/1234/24)',
            },
            date_from: {
              type: 'string',
              description: 'Від дати (YYYY-MM-DD): дата реєстрації справи, для засідань — дата засідання',
            },
            date_to: {
              type: 'string',
              description: 'До дати (YYYY-MM-DD)',
            },
            include_sessions: {
              type: 'boolean',
              default: true,
              description: 'Шукати також в архіві засідань і додавати останнє/найближче засідання',
            },
            limit: {
              type: 'number',
              default: 20,
              maximum: 100,
              description: 'Кількість справ на сторінці',
            },
            offset: {
              type: 'number',
              default: 0,
              description: 'Зсув для пагінації',
            },
          },
          required: ['party'],
        },
      },
      {
        name: 'get_case_status_details',
        annotations: { title: 'Картка справи: стадії розгляду', readOnlyHint: true },
        description: `Картка судової справи за номером: усі стадії розгляду в хронологічному порядку, сторони, судді, предмет і всі засідання з архіву розкладу.

💰 Орієнтовна вартість: $0.024 USD (≈1 грн за виклик)
Джерела: відкриті дані ДСА «Інформація щодо стану розгляду справ» (накопичена історія) та архів розкладу засідань. Покриття: переважно цивільні, господарські, адміністративні справи та справи про адмінправопорушення, події останніх років. Якщо справу не знайдено, це НЕ означає, що її немає: повна історія — на court.gov.ua/fair.`,
        inputSchema: {
          type: 'object',
          properties: {
            case_number: {
              type: 'string',
              description: 'Номер справи (напр. 533/318/15-ц; суфікс провадження можна не вказувати)',
            },
            court_name: {
              type: 'string',
              description: 'Назва суду або її частина (для старих номерів без коду суду)',
            },
          },
          required: ['case_number'],
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    switch (name) {
      case 'search_court_case_status':
        return this.searchCaseStatus(args);
      case 'search_case_status_by_party':
        return this.searchByParty(args);
      case 'get_case_status_details':
        return this.caseDetails(args);
      default:
        return null;
    }
  }

  private async searchCaseStatus(args: Record<string, unknown>): Promise<ToolResult> {
    const { case_number, judge, description, court_name, limit = 50 } = args as any;

    const conditions: string[] = [];
    const values: any[] = [];
    let pi = 1;

    if (case_number) {
      const cond = buildCaseNumberCondition(String(case_number), pi);
      conditions.push(cond.sql);
      values.push(...cond.values);
      pi += cond.values.length;
    }
    if (judge) {
      conditions.push(`(judge ILIKE $${pi} OR judges ILIKE $${pi})`);
      values.push(`%${judge}%`);
      pi++;
    }
    if (description) {
      conditions.push(`description ILIKE $${pi}`);
      values.push(`%${description}%`);
      pi++;
    }
    if (court_name) {
      conditions.push(`court_name ILIKE $${pi}`);
      values.push(`%${court_name}%`);
      pi++;
    }

    if (conditions.length === 0) {
      return this.wrapResponse('Вкажіть номер справи, суддю, опис або назву суду для пошуку');
    }

    values.push(Math.min(Number(limit) || 50, 100));

    // stage_date is DD.MM.YYYY text, so ordering the raw string sorted by day of month
    // (30.06.2021 above 13.07.2022); order by YYYYMMDD so the latest step is first. String
    // rearrangement rather than to_date(), which raises on an impossible date like 31.02.
    // Years outside 1991..next year are source typos (LEXAI-2173) and sort last.
    // stage_name is a single space in 1.03M of 1.25M rows: the cassation courts' feed leaves
    // it blank and carries the procedural step in cause_result instead (every row has one of
    // the two). Surface the step as stage_name, trimmed, and turn blank strings into null.
    const sql = `SELECT court_name, case_number, NULLIF(btrim(case_proc), '') AS case_proc,
        NULLIF(btrim(case_type), '') AS case_type, registration_date, judge, NULLIF(btrim(judges), '') AS judges,
        stage_date,
        COALESCE(NULLIF(btrim(stage_name), ''), NULLIF(btrim(cause_result), '')) AS stage_name,
        NULLIF(btrim(cause_result), '') AS cause_result,
        NULLIF(btrim(description), '') AS description
      FROM opendata_court_case_status
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${STAGE_DATE_SORT_SQL} DESC NULLS LAST
      LIMIT $${pi}`;

    try {
      const result = await this.db.query(sql, values);
      if (result.rows.length === 0) {
        return this.wrapResponse('Статусів судових справ не знайдено за вашим запитом');
      }
      return this.wrapResponse(JSON.stringify(result.rows, null, 2));
    } catch (error: any) {
      logger.error('search_court_case_status error', { error: error.message });
      return this.wrapError(`Помилка пошуку: ${error.message}`);
    }
  }

  /**
   * court_case_status_history (migration 278) once the loader has filled it; until then the
   * daily snapshot table, which has the same columns but only the latest ~1.3M events.
   */
  private async statusSource(): Promise<StatusSource> {
    if (this.sourceCache && Date.now() - this.sourceCache.at < SOURCE_TTL_MS) return this.sourceCache.src;
    let src = SNAPSHOT_SOURCE;
    const reg = await this.db.query(`SELECT to_regclass('public.court_case_status_history') IS NOT NULL AS present`);
    if (reg.rows[0]?.present) {
      const has = await this.db.query(`SELECT EXISTS (SELECT 1 FROM court_case_status_history) AS has_rows`);
      if (has.rows[0]?.has_rows) src = HISTORY_SOURCE;
    }
    this.sourceCache = { src, at: Date.now() };
    return src;
  }

  private async cachedAsOf(key: string, load: () => Promise<any>): Promise<any> {
    const hit = this.asOfCache.get(key);
    if (hit && Date.now() - hit.at < AS_OF_TTL_MS) return hit.value;
    try {
      const value = await load();
      this.asOfCache.set(key, { value, at: Date.now() });
      return value;
    } catch (error: any) {
      logger.warn('case status as_of lookup failed', { key, error: error.message });
      return null;
    }
  }

  /** "Станом на": the latest snapshot loaded into the status table, and the latest held hearing in the archive. */
  private async asOf(src: StatusSource, withSessions: boolean): Promise<Record<string, unknown>> {
    const status = await this.cachedAsOf(src.table, async () => {
      if (src === HISTORY_SOURCE) {
        const snap = await this.db.query(
          `SELECT snapshot_name, to_char(loaded_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS loaded
             FROM court_case_status_snapshots ORDER BY loaded_at DESC LIMIT 1`);
        if (snap.rows[0]) return { date: snap.rows[0].loaded, snapshot: snap.rows[0].snapshot_name };
        const seen = await this.db.query(`SELECT to_char(max(last_seen), 'YYYY-MM-DD') AS d FROM court_case_status_history`);
        return { date: seen.rows[0]?.d ?? null, snapshot: null };
      }
      const imp = await this.db.query(
        `SELECT to_char(max(imported_at) AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS d FROM opendata_court_case_status`);
      return { date: imp.rows[0]?.d ?? null, snapshot: null };
    });
    const out: Record<string, unknown> = {
      case_status: status?.date ?? null,
      ...(status?.snapshot ? { case_status_snapshot: status.snapshot } : {}),
    };
    if (withSessions) {
      out.hearings_archive = await this.cachedAsOf('court_sessions', async () => {
        const r = await this.db.query(
          `SELECT to_char(max(session_date), 'YYYY-MM-DD') AS d FROM court_sessions WHERE session_date <= current_date`);
        return r.rows[0]?.d ?? null;
      });
    }
    return out;
  }

  private sourceBlock(src: StatusSource, withSessions: boolean): Record<string, unknown> {
    return {
      case_status: STATUS_SOURCE_LABEL,
      case_status_table: src.table === HISTORY_SOURCE.table ? 'накопичена історія знімків' : 'останній щоденний знімок',
      ...(withSessions ? { hearings: `${SESSIONS_SOURCE_LABEL} (архів проведених засідань, відкриті дані судової влади)` } : {}),
    };
  }

  private async searchByParty(args: Record<string, unknown>): Promise<ToolResult> {
    const party = String(args.party ?? '').trim();
    if (party.length < 3) {
      return this.wrapError('Вкажіть сторону справи (party): прізвище, ПІБ, прізвище з ініціалами або назву юрособи, щонайменше 3 символи');
    }
    const q = parsePartyQuery(party);
    if (q.words.length === 0 || q.words.join('').length < 3) {
      return this.wrapError('У запиті party має бути прізвище або назва (щонайменше 3 літери), а не лише ініціали');
    }

    let region: ReturnType<typeof resolveRegion> = null;
    if (args.region) {
      region = resolveRegion(String(args.region));
      if (!region) {
        return this.wrapError(`Невідомий регіон «${String(args.region)}». Допустимі значення: ${REGIONS.map((r) => r.name).join(', ')}`);
      }
    }
    for (const k of ['date_from', 'date_to'] as const) {
      if (args[k] && !ISO_DATE.test(String(args[k]))) return this.wrapError(`${k} має бути у форматі YYYY-MM-DD`);
    }
    const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 20), 1), 100);
    const offset = Math.max(Math.floor(Number(args.offset) || 0), 0);
    const includeSessions = args.include_sessions !== false && args.include_sessions !== 'false';
    const courtName = args.court_name ? String(args.court_name).trim() : '';
    const caseNumber = args.case_number ? normalizeCaseNumber(String(args.case_number)) : '';
    const procNumber = args.proceeding_number ? String(args.proceeding_number).replace(/\s+/g, '') : '';
    const dateFrom = args.date_from ? String(args.date_from) : '';
    const dateTo = args.date_to ? String(args.date_to) : '';

    // The party never goes to the log in plain text.
    logger.info('search_case_status_by_party', {
      party_hash: partyHash(party), words: q.words.length, initials: q.initials.length,
      region: region?.name, include_sessions: includeSessions,
    });

    let src: StatusSource;
    try {
      src = await this.statusSource();
    } catch (error: any) {
      logger.error('search_case_status_by_party source check failed', { error: error.message });
      return this.wrapError(`Помилка бази даних: ${dbErrorText(error)}`);
    }
    const tsq = buildTsQuery(q);

    // --- status rows ---
    const sc: string[] = [PARTICIPANTS_MATCH_SQL(1)];
    const sv: unknown[] = [tsq];
    const push = (list: string[], vals: unknown[], sql: (p: number) => string, v: unknown) => {
      vals.push(v);
      list.push(sql(vals.length));
    };
    if (region) push(sc, sv, (p) => `court_name ILIKE ANY($${p}::text[])`, region.patterns);
    if (courtName) push(sc, sv, (p) => `court_name ILIKE $${p}`, `%${escapeLike(courtName)}%`);
    if (caseNumber) push(sc, sv, (p) => `${CASE_NUMBER_NORM_SQL} LIKE $${p}`, `${escapeLike(caseNumber)}%`);
    if (procNumber) push(sc, sv, (p) => `regexp_replace(COALESCE(case_proc, ''), '\\s+', '', 'g') ILIKE $${p}`, `${escapeLike(procNumber)}%`);
    if (src === HISTORY_SOURCE) {
      if (dateFrom) push(sc, sv, (p) => `registration_date >= $${p}::date`, dateFrom);
      if (dateTo) push(sc, sv, (p) => `registration_date <= $${p}::date`, dateTo);
    } else {
      if (dateFrom) push(sc, sv, (p) => `${src.regKey} >= $${p}`, dateFrom.replace(/-/g, ''));
      if (dateTo) push(sc, sv, (p) => `${src.regKey} <= $${p}`, dateTo.replace(/-/g, ''));
    }
    sv.push(STATUS_ROW_CAP);
    const statusSql = `${statusSelect(src)}
      WHERE ${sc.join(' AND ')}
      ORDER BY ${src.orderDesc}
      LIMIT $${sv.length}`;

    // --- archive sessions found by party (no proceeding number there, so skipped when one is given) ---
    const searchSessions = includeSessions && !procNumber;
    const xc: string[] = [SESSIONS_MATCH_SQL(1)];
    const xv: unknown[] = [tsq];
    if (region) push(xc, xv, (p) => `court_name ILIKE ANY($${p}::text[])`, region.patterns);
    if (courtName) push(xc, xv, (p) => `court_name ILIKE $${p}`, `%${escapeLike(courtName)}%`);
    if (caseNumber) push(xc, xv, (p) => `${CASE_NUMBER_NORM_SQL} LIKE $${p}`, `${escapeLike(caseNumber)}%`);
    if (dateFrom) push(xc, xv, (p) => `session_date >= $${p}::date`, dateFrom);
    if (dateTo) push(xc, xv, (p) => `session_date <= $${p}::date`, dateTo);
    xv.push(SESSION_ROW_CAP);
    const sessionsSql = `SELECT ${SESSION_COLUMNS}, involved_parties
      FROM court_sessions
      WHERE ${xc.join(' AND ')}
      ORDER BY session_date DESC NULLS LAST
      LIMIT $${xv.length}`;

    // A common name looks frequent to the planner, so it walks the session_date index and
    // recomputes to_tsvector on every row it passes (7 s for «приватбанк» + Київ); the GIN
    // bitmap plus a top-N sort does the same in ~0.5 s. Same remedy as runSearchQuery (PL).
    const noIndexScan = ['SET LOCAL enable_indexscan = off'];
    const [statusRes, sessionRes] = await Promise.allSettled([
      timedQuery(this.db, statusSql, sv, noIndexScan),
      searchSessions ? timedQuery(this.db, sessionsSql, xv, noIndexScan) : Promise.resolve([]),
    ]);

    const warnings: string[] = [];
    if (statusRes.status === 'rejected') {
      logger.error('search_case_status_by_party status query failed', { error: statusRes.reason?.message });
      warnings.push(`Стан розгляду справ тимчасово недоступний: ${dbErrorText(statusRes.reason)}`);
    }
    if (sessionRes.status === 'rejected') {
      logger.error('search_case_status_by_party sessions query failed', { error: sessionRes.reason?.message });
      warnings.push(`Архів засідань тимчасово недоступний: ${dbErrorText(sessionRes.reason)}`);
    }
    const statusRows = statusRes.status === 'fulfilled' ? statusRes.value : [];
    const sessionRows = sessionRes.status === 'fulfilled' ? sessionRes.value : [];

    const { groups, rejected } = groupPartyRows(statusRows, sessionRows, q);
    if (warnings.length > 0 && groups.length === 0) {
      // Never an empty list for a failed lookup: that would read as "no cases".
      return this.wrapError(`Пошук не виконано через помилку бази даних. ${warnings.join(' ')}`);
    }

    const page = groups.slice(offset, offset + limit);
    const today = kyivToday();
    if (includeSessions && page.length > 0) {
      const numbers = [...new Set(page.flatMap((g) => caseNumberVariants(g.case_number, [...g.caseNumbers])))];
      try {
        const rows = await timedQuery(this.db,
          `SELECT ${SESSION_COLUMNS} FROM court_sessions WHERE case_number = ANY($1::text[])
            ORDER BY session_date DESC NULLS LAST LIMIT 5000`, [numbers]);
        attachHearings(page, rows);
      } catch (error: any) {
        logger.error('search_case_status_by_party hearings lookup failed', { error: error.message });
        warnings.push(`Засідання для знайдених справ не завантажено: ${dbErrorText(error)}`);
      }
    }

    const capped = statusRows.length >= STATUS_ROW_CAP || sessionRows.length >= SESSION_ROW_CAP;
    const narrowed = Boolean(region || courtName || caseNumber || procNumber || dateFrom || dateTo);
    const tooBroad = capped || (q.words.length === 1 && q.initials.length === 0 && !narrowed && groups.length > BROAD_CASES);

    const results = page.map((g) => {
      const { last, next } = lastAndNext(g.hearings, today);
      return {
        court: g.court,
        case_number: g.case_number,
        case_proc: g.case_proc,
        registration_date: g.registration_date,
        judges: g.judges,
        participants: g.participants,
        subject: g.subject,
        case_type: g.case_type,
        matched_parties: g.matched.map((m) => ({ role: m.role, name: m.name, match_variant: m.match_variant })),
        last_stage: g.last_stage,
        stage_events_seen: g.stage_events_seen,
        last_hearing: last,
        next_hearing: next,
        hearings_seen: g.hearings.length,
        sources: [...g.sources],
        verify_url: FAIR_URL,
      };
    });

    let status: 'ok' | 'too_broad' | 'no_results' = 'ok';
    let message: string;
    if (groups.length === 0) {
      status = 'no_results';
      message = 'Справ за цією стороною у відкритих даних не знайдено. Це НЕ означає, що справ немає: джерело охоплює ' +
        'переважно цивільні, господарські, адміністративні справи та справи про адмінправопорушення першої інстанції за останні роки, у кримінальних ' +
        'справах сторони не зазначені. Перевірте написання (ПІБ у називному відмінку, назва юрособи без лапок) або ' +
        'перевірте на court.gov.ua/fair.';
    } else if (tooBroad) {
      status = 'too_broad';
      message = `Запит дуже широкий: знайдено ${capped ? 'понад ' : ''}${groups.length} справ` +
        (capped ? ' (прочитано лише найновіші записи, тому повний перелік недоступний)' : '') +
        '. Уточніть пошук: додайте ініціали або повне ПІБ, регіон (region), суд, номер справи чи період. Нижче — перша сторінка найновіших справ.';
    } else {
      message = `Знайдено справ: ${groups.length}.`;
    }

    return this.wrapResponse({
      status,
      message,
      total_found: groups.length,
      total_is_lower_bound: capped,
      returned: results.length,
      offset,
      limit,
      has_more: offset + results.length < groups.length,
      results,
      query: {
        party_words: q.words,
        ...(q.initials.length ? { initials: q.initials } : {}),
        ...(q.droppedForms.length ? { ignored_legal_forms: q.droppedForms } : {}),
        ...(region ? { region: region.name } : {}),
        ...(courtName ? { court_name: courtName } : {}),
        ...(caseNumber ? { case_number_prefix: caseNumber } : {}),
        ...(procNumber ? { proceeding_number_prefix: procNumber } : {}),
        ...(dateFrom ? { date_from: dateFrom } : {}),
        ...(dateTo ? { date_to: dateTo } : {}),
        include_sessions: includeSessions,
      },
      matching_note: 'Сторону знайдено, якщо всі слова запиту стоять в імені однієї сторони (ПІБ у називному відмінку, як у джерелі); ' +
        'ініціали перевіряються за порядком імені та по батькові. match_variant показує тип збігу, role — процесуальну роль.' +
        (rejected > 0 ? ` Відкинуто записів, де слова запиту належать різним сторонам або ініціали не збіглися: ${rejected}.` : '') +
        (procNumber && includeSessions ? ' В архіві засідань немає номера провадження, тому з фільтром proceeding_number справи шукаються лише в стані розгляду.' : ''),
      source: this.sourceBlock(src, includeSessions),
      as_of: await this.asOf(src, includeSessions),
      coverage_note: COVERAGE_NOTE,
      verify: { url: FAIR_URL, note: VERIFY_NOTE },
      ...(warnings.length ? { warnings, incomplete: true } : {}),
    });
  }

  private async caseDetails(args: Record<string, unknown>): Promise<ToolResult> {
    const raw = String(args.case_number ?? '').trim();
    if (normalizeCaseNumber(raw).length < 3) return this.wrapError('Вкажіть номер справи (case_number)');
    const courtName = args.court_name ? String(args.court_name).trim() : '';

    let src: StatusSource;
    try {
      src = await this.statusSource();
    } catch (error: any) {
      return this.wrapError(`Помилка бази даних: ${dbErrorText(error)}`);
    }

    const loadStatus = async (s: StatusSource): Promise<any[]> => {
      const cond = buildCaseNumberCondition(raw, 1);
      const conds = [cond.sql];
      const vals: unknown[] = [...cond.values];
      if (courtName) { vals.push(`%${escapeLike(courtName)}%`); conds.push(`court_name ILIKE $${vals.length}`); }
      return timedQuery(this.db, `${statusSelect(s)} WHERE ${conds.join(' AND ')} ORDER BY ${s.orderAsc} LIMIT 2000`, vals);
    };

    let statusRows: any[];
    try {
      statusRows = await loadStatus(src);
      // Cases whose last event predates the history table live only in the snapshot.
      if (statusRows.length === 0 && src === HISTORY_SOURCE) {
        statusRows = await loadStatus(SNAPSHOT_SOURCE);
        if (statusRows.length > 0) src = SNAPSHOT_SOURCE;
      }
    } catch (error: any) {
      logger.error('get_case_status_details status query failed', { error: error.message });
      return this.wrapError(`Помилка бази даних: ${dbErrorText(error)}`);
    }

    const known = [...new Set(statusRows.map((r) => String(r.case_number ?? '').trim()))];
    let hearingRows: any[] = [];
    const warnings: string[] = [];
    try {
      const vals: unknown[] = [caseNumberVariants(raw, known)];
      let extra = '';
      if (courtName) { vals.push(`%${escapeLike(courtName)}%`); extra = ` AND court_name ILIKE $2`; }
      hearingRows = await timedQuery(this.db,
        `SELECT ${SESSION_COLUMNS} FROM court_sessions WHERE case_number = ANY($1::text[])${extra}
          ORDER BY session_date ASC NULLS LAST, session_time ASC LIMIT 1000`, vals);
    } catch (error: any) {
      logger.error('get_case_status_details hearings query failed', { error: error.message });
      if (statusRows.length === 0) return this.wrapError(`Помилка бази даних: ${dbErrorText(error)}`);
      warnings.push(`Архів засідань тимчасово недоступний: ${dbErrorText(error)}`);
    }

    // One card per court: the same number passes through first instance, appeal and cassation.
    const cards = new Map<string, any>();
    for (const r of statusRows) {
      const key = caseKey(r.court_name, r.case_number);
      let c = cards.get(key);
      if (!c) {
        c = { court: String(r.court_name ?? '').trim(), case_number: String(r.case_number ?? '').trim(), case_proc: [] as string[],
          registration_date: null, judges: null, participants: null, subject: null, case_type: null,
          stages: [] as any[], _seen: new Set<string>() };
        cards.set(key, c);
      }
      if (r.case_proc && !c.case_proc.includes(r.case_proc)) c.case_proc.push(r.case_proc);
      c.registration_date = keyToIso(r.reg_key) ?? c.registration_date;
      c.judges = r.judges ?? r.judge ?? c.judges;
      c.participants = r.participants ?? c.participants;
      c.subject = r.description ?? c.subject;
      c.case_type = r.case_type ?? c.case_type;
      const stage = { date: keyToIso(r.stage_key), name: r.stage_name ?? null, cause_result: r.cause_result ?? null,
        cause_dep: r.cause_dep ?? null, case_proc: r.case_proc ?? null };
      const sk = `${stage.date}|${stage.name}|${stage.cause_result}|${stage.case_proc}`;
      if (!c._seen.has(sk)) { c._seen.add(sk); c.stages.push(stage); }
    }
    const hearings = dedupeHearings(hearingRows.map(toHearing));
    const today = kyivToday();
    const { last, next } = lastAndNext(hearings, today);

    const caseList = [...cards.values()].map(({ _seen, ...c }) => ({
      ...c,
      last_stage: c.stages[c.stages.length - 1] ?? null,
      stages_count: c.stages.length,
    }));
    const found = caseList.length > 0 || hearings.length > 0;

    return this.wrapResponse({
      status: found ? 'found' : 'not_found',
      message: found
        ? `Справа ${raw}: карток стану розгляду — ${caseList.length}, засідань в архіві — ${hearings.length}.`
        : `Справу ${raw} у відкритих даних не знайдено. Це НЕ означає, що її немає: перевірте номер або court.gov.ua/fair.`,
      case_number: raw,
      ...(courtName ? { court_name: courtName } : {}),
      cases: caseList,
      hearings,
      hearings_total: hearings.length,
      last_hearing: last,
      next_hearing: next,
      next_steps: {
        decisions: `Тексти судових рішень у справі: search_court_decisions з case_number="${raw}"`,
        documents_chain: `Усі документи справи в усіх інстанціях: get_case_documents_chain з case_number="${raw}"`,
      },
      source: this.sourceBlock(src, true),
      as_of: await this.asOf(src, true),
      coverage_note: COVERAGE_NOTE,
      verify: { url: FAIR_URL, note: VERIFY_NOTE },
      ...(warnings.length ? { warnings, incomplete: true } : {}),
    });
  }
}
