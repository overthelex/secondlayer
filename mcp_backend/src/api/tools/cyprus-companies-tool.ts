/**
 * search_cyprus_companies (LEXAI-2310): the Cyprus register of companies, business names
 * and partnerships (DRCOR, data.gov.cy dataset 1026, CC BY 4.0), loaded monthly into
 * cy_companies / cy_officials / cy_registered_offices (migration 288, scripts/cyprus/load_drcor.py).
 *
 * Search by company name, by registration number (HE123456 / AE1234 / digits) or by the
 * name of an official (director, secretary, partner, owner). Every result carries the
 * snapshot date and source file of each part (company row, registered office, officials),
 * because the loader rewrites a row only when it changed.
 *
 * The register publishes names and positions of officials only: no shareholders, no
 * beneficial owners, no appointment dates or identifiers.
 */
import { BaseToolHandler, ToolDefinition, ToolResult } from '../base-tool-handler.js';
import { logger } from '../../utils/logger.js';
import {
  cyNameKey, cyNameSkeleton, cyNameCore, LEGAL_FORM_WORDS, MIN_SKELETON, parseCyRegistrationNumber, similarity,
} from './cyprus-names.js';

export const CY_SOURCE_NAME =
  'Реєстр компаній, бізнес-назв і партнерств Кіпру (Department of Registrar of Companies and Intellectual Property, DRCOR; data.gov.cy, набір 1026, CC BY 4.0)';
export const CY_DATASET_URL = 'https://www.data.gov.cy/en/dataset/1026';
export const CY_NOTE =
  'Реєстр публікує лише ім’я та посаду посадових осіб, без дат призначення, громадянства й ідентифікаторів; '
  + 'акціонерів і бенефіціарних власників у відкритих даних немає. Статуси й посади перекладено з грецької, оригінал наведено поруч. '
  + 'snapshot_date — дата файлу data.gov.cy, у якому запис востаннє змінився.';

export const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 10;
const MAX_OFFSET = 500;
const MAX_OFFICIALS = 30;
const EXACT_CANDIDATES = 300;

export const ORG_TYPES: Record<string, string> = {
  C: 'Компанія (HE)',
  O: 'Іноземна компанія, зареєстрована на Кіпрі (AE)',
  B: 'Бізнес-назва',
  P: 'Партнерство',
  N: 'Партнерство (старий реєстр BN)',
};

const ORG_TYPE_FILTER: Record<string, string[]> = {
  company: ['C'], overseas: ['O'], business_name: ['B'], partnership: ['P', 'N'],
};

export const SUB_TYPES: Record<string, string> = {
  'Ιδιωτική': 'приватна',
  'Δημόσια': 'публічна',
  'Ομόρρυθμος': 'повне партнерство',
  'Ετερόρρυθμος': 'командитне партнерство',
  'Δι΄ Εγγυήσεως Χωρίς Κεφάλαιο': 'з відповідальністю в межах гарантії, без статутного капіталу',
  'Δι΄ Εγγυήσεως': 'з відповідальністю в межах гарантії',
};

/** Greek status → Ukrainian; `dissolved` marks an organisation no longer on the register. */
export const STATUSES: Record<string, { uk: string; dissolved: boolean }> = {
  'Εγγεγραμμένη': { uk: 'Зареєстрована', dissolved: false },
  'Διαγραμμένη': { uk: 'Виключена з реєстру', dissolved: true },
  'Στάληκε επιστολή Υπενθύμισης': { uk: 'Надіслано лист-нагадування (процедура виключення)', dissolved: false },
  'Δημοσιεύτηκε η Τρίμηνη': { uk: 'Опубліковано тримісячне попередження про виключення', dissolved: false },
  'Διάλυση λόγω Ολοκλήρωσης Εκούσιας Εκκαθάρισης': { uk: 'Розпущена після завершення добровільної ліквідації', dissolved: true },
  'Διάλυση λόγω Ολοκλήρωσης Εκκαθάρισης': { uk: 'Розпущена після завершення ліквідації', dissolved: true },
  'Διαλύθηκε λόγω συγχώνευσης': { uk: 'Розпущена внаслідок злиття', dissolved: true },
  'Εκούσια Εκκαθάριση από Μετόχους': { uk: 'Добровільна ліквідація за рішенням акціонерів', dissolved: false },
  'Εκούσια Εκκαθάριση από Πιστωτές': { uk: 'Добровільна ліквідація за рішенням кредиторів', dissolved: false },
  'Εκκαθάριση με Διάταγμα Δικαστηρίου': { uk: 'Ліквідація за ухвалою суду', dissolved: false },
  'Εκκαθάριση με Διάταγμα Δικαστηρίου& Διορ.Ειδικού Διαχειριστή': { uk: 'Ліквідація за ухвалою суду, призначено спеціального управителя', dissolved: false },
  'Υπο Διαχείριση': { uk: 'Під управлінням (examinership)', dissolved: false },
  'Υπο Διαχείριση & Υπο Εκκαθάριση': { uk: 'Під управлінням і в ліквідації', dissolved: false },
  'Υπο Εκκαθάριση': { uk: 'У ліквідації', dissolved: false },
  'Διορισμός Προσωρινού Εκκαθαριστή': { uk: 'Призначено тимчасового ліквідатора', dissolved: false },
  'Ευρωπαϊκή Εταιρεία': { uk: 'Європейська компанія (SE)', dissolved: false },
  'Αφαιρέθηκε από το Μητρώο ΕΕ με απόφαση Ανωτάτου Δικαστηρίου': { uk: 'Вилучена з реєстру за рішенням Верховного суду', dissolved: true },
};
const DISSOLVED = Object.entries(STATUSES).filter(([, v]) => v.dissolved).map(([k]) => k);

export const POSITIONS: Record<string, string> = {
  'Διευθυντής': 'Директор',
  'Γραμματέας': 'Секретар',
  'Ιδιοκτήτης': 'Власник',
  'Ομόρρυθμος Συνέταιρος': 'Повний партнер',
  'Ετερόρρυθμος Συνέταιρος': 'Партнер-вкладник (командитист)',
  'Αντικαταστάτης Διευθυντής': 'Альтернативний директор',
  'Εξουσιοδοτημένο Πρόσωπο': 'Уповноважена особа',
  'Βοηθός Γραμματέας': 'Помічник секретаря',
  'Αναπληρωτής Γραμματέας': 'Заступник секретаря',
  '': 'Посаду не зазначено',
};

/** Position order in the output: directors first, then secretaries. */
const POSITION_ORDER = Object.keys(POSITIONS);

export type MatchBasis = 'registration_number' | 'exact_name' | 'name' | 'transliteration' | 'official';

interface Db { query(sql: string, params?: any[]): Promise<{ rows: any[] }> }

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

const hasCyrillic = (s: string) => /[А-Яа-яІіЇїЄєҐґ]/.test(s);

/** Words of a name query that narrow a trigram search (≥3 characters, not a legal form). */
export function nameTerms(q: string): string[] {
  const words = cyNameKey(q).split(' ').filter(Boolean);
  const strong = words.filter((w) => w.length >= 3 && !LEGAL_FORM_WORDS.has(w));
  if (strong.length) return [...new Set(strong)].slice(0, 6);
  const any = words.filter((w) => w.length >= 3);
  return any.length ? [...new Set(any)].slice(0, 6) : [];
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** Officials of one organisation, one entry per person with all their positions. */
export function groupOfficials(rows: any[]): any[] {
  const byPerson = new Map<string, { name: string; positions: string[]; positions_original: string[]; snapshot_date: string | null }>();
  for (const r of rows) {
    const key = r.person_name;
    let p = byPerson.get(key);
    if (!p) { p = { name: r.person_name, positions: [], positions_original: [], snapshot_date: iso(r.snapshot_date) }; byPerson.set(key, p); }
    const pos = r.position ?? '';
    if (!p.positions_original.includes(pos)) {
      p.positions_original.push(pos);
      p.positions.push(POSITIONS[pos] ?? pos);
    }
    const d = iso(r.snapshot_date);
    if (d && (!p.snapshot_date || d > p.snapshot_date)) p.snapshot_date = d;
  }
  const rank = (p: { positions_original: string[] }) => Math.min(...p.positions_original.map((x) => {
    const i = POSITION_ORDER.indexOf(x);
    return i < 0 ? POSITION_ORDER.length : i;
  }));
  return [...byPerson.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** One company row (with office columns) and its officials → tool output entry. */
export function companyView(r: any, officials: any[], extra: Record<string, unknown> = {}): any {
  const st = STATUSES[r.status ?? ''];
  const grouped = groupOfficials(officials);
  const office = r.address_seq_no != null && (r.street || r.building || r.territory)
    ? {
      street: r.street || null, building: r.building || null, territory: r.territory || null,
      snapshot_date: iso(r.office_snapshot_date), source_url: r.office_source_url ?? null,
    }
    : null;
  const officialsSource = officials.reduce<{ d: string | null; u: string | null }>((acc, o) => {
    const d = iso(o.snapshot_date);
    return d && (!acc.d || d > acc.d) ? { d, u: o.source_url ?? null } : acc;
  }, { d: null, u: null });
  return {
    registration_code: r.registration_code ?? null,
    registration_no: r.registration_no,
    org_type_code: r.org_type_code,
    org_type: ORG_TYPES[r.org_type_code] ?? r.org_type ?? null,
    org_type_original: r.org_type ?? null,
    org_sub_type: r.org_sub_type ? (SUB_TYPES[r.org_sub_type] ?? r.org_sub_type) : null,
    name: r.name,
    status: st?.uk ?? (r.status || null),
    status_original: r.status || null,
    dissolved: st ? st.dissolved : null,
    status_date: iso(r.status_date),
    registration_date: iso(r.registration_date),
    registered_office: office,
    officials: grouped.slice(0, MAX_OFFICIALS),
    officials_total: grouped.length,
    ...extra,
    source: {
      name: CY_SOURCE_NAME,
      dataset_url: CY_DATASET_URL,
      snapshot_date: iso(r.snapshot_date),
      source_url: r.source_url ?? null,
      officials_snapshot_date: officialsSource.d,
      officials_source_url: officialsSource.u,
    },
  };
}

const COMPANY_COLS = `c.org_type_code, c.registration_no, c.registration_code, c.name, c.org_type, c.org_sub_type,
  c.registration_date, c.status, c.status_date, c.address_seq_no, c.snapshot_date, c.source_url,
  o.street, o.building, o.territory, o.snapshot_date AS office_snapshot_date, o.source_url AS office_source_url`;

export class CyprusCompaniesTool extends BaseToolHandler {
  constructor(private db: Db) {
    super();
  }

  getToolDefinitions(): ToolDefinition[] {
    return [{
      name: 'search_cyprus_companies',
      annotations: { title: 'Реєстр компаній Кіпру (DRCOR)', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: `Пошук у реєстрі компаній Кіпру (DRCOR, відкриті дані data.gov.cy, оновлення щомісяця): компанії (HE), іноземні компанії з кіпрською реєстрацією (AE), бізнес-назви й партнерства, близько 576 тис. записів.

Пошук за назвою компанії (латиницею або грецькою; запит кирилицею шукається за транслітерацією, як назви кіпрських засновників у ЄДР), за реєстраційним номером (HE123456, AE1234 або лише цифри) чи за ім’ям посадової особи.

Для кожної організації: назва, тип, статус (переклад із грецької та оригінал), дата реєстрації й дата статусу, зареєстрований офіс, посадові особи (директори, секретарі, партнери, власники) з посадами; дата знімка й URL файлу джерела окремо для запису компанії, офісу й посадових осіб. Акціонерів і бенефіціарів реєстр не публікує.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Назва компанії або реєстраційний номер (HE123456, AE1234)' },
          registration_number: { type: 'string', description: 'Реєстраційний номер: HE123456, AE1234 або цифри (усі типи організацій з цим номером)' },
          person_name: { type: 'string', description: 'Ім’я посадової особи (директора, секретаря, партнера), латиницею або грецькою' },
          name_match: {
            type: 'string', enum: ['contains', 'exact', 'transliteration'], default: 'contains',
            description: 'contains — усі слова запиту в назві; exact — та сама назва без урахування регістру, розділових знаків і LTD/LIMITED; transliteration — назва, записана кирилицею (типово для запитів кирилицею)',
          },
          status: { type: 'string', enum: ['any', 'active', 'dissolved'], default: 'any', description: 'active — ще в реєстрі (зокрема в ліквідації), dissolved — виключені й розпущені' },
          org_type: { type: 'string', enum: ['any', 'company', 'overseas', 'business_name', 'partnership'], default: 'any', description: 'Тип організації' },
          limit: { type: 'number', default: DEFAULT_LIMIT, description: `Кількість організацій (1–${MAX_LIMIT})` },
          offset: { type: 'number', default: 0, description: `Зсув для пагінації (до ${MAX_OFFSET})` },
        },
      },
    }];
  }

  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    if (name !== 'search_cyprus_companies') return null;
    try {
      return this.wrapResponse(await this.search(args ?? {}));
    } catch (error: any) {
      logger.error('search_cyprus_companies error', { error: error.message });
      return this.wrapError(`Помилка пошуку в реєстрі компаній Кіпру: ${error.message}`);
    }
  }

  async search(args: any): Promise<any> {
    const limit = Math.min(Math.max(Math.trunc(Number(args.limit)) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.min(Math.max(Math.trunc(Number(args.offset)) || 0, 0), MAX_OFFSET);
    const filters = this.filters(args);
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const regInput = typeof args.registration_number === 'string' || typeof args.registration_number === 'number'
      ? String(args.registration_number).trim() : '';
    const person = typeof args.person_name === 'string' ? args.person_name.trim() : '';

    const reg = regInput ? parseCyRegistrationNumber(regInput) : (query ? this.queryAsNumber(query) : null);
    if (regInput && !reg) {
      return { results: [], total_count: 0, message: `«${regInput}» не схоже на кіпрський реєстраційний номер: очікується HE123456, AE1234 або цифри.` };
    }

    let found: { rows: any[]; total: number; basis: MatchBasis; scores?: Map<string, number>; matched?: Map<string, any[]> };
    if (reg) found = await this.byNumber(reg, filters, limit, offset);
    else if (person) {
      if (person.replace(/\s/g, '').length < 3) return { results: [], total_count: 0, message: 'Вкажіть person_name щонайменше з 3 символів.' };
      found = await this.byOfficial(person, filters, limit, offset);
    } else if (query) {
      const mode = args.name_match === 'exact' || args.name_match === 'transliteration' ? args.name_match
        : hasCyrillic(query) ? 'transliteration' : 'contains';
      if (mode === 'transliteration') found = await this.byTransliteration(query, filters, limit, offset);
      else if (mode === 'exact') found = await this.byExactName(query, filters, limit, offset);
      else found = await this.byName(query, filters, limit, offset);
    } else {
      return { results: [], total_count: 0, message: 'Вкажіть query (назва або реєстраційний номер), registration_number або person_name.' };
    }

    const officials = await this.officialsFor(found.rows);
    const results = found.rows.map((r) => {
      const k = `${r.org_type_code}|${r.registration_no}`;
      return companyView(r, officials.get(k) ?? [], {
        match_basis: found.basis,
        ...(found.scores?.has(k) ? { match_score: Number(found.scores.get(k)!.toFixed(2)) } : {}),
        ...(found.matched?.has(k) ? { matched_officials: groupOfficials(found.matched.get(k)!) } : {}),
      });
    });
    const asOf = results.map((r) => r.source.snapshot_date).filter(Boolean).sort().pop() ?? null;
    return {
      ...(query ? { query } : {}), ...(reg ? { registration_number: reg.code ?? reg.digits } : {}), ...(person ? { person_name: person } : {}),
      match_basis: found.basis,
      total_count: found.total,
      returned: results.length,
      offset,
      results,
      ...(results.length ? {} : { message: this.emptyMessage(found.basis) }),
      ...(found.basis === 'transliteration' ? {
        caveat: 'Збіг за транслітерацією: кириличне написання зіставлено з латинським за приголосними й подібністю написання. '
          + 'Це кандидати для перевірки (за номером HE, адресою, посадовими особами), а не встановлена тотожність.',
      } : {}),
      source: { name: CY_SOURCE_NAME, dataset_url: CY_DATASET_URL, as_of: asOf, as_of_basis: 'дата файлу data.gov.cy (snapshot_date)' },
      note: CY_NOTE,
    };
  }

  private emptyMessage(basis: MatchBasis): string {
    switch (basis) {
      case 'registration_number': return 'Організацію з таким реєстраційним номером у реєстрі Кіпру не знайдено.';
      case 'official': return 'Посадових осіб з таким ім’ям у реєстрі Кіпру не знайдено.';
      case 'transliteration': return 'За транслітерацією кириличної назви збігів не знайдено; спробуйте латинське написання.';
      default: return 'Організацій з такою назвою в реєстрі Кіпру не знайдено.';
    }
  }

  /** A query that is only a registration number (HE…/AE… or 4+ digits) is searched as one. */
  private queryAsNumber(q: string) {
    const r = parseCyRegistrationNumber(q);
    if (!r) return null;
    return r.prefix || r.digits.length >= 4 ? r : null;
  }

  private filters(args: any): { sql: string[]; params: any[] } {
    const sql: string[] = [];
    const params: any[] = [];
    if (args.status === 'active') { params.push(DISSOLVED); sql.push(`NOT (c.status = ANY($P${params.length}))`); }
    if (args.status === 'dissolved') { params.push(DISSOLVED); sql.push(`c.status = ANY($P${params.length})`); }
    const types = ORG_TYPE_FILTER[args.org_type];
    if (types) { params.push(types); sql.push(`c.org_type_code = ANY($P${params.length})`); }
    return { sql, params };
  }

  /** WHERE fragments and params, filter placeholders renumbered after `base` params. */
  private where(base: any[], conds: string[], f: { sql: string[]; params: any[] }) {
    const n = base.length;
    const sql = [...conds, ...f.sql.map((s) => s.replace(/\$P(\d+)/g, (_, i) => `$${n + Number(i)}`))];
    return { where: sql.length ? `WHERE ${sql.join(' AND ')}` : '', params: [...base, ...f.params] };
  }

  private async byNumber(reg: NonNullable<ReturnType<typeof parseCyRegistrationNumber>>, f: any, limit: number, offset: number) {
    const cond = reg.code ? 'c.registration_code = $1' : 'c.registration_no = $1';
    const w = this.where([reg.code ?? reg.digits], [cond], f);
    const { rows } = await this.db.query(
      `SELECT ${COMPANY_COLS}, count(*) OVER() AS _total
         FROM cy_companies c LEFT JOIN cy_registered_offices o ON o.address_seq_no = c.address_seq_no
         ${w.where}
         ORDER BY CASE c.org_type_code WHEN 'C' THEN 0 WHEN 'O' THEN 1 ELSE 2 END, c.registration_date DESC NULLS LAST
         LIMIT ${limit} OFFSET ${offset}`,
      w.params,
    );
    return { rows, total: Number(rows[0]?._total ?? 0), basis: 'registration_number' as MatchBasis };
  }

  private async byName(q: string, f: any, limit: number, offset: number) {
    const terms = nameTerms(q);
    if (!terms.length) return { rows: [], total: 0, basis: 'name' as MatchBasis };
    const base: any[] = [q];
    const conds = terms.map((t) => { base.push(`%${escapeLike(t)}%`); return `c.name ILIKE $${base.length}`; });
    const w = this.where(base, conds, f);
    // Exact name first, then names starting with the query, then by trigram similarity.
    const { rows } = await this.db.query(
      `SELECT ${COMPANY_COLS}, count(*) OVER() AS _total
         FROM cy_companies c LEFT JOIN cy_registered_offices o ON o.address_seq_no = c.address_seq_no
         ${w.where}
         ORDER BY (upper(c.name) = upper($1)) DESC, (upper(c.name) LIKE upper($1) || '%') DESC,
                  similarity(c.name, $1) DESC, c.registration_date DESC NULLS LAST
         LIMIT ${limit} OFFSET ${offset}`,
      w.params,
    );
    return { rows, total: Number(rows[0]?._total ?? 0), basis: 'name' as MatchBasis };
  }

  /** Same name up to case, punctuation and LTD/LIMITED: trigram candidates, compared by cyNameKey. */
  private async byExactName(q: string, f: any, limit: number, offset: number) {
    const key = cyNameKey(q);
    const terms = nameTerms(q);
    if (!key || !terms.length) return { rows: [], total: 0, basis: 'exact_name' as MatchBasis };
    const base: any[] = [];
    const conds = terms.map((t) => { base.push(`%${escapeLike(t)}%`); return `c.name ILIKE $${base.length}`; });
    const w = this.where(base, conds, f);
    const { rows } = await this.db.query(
      `SELECT ${COMPANY_COLS}
         FROM cy_companies c LEFT JOIN cy_registered_offices o ON o.address_seq_no = c.address_seq_no
         ${w.where}
         ORDER BY c.registration_date DESC NULLS LAST
         LIMIT ${EXACT_CANDIDATES}`,
      w.params,
    );
    const hits = rows.filter((r) => cyNameKey(r.name) === key);
    return { rows: hits.slice(offset, offset + limit), total: hits.length, basis: 'exact_name' as MatchBasis };
  }

  /**
   * A Cyrillic spelling («ТОЛДЕКС ЛІМІТЕД») against the Latin register: names with the same
   * consonant skeleton (index on cy_name_skeleton(name), migration 294), ranked by how
   * close the spelling of the distinctive words is.
   */
  private async byTransliteration(q: string, f: any, limit: number, offset: number) {
    const skeleton = cyNameSkeleton(q);
    if (skeleton.length < MIN_SKELETON) return { rows: [], total: 0, basis: 'transliteration' as MatchBasis };
    const w = this.where([skeleton], ['cy_name_skeleton(c.name) = $1'], f);
    const { rows } = await this.db.query(
      `SELECT ${COMPANY_COLS}
         FROM cy_companies c LEFT JOIN cy_registered_offices o ON o.address_seq_no = c.address_seq_no
         ${w.where}
         LIMIT ${EXACT_CANDIDATES}`,
      w.params,
    );
    const core = cyNameCore(q);
    const scores = new Map<string, number>();
    for (const r of rows) scores.set(`${r.org_type_code}|${r.registration_no}`, similarity(core, cyNameCore(r.name)));
    const ranked = rows.sort((a, b) => scores.get(`${b.org_type_code}|${b.registration_no}`)! - scores.get(`${a.org_type_code}|${a.registration_no}`)!
      || String(b.registration_date ?? '').localeCompare(String(a.registration_date ?? '')));
    return { rows: ranked.slice(offset, offset + limit), total: ranked.length, basis: 'transliteration' as MatchBasis, scores };
  }

  /** Organisations where a person whose name contains every word of the query is an official. */
  private async byOfficial(person: string, f: any, limit: number, offset: number) {
    const words = person.split(/\s+/).filter((w) => w.length >= 2).slice(0, 5);
    const base: any[] = [];
    const conds = words.map((t) => { base.push(`%${escapeLike(t)}%`); return `p.person_name ILIKE $${base.length}`; });
    const w = this.where(base, conds, f);
    const { rows } = await this.db.query(
      `WITH m AS (
         SELECT p.org_type_code, p.registration_no
           FROM cy_officials p JOIN cy_companies c USING (org_type_code, registration_no)
           ${w.where}
           GROUP BY 1, 2
       )
       SELECT ${COMPANY_COLS}, count(*) OVER() AS _total
         FROM m JOIN cy_companies c USING (org_type_code, registration_no)
         LEFT JOIN cy_registered_offices o ON o.address_seq_no = c.address_seq_no
         ORDER BY (c.status = ANY($${w.params.length + 1})) ASC, c.registration_date DESC NULLS LAST
         LIMIT ${limit} OFFSET ${offset}`,
      [...w.params, DISSOLVED],
    );
    const matched = new Map<string, any[]>();
    if (rows.length) {
      const mp: any[] = [rows.map((r) => r.org_type_code), rows.map((r) => r.registration_no)];
      const mc = words.map((t) => { mp.push(`%${escapeLike(t)}%`); return `p.person_name ILIKE $${mp.length}`; });
      const res = await this.db.query(
        `SELECT p.org_type_code, p.registration_no, p.person_name, p.position, p.snapshot_date, p.source_url
           FROM cy_officials p
           JOIN unnest($1::text[], $2::text[]) AS k(org_type_code, registration_no) USING (org_type_code, registration_no)
          WHERE ${mc.join(' AND ')}`,
        mp,
      );
      for (const r of res.rows) {
        const k = `${r.org_type_code}|${r.registration_no}`;
        if (!matched.has(k)) matched.set(k, []);
        matched.get(k)!.push(r);
      }
    }
    return { rows, total: Number(rows[0]?._total ?? 0), basis: 'official' as MatchBasis, matched };
  }

  private async officialsFor(rows: any[]): Promise<Map<string, any[]>> {
    const out = new Map<string, any[]>();
    if (!rows.length) return out;
    const types = rows.map((r) => r.org_type_code);
    const nos = rows.map((r) => r.registration_no);
    const { rows: off } = await this.db.query(
      `SELECT p.org_type_code, p.registration_no, p.person_name, p.position, p.snapshot_date, p.source_url
         FROM cy_officials p
         JOIN unnest($1::text[], $2::text[]) AS k(org_type_code, registration_no) USING (org_type_code, registration_no)`,
      [types, nos],
    );
    for (const r of off) {
      const k = `${r.org_type_code}|${r.registration_no}`;
      if (!out.has(k)) out.set(k, []);
      out.get(k)!.push(r);
    }
    return out;
  }
}
