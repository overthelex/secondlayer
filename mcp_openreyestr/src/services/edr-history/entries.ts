/**
 * Free-text entries of the ЄДР dumps (founders, beneficiaries, signers) -> parsed fields,
 * and the per-field history values of one subject. Port of forensic
 * app/registers/ua_edr.py (parse_founder, parse_beneficiary, parse_head, history_values),
 * extended with the unlabelled 2020-2022 shapes checked on the 25.10.2021 dump:
 *   founder      'NAME, [CODE,] COUNTRY, COUNTRY, ADDRESS, розмір внеску до статутного фонду - N грн.'
 *   beneficiary  'NAME; COUNTRY; ADDRESS'
 *   old КБВ      'КІНЦЕВИЙ БЕНЕФІЦІАРНИЙ ВЛАСНИК (КОНТРОЛЕР) [-] NAME, ...' among the founders
 * Current dumps (2026):
 *   founder      'NAME; [CODE;] резиденство|громадянство: COUNTRY; розмір частки - N грн.'
 *   beneficiary  'NAME; громадянство: X; Прямий|Непрямий вирішальний вплив; відсоток частки - N'
 * Parsing is best effort; the raw text is always kept.
 */
import { createHash } from 'crypto';
import { countryIso, historyNameKey, normUa, uaMatchKey } from './norm';

export const HISTORY_FIELDS = [
  'name', 'short_name', 'legal_form', 'status', 'address', 'kved', 'capital', 'head', 'founder', 'beneficiary',
] as const;
export type HistoryField = (typeof HISTORY_FIELDS)[number];

export function md5(s: string): string {
  return createHash('md5').update(s, 'utf8').digest('hex');
}

export function clean(s: string | null | undefined): string | null {
  const t = (s || '').split(/\s+/).filter(Boolean).join(' ');
  return t || null;
}

const DATE = /\b(\d{2})\.(\d{2})\.(\d{4})\b/;

/** First dd.mm.yyyy in the text as an ISO date, or null. */
export function uaDate(s: string | null | undefined): string | null {
  const m = DATE.exec(s || '');
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** '9405,00 грн.' -> 9405, '1 000 000.50' -> 1000000.5. */
export function amount(s: string | null | undefined): number | null {
  const m = /\d[\d\s]*(?:[.,]\d+)?/.exec(s || '');
  if (!m) return null;
  const n = Number(m[0].replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const ORG_WORDS = new RegExp(
  'ТОВАРИСТВ|КОМПАН|ПІДПРИЄМСТВ|КОРПОРАЦ|ЛІМІТЕД|(?:^|[^\\p{L}])(?:ЛТД|LTD|INC|LLC|ТОВ|ПП|АТ|ПАТ|ПРАТ|ЗАТ|ВАТ|РАДА)(?![\\p{L}])|' +
  'LIMITED|GMBH|ГМБХ|ФОНД|ОРГАНІЗАЦ|УПРАВЛІНН|МІНІСТЕРСТВ|ДЕРЖАВ|КООПЕРАТИВ|ОБ.ЄДНАННЯ|АСОЦІАЦ|БАНК|"|ФІРМА|' +
  'СПІЛКА|ХОЛДИНГ|HOLDING|ІНВЕСТ|GROUP|КОЛЕКТИВ|СПІЛЬН|ГОСПОДАРСТВ|ХОЛДІНГ',
  'iu',
);
const COUNTRY_LABEL = /(?:країна\s+(?:резиден[\p{L}]*|громадянства)|резиден[\p{L}]*ство|громадянство)\s*[:\-]\s*([^;,]+)/iu;
const CONTRIB = /розмір\s+(?:внеску|частки)[^\d\-:]*[-:]\s*([\d\s.,]+(?:\s*(?:грн\.?|гривень|UAH|USD|EUR))?)/iu;
const CODE = /(?:код\s+(?:за\s+)?ЄДРПОУ|ідентифікаційний\s+код[^:\d]*)\s*[:\-]?\s*(\d{6,10})/iu;
const COMMA_LABEL = /,\s*(?=(?:код\s|ідентифікаційний\s+код|країна\s|місцезнаходження|адреса|розмір\s|громадянство|резиден))/iu;
const LABELLED = /,\s*(?:код\s|ідентифікаційний\s+код|країна\s|місцезнаходження|адреса|громадянство|резиден)/iu;
const UBO_OLD = /^\s*(?:КІНЦЕВИЙ\s+)?БЕНЕФІЦІАРН[\p{L}]*\s+ВЛАСНИК[\p{L}]*(?:\s*\(КОНТРОЛЕР[\p{L}]*\))?(?:\s+(?:ЗАСНОВНИКА|ЮРИДИЧНОЇ)[^-–:]*?(?=\s*[-–:]))?\s*[-–:]?\s*/iu;
const REASON = /^\s*(?:причина\s+відсутності|відомості\s+про\s+кінцевого\s+бенефіціарного\s+власника\s+\S*\s*відсутні)/iu;
const ABSENT = /ВІДСУТН/iu;

export interface Founder {
  name: string | null;
  kind: 'person' | 'organisation';
  code: string | null;
  country: string | null;
  contribution: string | null;
  contribution_uah: number | null;
}

export function parseFounder(raw: string): Founder {
  const t = clean(raw) || '';
  let name: string | null = null;
  let code: string | null = null;
  let country: string | null = null;
  let contribution: string | null = null;
  let label: string | null = null;

  if (t.includes(';')) {
    const segs = t.split(';').map(s => s.trim());
    name = segs[0] || null;
    for (const s of segs.slice(1)) {
      if (!s) continue;
      let m = /^(громадянство|резиден[\p{L}]*ство|країна\s+[\p{L}]+)\s*[:\-]\s*(.+)$/iu.exec(s);
      if (m) { label = m[1].toLowerCase(); country = m[2].trim(); continue; }
      m = /^розмір\s+(?:частки|внеску)[^\d\-:]*[-:]\s*(.+)$/iu.exec(s);
      if (m) { contribution = m[1].trim(); continue; }
      if (/^(?:місцезнаходження|адреса[^:]*|місце\s+проживання)\s*:/iu.test(s)) continue;
      if (code === null && !s.includes(':') && s.length <= 40) {
        if (!country && countryIso(s)) country = s; else code = s;
      }
    }
  } else if (LABELLED.test(t)) {
    // 2016-2019: 'NAME, код ЄДРПОУ X, країна резиденства: Y, місцезнаходження: ..., розмір внеску ...'
    const m = COMMA_LABEL.exec(t)!;
    name = t.slice(0, m.index).replace(/^[\s,]+|[\s,]+$/g, '') || null;
    const c = CODE.exec(t); if (c) code = c[1];
    const cl = COUNTRY_LABEL.exec(t);
    if (cl) { country = cl[1].trim(); label = /громадян/i.test(cl[0]) ? 'громадянство' : 'резиденство'; }
    const ct = CONTRIB.exec(t); if (ct) contribution = ct[1].replace(/^[\s,]+|[\s,]+$/g, '');
  } else {
    // 2020-2022: 'NAME, [CODE,] COUNTRY, COUNTRY, ADDRESS..., розмір внеску до статутного фонду - N грн.'
    const ct = CONTRIB.exec(t);
    if (ct) contribution = ct[1].replace(/^[\s,]+|[\s,]+$/g, '');
    const body = ct ? t.slice(0, ct.index) : t;
    const parts = body.split(',').map(s => s.trim());
    name = parts[0] || null;
    let i = 1;
    if (parts[i] && /^\d{6,10}$/.test(parts[i])) code = parts[i++];
    if (parts[i] && countryIso(parts[i])) country = parts[i];
    else if (parts[i] && parts[i].length <= 20 && /\d/.test(parts[i]) && parts[i + 1] && countryIso(parts[i + 1])) {
      code = parts[i];          // a foreign registration number before the country
      country = parts[i + 1];
    }
  }

  const nm = name || '';
  let kind: Founder['kind'];
  if ((label && label.includes('резиден')) || (code && /^\d{8}$/.test(code)) || ORG_WORDS.test(nm)) kind = 'organisation';
  else if (label && label.includes('громадян')) kind = 'person';
  else {
    const words = nm.split(/\s+/).filter(Boolean).length;
    kind = words >= 2 && words <= 4 && !/\d/.test(nm) ? 'person' : 'organisation';
  }
  const contribution_uah = contribution && !/USD|EUR/i.test(contribution) ? amount(contribution) : null;
  return { name, kind, code, country, contribution, contribution_uah };
}

/**
 * Statements written into a FOUNDER element that name nobody, e.g. 2018-2019
 * 'ЗАСНОВНИК Є КІНЦЕВИМ БЕНЕФІЦІАРНИМ ВЛАСНИКОМ (КОНТРОЛЕРОМ) ЮРИДИЧНОЇ ОСОБИ'.
 */
export function isStatement(raw: string | null | undefined): boolean {
  return /^\s*ЗАСНОВНИК[\p{L}]*\s+Є\s/iu.test(raw || '');
}

export function isOldBeneficiary(raw: string | null | undefined): boolean {
  return /^\s*(?:КІНЦЕВИЙ\s+)?БЕНЕФІЦІАРН[\p{L}]*\s+ВЛАСНИК/iu.test(raw || '');
}

export interface Beneficiary {
  name: string | null;
  country: string | null;
  influence: string | null;
  share: string | null;
  reason: string | null;
}

export function parseBeneficiary(raw: string): Beneficiary {
  let t = clean(raw) || '';
  const out: Beneficiary = { name: null, country: null, influence: null, share: null, reason: null };
  if (REASON.test(t)) {
    out.reason = t.includes(':') ? t.split(':').slice(1).join(':').trim() : t;
    return out;
  }
  const old = UBO_OLD.exec(t);
  if (old && isOldBeneficiary(t)) {
    // older dumps: free text after the prefix, 'NAME, COUNTRY, address' at best
    t = t.slice(old[0].length);
    if (!t || ABSENT.test(t.split(',')[0])) { out.reason = t || null; return out; }
    const cl = COUNTRY_LABEL.exec(t);
    if (cl) out.country = cl[1].trim();
    const parts = t.split(',').map(s => s.trim());
    let first = parts[0];
    const dash = first.split(/\s[-–]\s?/);
    if (dash.length > 1) first = dash[dash.length - 1].trim();
    const words = first.split(/\s+/).filter(Boolean);
    out.name = words.length && words.length <= 5 ? first : null;
    if (!out.country && parts[1] && countryIso(parts[1])) out.country = parts[1];
    return out;
  }
  if (t.includes(';')) {
    const segs = t.split(';').map(s => s.trim());
    out.name = segs[0] || null;
    const infl: string[] = [];
    let positionalCountry = false;
    for (const s of segs.slice(1)) {
      if (!s) continue;
      let m = /^(?:громадянство|країна\s+громадянства|резиден[\p{L}]*ство)\s*[:\-]\s*(.+)$/iu.exec(s);
      if (m) { out.country = m[1].trim(); continue; }
      m = /^відсоток\s+частки[^-]*-\s*(.+)$/iu.exec(s);
      if (m) { out.share = m[1].trim(); continue; }
      m = /^інший\s+характер[^:]*:\s*(.+)$/iu.exec(s);
      if (m) { infl.push(m[1].trim()); continue; }
      if (/^(?:місцезнаходження|адреса|місце\s+проживання)[^:]*:/iu.test(s)) continue;
      if (!out.country && countryIso(s)) { out.country = s; positionalCountry = true; continue; }
      // 2020-2022: the segment after the country is the address
      if (positionalCountry || /\d/.test(s)) continue;
      infl.push(s);
    }
    if (infl.length) out.influence = infl.join('; ');
  } else {
    const cl = COUNTRY_LABEL.exec(t);
    if (cl) out.country = cl[1].trim();
    const parts = t.split(',').map(s => s.trim());
    out.name = parts[0] || null;
    if (!out.country && parts[1] && countryIso(parts[1])) out.country = parts[1];
  }
  return out;
}

export type HeadSource = 'signer' | 'member' | 'boss';
export type RoleClass = 'head' | 'representative' | 'member' | 'liquidator' | 'other';

export interface Head {
  name: string | null;
  role: string | null;
  role_class: RoleClass;
  appointed_on: string | null;
}

export function roleClass(role: string | null | undefined): RoleClass {
  const r = (role || '').toLowerCase();
  if (r.includes('комісії') || r.includes('ліквідатор') || r.includes('розпорядник') || r.includes('керуючий санацією')) return 'liquidator';
  if (r.includes('представник')) return 'representative';
  if (r.includes('член')) return 'member';
  if (!r || r.includes('керівник') || r.includes('директор') || r.includes('голова') || r.includes('президент')) return 'head';
  return 'other';
}

/**
 * SIGNER 'NAME; 23.02.2011; (згідно статуту) - керівник', 'NAME; DATE - керівник',
 * 'NAME ; КЕРІВНИК ФІЛІЇ; 11.12.2024', MEMBER 'NAME; ЧЛЕН РАДИ', BOSS 'NAME'.
 */
export function parseHead(raw: string, source: HeadSource): Head {
  let t = clean(raw) || '';
  let role: string | null = null;
  const m = /\s[-–]\s*([^-–;()]+)$/.exec(t);
  if (m && source !== 'member') {
    role = m[1].trim();
    t = t.slice(0, m.index);
  }
  const segs = t.split(';').map(s => s.trim());
  let name: string | null = segs[0] || null;
  for (const s of segs.slice(1)) {
    if (role === null && s && !DATE.test(s) && !s.startsWith('(')) role = s;
  }
  if (source === 'boss' && name && name.includes(' - ')) {
    const i = name.indexOf(' - ');
    role = name.slice(i + 3);
    name = name.slice(0, i);
  }
  return { name, role, role_class: roleClass(role), appointed_on: uaDate(t) };
}

/** A subject as read from any dump format. */
export interface EdrSubject {
  kind: 'uo' | 'fsu';
  record: string | null;
  edrpou: string;
  name: string | null;
  short_name: string | null;
  legal_form: string | null;
  status: string | null;
  address: string | null;
  kved: string | null;
  capital: string | null;
  registered_on: string | null;
  founders: string[];
  beneficiaries: string[];
  heads: Array<[HeadSource, string]>;
}

export interface FounderRow extends Founder { raw: string; hash: string; name_latn: string | null; country_code: string | null }
export interface BeneficiaryRow extends Beneficiary { raw: string; hash: string; name_latn: string | null; country_code: string | null }
export interface HeadRow extends Head { raw: string; source: HeadSource; hash: string; name_latn: string | null }

export function entryRows(s: EdrSubject): { founders: FounderRow[]; beneficiaries: BeneficiaryRow[]; heads: HeadRow[] } {
  const founders = s.founders.map(raw => {
    const p = parseFounder(raw);
    return { ...p, raw, hash: md5(raw), name_latn: uaMatchKey(p.name) || null, country_code: countryIso(p.country) };
  });
  const beneficiaries = s.beneficiaries.map(raw => {
    const p = parseBeneficiary(raw);
    return { ...p, raw, hash: md5(raw), name_latn: uaMatchKey(p.name) || null, country_code: countryIso(p.country) };
  });
  const heads = s.heads.map(([source, raw]) => {
    const p = parseHead(raw, source);
    return { ...p, raw, source, hash: md5(`${source}|${raw}`), name_latn: uaMatchKey(p.name) || null };
  });
  return { founders, beneficiaries, heads };
}

const STATUS_RANK: Record<string, number> = {
  'зареєстровано': 0, 'зареєстровано свідоцтво про державну реєстрацію недійсне': 1,
  'в стані припинення': 2, 'порушено справу про банкрутство': 2,
  'порушено справу про банкрутство санація': 2, 'припинено': 3, 'скасовано': 4,
};

/** Lower is more alive; used to pick one subject when a code repeats inside a dump. */
export function statusRank(status: string | null | undefined): number {
  return STATUS_RANK[normUa(status)] ?? 5;
}

/**
 * History key of an address. The same address is written differently across eras
 * ('04212, м.Київ, Оболонський район, ВУЛИЦЯ X, будинок 3, квартира 256' in 2018,
 * 'Україна, 04212, місто Київ, ВУЛИЦЯ X, будинок 3, квартира 256' in 2021), so the key is the
 * sequence of numbers (postcode, house, flat) when there are any; a company moving to an address
 * with exactly the same numbers is not seen as a move. The published text is kept as the value.
 */
export function addressKey(v: string): string {
  const nums = v.match(/\d+/g);
  if (nums && nums.length) return `#${nums.join(' ')}`;
  return normUa(v).replace(/(^| )україна( |$)/g, ' ').trim();
}

export interface HistoryValue { field: HistoryField; value_hash: string; value: string }

/**
 * (field, value_hash, value) of one subject in one snapshot. Keys are normalised so that
 * the same value written in another dump format is the same value.
 */
export function historyValues(
  s: EdrSubject, founders: FounderRow[], beneficiaries: BeneficiaryRow[], heads: HeadRow[],
): HistoryValue[] {
  const out: HistoryValue[] = [];
  for (const f of ['name', 'short_name', 'legal_form', 'status', 'address', 'kved', 'capital'] as const) {
    const v = s[f];
    if (!v) continue;
    if (f === 'short_name' && ['не має', 'немає', 'відсутнє'].includes(normUa(v))) continue;
    let key: string;
    if (f === 'kved') key = v.split(' ')[0];
    else if (f === 'capital') key = String(amount(v));
    else if (f === 'address') key = addressKey(v);
    else key = normUa(v);
    out.push({ field: f, value_hash: md5(key || normUa(v)).slice(0, 16), value: v });
  }
  for (const h of heads) {
    if (h.name_latn) {
      out.push({ field: 'head', value_hash: md5(`${h.role_class}|${historyNameKey(h.name)}`).slice(0, 16), value: `${h.name} (${h.role || h.role_class})` });
    }
  }
  for (const f of founders) {
    if (f.name_latn || f.code) {
      // by name: older dumps rarely give a foreign founder's registration number
      out.push({ field: 'founder', value_hash: md5(historyNameKey(f.name) || `code ${f.code}`).slice(0, 16), value: (f.name || f.code || '') + (f.country ? ` (${f.country})` : '') });
    }
  }
  for (const b of beneficiaries) {
    if (b.name_latn) {
      out.push({ field: 'beneficiary', value_hash: md5(historyNameKey(b.name)).slice(0, 16), value: (b.name || '') + (b.country ? ` (${b.country})` : '') });
    }
  }
  const seen = new Set<string>();
  return out.filter(x => {
    const k = `${x.field}|${x.value_hash}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
