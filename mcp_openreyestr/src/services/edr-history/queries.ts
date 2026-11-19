/**
 * Reads over edr_hist (ЄДР history): a company as of a date, its value history, and the
 * history-aware reverse search by founder / beneficial owner (port of forensic
 * ua_edr.as_of / history / founders_named / beneficiaries_named / founder_of).
 */
import { Pool } from 'pg';
import { HISTORY_FIELDS } from './entries';
import { countryIso, uaMatchKey } from './norm';

export const NAME_MATCH_WARNING =
  'Збіг за назвою чи ПІБ — лише наводка: особу чи компанію треба підтвердити іншими даними ' +
  '(код, країна, дата народження, адреса). Збіг за кодом ЄДРПОУ — встановлений факт.';
export const SNAPSHOT_NOTE =
  'first_seen / last_seen — перший і останній завантажений знімок ЄДР, у якому був запис, а не дати ' +
  'набуття чи втрати статусу; між знімками зміни не видно.';
const NOT_LOADED = 'Історію ЄДР ще не завантажено (схема edr_hist порожня).';

const FIELD_LABELS: Record<string, string> = {
  name: 'Назва', short_name: 'Скорочена назва', legal_form: 'ОПФ', status: 'Стан', address: 'Місцезнаходження',
  kved: 'Основний КВЕД', capital: 'Статутний капітал', head: 'Керівник / підписант', founder: 'Засновник',
  beneficiary: 'Кінцевий бенефіціарний власник',
};

const SIMILAR = 0.45;
const MAX_RUNS = 100;

export function isoDate(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, '0'), d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

function isMissingSchema(e: any): boolean {
  return e?.code === '42P01' || e?.code === '3F000';
}

interface SnapshotRow { kind: string; snapshot_date: string; source: string; format: string | null; fields: string[] }

async function snapshots(pool: Pool, kind?: string): Promise<SnapshotRow[]> {
  const r = await pool.query(
    `SELECT kind, to_char(snapshot_date, 'YYYY-MM-DD') AS snapshot_date, source, format, fields
     FROM edr_hist.snapshot ${kind ? 'WHERE kind = $1' : ''} ORDER BY snapshot_date`, kind ? [kind] : []);
  return r.rows;
}

/** YYYY-MM-DD that exists in the calendar (2024-02-31 does not). */
export function isCalendarDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function normEdrpou(s: unknown): string {
  return String(s ?? '').replace(/\D/g, '');
}

/** The company as published in the latest loaded snapshot on or before `date`. */
export async function companyAsOf(pool: Pool, edrpouIn: string, date: string): Promise<any> {
  const edrpou = normEdrpou(edrpouIn);
  if (!/^\d{6,10}$/.test(edrpou)) return { found: false, message: 'Вкажіть код ЄДРПОУ (8 цифр).' };
  if (!isCalendarDate(date)) return { found: false, message: 'Вкажіть дійсну дату у форматі YYYY-MM-DD.' };
  try {
    const co = (await pool.query(`SELECT * FROM edr_hist.company WHERE edrpou = $1`, [edrpou])).rows[0];
    if (!co) return { found: false, edrpou, message: 'Цього коду немає в жодному завантаженому знімку ЄДР.' };
    const snaps = (await snapshots(pool, co.kind)).filter(s => s.snapshot_date <= date).reverse();
    if (!snaps.length) {
      const first = isoDate(co.first_seen);
      return { found: false, edrpou, as_of: date, message: `Немає знімка ЄДР на ${date} або раніше; найраніший знімок із цим кодом — ${first}.` };
    }
    const hist = (await pool.query(
      `SELECT field, value, to_char(first_snapshot, 'YYYY-MM-DD') AS f, to_char(last_snapshot, 'YYYY-MM-DD') AS l
       FROM edr_hist.history_runs WHERE edrpou = $1 ORDER BY field, first_snapshot, value`, [edrpou])).rows;
    const fields: Record<string, any> = {};
    for (const f of HISTORY_FIELDS) {
      const s = snaps.find(x => x.fields.includes(f));
      if (!s) continue;
      const values = hist.filter(h => h.field === f && h.f <= s.snapshot_date && s.snapshot_date <= h.l).map(h => h.value);
      if (values.length) {
        fields[f] = { label: FIELD_LABELS[f], snapshot_date: s.snapshot_date, values };
      }
    }
    const latest = snaps[0];
    const listed = Boolean(fields.name && fields.name.snapshot_date === latest.snapshot_date);
    const carried = Object.entries(fields).filter(([, v]) => v.snapshot_date !== latest.snapshot_date).map(([k]) => k);
    return {
      found: true,
      edrpou,
      as_of: date,
      snapshot: { date: latest.snapshot_date, source: latest.source, format: latest.format },
      listed_in_snapshot: listed,
      fields,
      note: [
        `Стан за відкритими даними ЄДР на знімок ${latest.snapshot_date} (найближчий завантажений не пізніше ${date}; джерело: ${latest.source}).`,
        listed ? '' : 'У цьому знімку суб\'єкта з таким кодом немає (ще не зареєстрований або вже виключений з вивантаження).',
        carried.length ? `Поля ${carried.join(', ')} у цьому знімку не публікувалися; показано значення з останнього знімка, де вони були (дата в snapshot_date поля).` : '',
      ].filter(Boolean).join(' '),
    };
  } catch (e) {
    if (isMissingSchema(e)) return { found: false, message: NOT_LOADED };
    throw e;
  }
}

/** Every value the company had, with the first and last snapshot of each run. */
export async function companyHistory(pool: Pool, edrpouIn: string): Promise<any> {
  const edrpou = normEdrpou(edrpouIn);
  if (!/^\d{6,10}$/.test(edrpou)) return { found: false, message: 'Вкажіть код ЄДРПОУ (8 цифр).' };
  try {
    const co = (await pool.query(`SELECT * FROM edr_hist.company WHERE edrpou = $1`, [edrpou])).rows[0];
    if (!co) return { found: false, edrpou, message: 'Цього коду немає в жодному завантаженому знімку ЄДР.' };
    const snaps = await snapshots(pool, co.kind);
    const hist = (await pool.query(
      `SELECT field, value, to_char(first_snapshot, 'YYYY-MM-DD') AS first_snapshot,
              to_char(last_snapshot, 'YYYY-MM-DD') AS last_snapshot
       FROM edr_hist.history_runs WHERE edrpou = $1 ORDER BY field, first_snapshot, value`, [edrpou])).rows;
    const fields: Record<string, any[]> = {};
    const truncated: Record<string, number> = {};
    for (const f of HISTORY_FIELDS) {
      const runs = hist.filter(h => h.field === f).map(h => ({ value: h.value, first_snapshot: h.first_snapshot, last_snapshot: h.last_snapshot }));
      // joint-stock companies list hundreds of shareholders: keep the latest runs
      if (runs.length > MAX_RUNS) {
        truncated[f] = runs.length;
        runs.sort((a, b) => (b.last_snapshot.localeCompare(a.last_snapshot) || b.first_snapshot.localeCompare(a.first_snapshot)));
        runs.length = MAX_RUNS;
      }
      if (runs.length) fields[f] = runs;
    }
    return {
      found: true,
      edrpou,
      name: co.name,
      status: co.status,
      first_seen: isoDate(co.first_seen),
      last_seen: isoDate(co.last_seen),
      snapshots: snaps.map(s => ({ date: s.snapshot_date, source: s.source, fields: s.fields })),
      fields,
      field_labels: Object.fromEntries(Object.keys(fields).map(f => [f, FIELD_LABELS[f]])),
      truncated: Object.keys(truncated).length
        ? Object.fromEntries(Object.entries(truncated).map(([f, n]) => [f, `показано ${MAX_RUNS} найновіших серій із ${n}`]))
        : undefined,
      note: 'Кожен рядок — безперервна серія завантажених знімків ЄДР (із тих, що публікують це поле), у яких значення було однаковим. ' +
        'Зміна могла статися будь-коли між останнім знімком зі старим значенням і першим — з новим. ' +
        'Знімки воєнного часу не містять адрес і КВЕД, тому ці поля закінчуються на останньому довоєнному знімку.',
    };
  } catch (e) {
    if (isMissingSchema(e)) return { found: false, message: NOT_LOADED };
    throw e;
  }
}

/** difflib-like ratio over the longest common subsequence: 2*LCS / (|a|+|b|). */
export function lcsRatio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]);
      diag = tmp;
    }
  }
  return (2 * prev[b.length]) / (a.length + b.length);
}

/** Every word of the query matches a word of the stored key (same, a prefix, or close spelling). */
export function tokensMatch(q: string, stored: string | null): boolean {
  const sw = (stored || '').split(' ').filter(Boolean);
  return q.split(' ').filter(Boolean).every(w => sw.some(x => x === w
    || (w.length >= 3 && (x.startsWith(w) || w.startsWith(x)))
    || lcsRatio(w, x) >= 0.75));
}

export interface PartySearchParams { query?: string; country?: string; code?: string; current_only?: boolean; limit?: number }

async function searchParty(pool: Pool, table: 'founder' | 'beneficiary', p: PartySearchParams): Promise<any> {
  const limit = Math.min(Math.max(Math.floor(Number(p.limit)) || 50, 1), 200);
  const query = (p.query || '').trim();
  const code = normEdrpou(p.code);
  const countryIn = (p.country || '').trim();
  const cc = countryIn ? countryIso(countryIn) : null;
  if (countryIn && !cc) {
    return { found: false, message: `Країну «${countryIn}» не розпізнано. Вкажіть код ISO (CY, GB, VG) або назву українською, як у ЄДР («Кіпр»).` };
  }
  const key = uaMatchKey(query);
  const byCode = table === 'founder' && code.length >= 6;
  if (!byCode && key.replace(/ /g, '').length < 4 && !(cc && !query)) {
    return {
      found: false,
      message: table === 'founder'
        ? 'Вкажіть query (назва або ПІБ, будь-якою мовою, щонайменше 4 літери), code (ЄДРПОУ засновника) або country.'
        : 'Вкажіть query (ПІБ, будь-якою мовою, щонайменше 4 літери) або country.',
    };
  }

  const where: string[] = [];
  const vals: any[] = [];
  const add = (v: any) => { vals.push(v); return `$${vals.length}`; };
  let simExpr = '1.0';
  if (byCode) where.push(`x.code = ${add(code)}`);
  else if (key) {
    const k = add(key);
    // whole-name similarity, or the query as a word run inside a longer name ("scaramander" in
    // "scaramander holdings limited"); tokensMatch below decides
    where.push(`(x.name_latn % ${k} OR ${k} <% x.name_latn OR x.name_latn = ${k})`);
    simExpr = `GREATEST(similarity(x.name_latn, ${k}), word_similarity(${k}, x.name_latn))`;
  }
  if (cc) where.push(`x.country_code = ${add(cc)}`);
  if (table === 'beneficiary') where.push('x.name IS NOT NULL');
  if (p.current_only) where.push('x.last_seen = c.last_seen');
  const lim = add(byCode || !key ? limit : limit * 3);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL pg_trgm.similarity_threshold = ${SIMILAR}`);
    await client.query(`SET LOCAL pg_trgm.word_similarity_threshold = 0.6`);
    await client.query(`SET LOCAL statement_timeout = '30s'`);
    const rows = (await client.query(
      `SELECT x.*, ${simExpr} AS sim, c.name AS company_name, c.status AS company_status, c.kind AS company_kind,
              to_char(x.first_seen, 'YYYY-MM-DD') AS first_seen_d, to_char(x.last_seen, 'YYYY-MM-DD') AS last_seen_d,
              (x.last_seen = c.last_seen) AS current
       FROM edr_hist.${table} x LEFT JOIN edr_hist.company c USING (edrpou)
       WHERE ${where.join(' AND ')}
       ORDER BY sim DESC, x.last_seen DESC, x.edrpou LIMIT ${lim}`, vals)).rows;
    await client.query('COMMIT');
    const snaps = await snapshots(pool);

    const out = [];
    for (const r of rows) {
      let match: string;
      if (byCode) match = 'код ЄДРПОУ (факт)';
      else if (!key) match = 'країна';
      else if (r.name_latn === key || [...key.split(' ')].sort().join(' ') === (r.name_latn || '').split(' ').sort().join(' ')) match = 'точний збіг імені (наводка)';
      else if (tokensMatch(key, r.name_latn)) match = 'схожий запис імені (слабка наводка)';
      else continue;
      const base: Record<string, unknown> = {
        edrpou: r.edrpou,
        company_name: r.company_name,
        company_status: r.company_status,
        name: r.name,
        country: r.country,
        country_code: r.country_code,
        first_seen: r.first_seen_d,
        last_seen: r.last_seen_d,
        current: Boolean(r.current),
        match,
      };
      if (table === 'founder') Object.assign(base, { founder_kind: r.kind, code: r.code, contribution: r.contribution });
      else Object.assign(base, { influence: r.influence, share: r.share });
      out.push(base);
      if (out.length >= limit) break;
    }
    if (!snaps.length) return { found: false, message: NOT_LOADED };
    const seen = new Map<string, string>();
    for (const s of snaps) seen.set(s.snapshot_date, s.source);
    return {
      found: out.length > 0,
      query: query || undefined,
      match_key: key || undefined,
      code: byCode ? code : undefined,
      country: cc || undefined,
      results: out,
      snapshots: [...seen.entries()].map(([date, source]) => ({ date, source })),
      warning: NAME_MATCH_WARNING,
      note: SNAPSHOT_NOTE + ' current = запис є в останньому знімку, де є ця юрособа.',
      message: out.length ? undefined : 'У завантажених знімках ЄДР збігів не знайдено.',
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (isMissingSchema(e)) return { found: false, message: NOT_LOADED };
    throw e;
  } finally {
    client.release();
  }
}

export function searchFoundersHistory(pool: Pool, p: PartySearchParams): Promise<any> {
  return searchParty(pool, 'founder', p);
}

export function searchBeneficiariesHistory(pool: Pool, p: PartySearchParams): Promise<any> {
  return searchParty(pool, 'beneficiary', { ...p, code: undefined });
}
