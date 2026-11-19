/**
 * Relations from a full НАЗК declaration (/v2/documents/{id}), LEXAI-2295.
 *
 * Sections, the same numbers in schema versions 1-5 (checked on 2016, 2018, 2021 and 2024
 * documents, 19.11.2026):
 *   step_2  family members: { id, lastname, firstname, middlename, subjectRelation, citizenship,
 *           non_ukraine_identity: { <k>: { nui_last_name, nui_first_name } }, ...hidden IDs }
 *   step_7  securities: { iteration, typeProperty, emitent_ua_company_name, emitent_ua_company_code,
 *           emitent_type, amount, cost, owningDate, rights: [{ rightBelongs, ownershipType }] }
 *   step_8  corporate rights: { iteration, name, corporate_rights_company_code (schema 1-2 may use
 *           regNumber), country, legalForm, cost, cost_percent, owningDate, rights: [...] }
 *   step_9  beneficial ownership:
 *           schema 5:   { company_name_beneficial_owner, ua_company_code_beneficial_owner,
 *                         country_beneficial_owner, legalForm, person_who_care: [{ rightBelongs }] }
 *           schema 1-2: { name, beneficial_owner_company_code, country, legalForm, person }
 * Each step is { isNotApplicable: 0|1, data: [...] } (data is sometimes an object keyed by id).
 *
 * The owner of an entry is rights[].rightBelongs (fallback: person / person_who_care): '1' is the
 * declarant, a step_2 id is a family member, anything else is a third person (kept without name).
 *
 * Hidden values ("[Конфіденційна інформація]", "[Не відомо]", "[Не застосовується]", ...) become
 * NULL. Birth dates, tax/passport/document numbers, УНЗР, addresses, phones and e-mails are
 * never read.
 */
import { uaMatchKey } from '../../services/edr-history/norm';

export interface NazkFamilyMemberRow {
  declaration_id: string;
  declarant_id: number | null;
  declaration_year: number | null;
  member_key: string;
  full_name: string | null;
  lastname: string | null;
  firstname: string | null;
  middlename: string | null;
  name_latin: string | null;
  name_key: string | null;
  relation: string | null;
  citizenship: string | null;
}

export type NazkRightKind = 'securities' | 'corporate_rights' | 'beneficial_owner';

export interface NazkCorporateRightRow {
  declaration_id: string;
  declarant_id: number | null;
  declaration_year: number | null;
  section: 7 | 8 | 9;
  right_kind: NazkRightKind;
  entry_key: string;
  owner_key: string;
  owner_type: 'declarant' | 'family' | 'other';
  owner_name: string | null;
  owner_name_key: string | null;
  owner_relation: string | null;
  company_name: string | null;
  company_name_key: string | null;
  edrpou: string | null;
  company_code_raw: string | null;
  country: string | null;
  legal_form: string | null;
  security_type: string | null;
  ownership_type: string | null;
  share_percent: number | null;
  value: number | null;
  amount: number | null;
  acquired_date: string | null;
  is_beneficial_owner: boolean;
}

export interface NazkRelations {
  familyMembers: NazkFamilyMemberRow[];
  corporateRights: NazkCorporateRightRow[];
}

export const FAMILY_MEMBER_COLUMNS: Array<keyof NazkFamilyMemberRow> = [
  'declaration_id', 'declarant_id', 'declaration_year', 'member_key', 'full_name', 'lastname',
  'firstname', 'middlename', 'name_latin', 'name_key', 'relation', 'citizenship',
];

export const CORPORATE_RIGHT_COLUMNS: Array<keyof NazkCorporateRightRow> = [
  'declaration_id', 'declarant_id', 'declaration_year', 'section', 'right_kind', 'entry_key',
  'owner_key', 'owner_type', 'owner_name', 'owner_name_key', 'owner_relation', 'company_name',
  'company_name_key', 'edrpou', 'company_code_raw', 'country', 'legal_form', 'security_type',
  'ownership_type', 'share_percent', 'value', 'amount', 'acquired_date', 'is_beneficial_owner',
];

const DECLARANT_KEY = '1';
const UKRAINE = '1';

/** A declared text value, or null when it is empty or a NAZK placeholder in brackets. */
export function nazkText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text || /^\[[^\]]*\]$/.test(text)) return null;
  return text;
}

/** "12 345,67" / "25.06" / 12 → number; placeholders → null. */
export function nazkNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = nazkText(value);
  if (text === null) return null;
  const cleaned = text.replace(/[\s ]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return parseFloat(cleaned);
}

/** "31.10.2009" → "2009-10-31"; anything else → null. */
export function nazkDate(value: unknown): string | null {
  const text = nazkText(value);
  const m = text?.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const day = Number(d), month = Number(mo), year = Number(y);
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) return null;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/**
 * ЄДРПОУ code: digits only, zero-padded to 8 ("4012000" → "04012000"). Only for a Ukrainian
 * company (country "1" or not given); a foreign registration number stays in company_code_raw.
 */
export function normalizeEdrpou(code: unknown, country: string | null = null): string | null {
  if (country !== null && country !== UKRAINE) return null;
  const text = nazkText(code);
  if (text === null) return null;
  const digits = text.replace(/[\s -]/g, '');
  if (!/^\d{1,8}$/.test(digits) || /^0+$/.test(digits)) return null;
  return digits.padStart(8, '0');
}

function stepEntries(data: any, step: string): any[] {
  const s = data?.[step];
  if (!s || typeof s !== 'object') return [];
  if (s.isNotApplicable === 1 || s.isNotApplicable === '1') return [];
  const list = s.data;
  if (!list || typeof list !== 'object') return [];
  return (Array.isArray(list) ? list : Object.values(list)).filter(e => e && typeof e === 'object');
}

function joinName(...parts: Array<string | null>): string | null {
  const name = parts.filter(Boolean).join(' ').trim();
  return name || null;
}

function latinName(member: any): string | null {
  const nui = member?.non_ukraine_identity;
  if (!nui || typeof nui !== 'object') return null;
  for (const entry of Object.values<any>(nui)) {
    const name = joinName(nazkText(entry?.nui_last_name), nazkText(entry?.nui_first_name), nazkText(entry?.nui_middle_name));
    if (name) return name;
  }
  return null;
}

/** Owners of an entry: rights[].rightBelongs, else person_who_care[] / person. */
function ownersOf(entry: any): Array<{ key: string; ownershipType: string | null }> {
  const out: Array<{ key: string; ownershipType: string | null }> = [];
  const seen = new Set<string>();
  const add = (key: unknown, ownershipType: unknown) => {
    const k = key === null || key === undefined ? '' : String(key).trim();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ key: k, ownershipType: nazkText(ownershipType) });
  };
  for (const list of [entry.rights, entry.person_who_care]) {
    if (Array.isArray(list)) for (const r of list) add(r?.rightBelongs, r?.ownershipType);
  }
  if (out.length === 0) add(entry.person, null);
  if (out.length === 0) add(DECLARANT_KEY, null);
  return out;
}

export function extractNazkRelations(doc: any): NazkRelations {
  const declarationId = String(doc?.id || doc?.declaration_id || '');
  const empty: NazkRelations = { familyMembers: [], corporateRights: [] };
  if (!declarationId || !doc?.data) return empty;
  const data = doc.data;
  const declarantId = Number(doc.user_declarant_id) || null;
  const declarationYear = Number(doc.declaration_year) || null;
  const base = { declaration_id: declarationId, declarant_id: declarantId, declaration_year: declarationYear };

  const step1 = data.step_1?.data || {};
  const declarantName = joinName(nazkText(step1.lastname), nazkText(step1.firstname), nazkText(step1.middlename))
    || nazkText(doc.user_declarant_full_name);

  const familyMembers: NazkFamilyMemberRow[] = [];
  const members = new Map<string, NazkFamilyMemberRow>();
  for (const m of stepEntries(data, 'step_2')) {
    const key = m.id === null || m.id === undefined ? '' : String(m.id).trim();
    if (!key || members.has(key)) continue;
    const lastname = nazkText(m.lastname);
    const firstname = nazkText(m.firstname);
    const middlename = nazkText(m.middlename);
    const fullName = joinName(lastname, firstname, middlename);
    const row: NazkFamilyMemberRow = {
      ...base,
      member_key: key,
      full_name: fullName,
      lastname, firstname, middlename,
      name_latin: latinName(m),
      name_key: uaMatchKey(fullName) || null,
      relation: nazkText(m.subjectRelation),
      citizenship: nazkText(m.citizenship),
    };
    members.set(key, row);
    familyMembers.push(row);
  }

  const corporateRights: NazkCorporateRightRow[] = [];
  const seen = new Set<string>();
  const push = (
    section: 7 | 8 | 9, kind: NazkRightKind, entry: any, index: number,
    company: Pick<NazkCorporateRightRow, 'company_name' | 'company_code_raw' | 'country' | 'legal_form'
      | 'security_type' | 'share_percent' | 'value' | 'amount' | 'acquired_date'>,
    edrpou: string | null,
  ) => {
    const entryKey = nazkText(entry.iteration) || String(index);
    for (const owner of ownersOf(entry)) {
      const pk = `${section}|${entryKey}|${owner.key}`;
      if (seen.has(pk)) continue;
      seen.add(pk);
      const member = members.get(owner.key);
      const ownerType = owner.key === DECLARANT_KEY ? 'declarant' : member ? 'family' : 'other';
      const ownerName = ownerType === 'declarant' ? declarantName : member ? member.full_name : null;
      corporateRights.push({
        ...base,
        section,
        right_kind: kind,
        entry_key: entryKey,
        owner_key: owner.key,
        owner_type: ownerType,
        owner_name: ownerName,
        owner_name_key: uaMatchKey(ownerName) || null,
        owner_relation: member ? member.relation : null,
        ...company,
        company_name_key: uaMatchKey(company.company_name) || null,
        edrpou,
        ownership_type: owner.ownershipType,
        is_beneficial_owner: section === 9,
      });
    }
  };

  stepEntries(data, 'step_7').forEach((e, i) => {
    // emitent_type "Юридична особа, зареєстрована в Україні" = Ukrainian issuer; a foreign one
    // carries its name/code in the emitent_eng_* fields.
    const ukrainian = !nazkText(e.emitent_type) || /в Україні/i.test(String(e.emitent_type));
    const code = nazkText(e.emitent_ua_company_code) || nazkText(e.emitent_eng_company_code);
    push(7, 'securities', e, i, {
      company_name: nazkText(e.emitent_ua_company_name) || nazkText(e.emitent_eng_company_name)
        || nazkText(e.emitent_ukr_company_name),
      company_code_raw: code,
      country: ukrainian ? UKRAINE : nazkText(e.emitent_eng_company_country) || nazkText(e.country),
      legal_form: null,
      security_type: nazkText(e.typeProperty),
      share_percent: null,
      value: nazkNumber(e.cost),
      amount: nazkNumber(e.amount),
      acquired_date: nazkDate(e.owningDate),
    }, ukrainian ? normalizeEdrpou(nazkText(e.emitent_ua_company_code)) : null);
  });

  stepEntries(data, 'step_8').forEach((e, i) => {
    const country = nazkText(e.country);
    const code = nazkText(e.corporate_rights_company_code) || nazkText(e.regNumber);
    push(8, 'corporate_rights', e, i, {
      company_name: nazkText(e.name) || nazkText(e.en_name),
      company_code_raw: code,
      country,
      legal_form: nazkText(e.legalForm),
      security_type: null,
      share_percent: nazkNumber(e.cost_percent),
      value: nazkNumber(e.cost),
      amount: null,
      acquired_date: nazkDate(e.owningDate),
    }, normalizeEdrpou(code, country));
  });

  stepEntries(data, 'step_9').forEach((e, i) => {
    const country = nazkText(e.country_beneficial_owner) || nazkText(e.country);
    const code = nazkText(e.ua_company_code_beneficial_owner) || nazkText(e.beneficial_owner_company_code)
      || nazkText(e.company_code_beneficial_owner);
    push(9, 'beneficial_owner', e, i, {
      company_name: nazkText(e.company_name_beneficial_owner) || nazkText(e.name)
        || nazkText(e.en_name) || nazkText(e.company_name_eng_beneficial_owner),
      company_code_raw: code,
      country,
      legal_form: nazkText(e.legalForm),
      security_type: null,
      share_percent: null,
      value: null,
      amount: null,
      acquired_date: null,
    }, normalizeEdrpou(code, country));
  });

  return { familyMembers, corporateRights };
}

/** Multi-row INSERT for one table: text with $n placeholders and the flat parameter list. */
export function buildInsert<T>(table: string, columns: Array<keyof T>, rows: T[]): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const tuples = rows.map(row => {
    const ph = columns.map(c => {
      values.push(row[c] ?? null);
      return `$${values.length}`;
    });
    return `(${ph.join(',')})`;
  });
  return { text: `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(',')}`, values };
}
