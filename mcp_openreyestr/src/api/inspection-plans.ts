/**
 * Плани державного нагляду (контролю) — таблиця inspection_plans (LEXAI-2315).
 *
 * The table holds the annual plans of planned inspections (business name, supervision
 * area, supervisory body, start date, duration in days, plan year). The source rows carry
 * no ЄДРПОУ, so a company is found by its name. Two modes:
 *
 *   - search: substring of the name, supervisory body, supervision area, plan year, dates;
 *   - by ЄДРПОУ: the full name is taken from legal_entities and compared with the plan's
 *     business name after normalisation (case, quotes, apostrophes, whitespace). Rows are
 *     returned only when no other live legal entity in ЄДР has the same normalised name:
 *     on prod (20.11.2026) 6.1% of plan names (761 of 12,539) have 2+ live namesakes
 *     («ТОВ "МРІЯ"» — 96), and in a sample of 20,000 live companies 95 of the 241 whose
 *     exact name appears in the plans had a namesake. Such matches are reported as
 *     ambiguous with the counts, not shown as the company's inspections.
 */
import { Pool } from 'pg';

/** Escape LIKE wildcards (local copy: openreyestr-tools imports this module). */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

/** ЄДР states of an entity that no longer exists (it cannot be the inspected subject of a current plan). */
export const DEAD_STATES = ['припинено', 'скасовано', 'архівний'];

/**
 * SQL expression normalising an organisation name. Quotes are dropped, not unified:
 * plans and ЄДР mix «», "" and typographic quotes, and sometimes quote different words.
 * Apostrophes (’ ʼ `) become ', spaces around a hyphen go, whitespace collapses.
 * Must stay equivalent to normalizePlanName.
 */
export function normPlanNameSql(expr: string): string {
  return `btrim(regexp_replace(regexp_replace(translate(upper(${expr}), '’ʼ\`«»“”„"', ''''''''), '\\s*-\\s*', '-', 'g'), '\\s+', ' ', 'g'))`;
}

/** JS twin of normPlanNameSql, used to build the namesake probe and in tests. */
export function normalizePlanName(s: string): string {
  return String(s ?? '')
    .toUpperCase()
    .replace(/[’ʼ`]/g, "'")
    .replace(/[«»“”„"]/g, '')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Legal-form words: too common to narrow the ЄДР full-text probe. */
const PROBE_STOPWORDS = new Set([
  'ТОВАРИСТВО', 'ОБМЕЖЕНОЮ', 'ДОДАТКОВОЮ', 'ВІДПОВІДАЛЬНІСТЮ', 'ПРИВАТНЕ', 'ПРИВАТНА', 'ПРИВАТНИЙ', 'ПІДПРИЄМСТВО',
  'АКЦІОНЕРНЕ', 'КОМУНАЛЬНЕ', 'КОМУНАЛЬНИЙ', 'КОМУНАЛЬНА', 'ДЕРЖАВНЕ', 'ДЕРЖАВНИЙ', 'ДОЧІРНЄ', 'ФЕРМЕРСЬКЕ',
  'СЕЛЯНСЬКЕ', 'ГОСПОДАРСТВО', 'СІЛЬСЬКОГОСПОДАРСЬКЕ', 'СІЛЬСЬКОГОСПОДАРСЬКИЙ', 'ЗАКЛАД', 'МІСЬКОЇ', 'СІЛЬСЬКОЇ',
  'СЕЛИЩНОЇ', 'РАДИ', 'ОБЛАСНОЇ', 'РАЙОННОЇ',
]);

/**
 * to_tsquery('simple') text that every ЄДР name equal to `name` after normalisation must
 * satisfy, so the GIN index on to_tsvector('simple', name) can narrow the namesake count.
 * Only letter words without an apostrophe are used (the parser splits ім'я differently
 * depending on the apostrophe character); hyphenated words contribute their parts, which
 * the parser also emits. Returns null when no usable word is left.
 */
export function namesakeProbeQuery(name: string): string | null {
  const words = normalizePlanName(name).split(' ').filter((w) => !w.includes("'"));
  const parts = words.flatMap((w) => w.split('-')).filter((w) => /^[A-ZА-ЯІЇЄҐ]{3,}$/u.test(w));
  const distinctive = parts.filter((w) => !PROBE_STOPWORDS.has(w));
  const chosen = [...new Set(distinctive.length ? distinctive : parts)].sort((a, b) => b.length - a.length).slice(0, 4);
  return chosen.length ? chosen.map((w) => w.toLowerCase()).join(' & ') : null;
}

/** dd.mm.yyyy (the plan's text format) → yyyy-mm-dd; anything else → null. */
export function planDateIso(v: unknown): string | null {
  const m = String(v ?? '').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export function formatInspectionPlanRow(r: any): Record<string, unknown> {
  const days = String(r.duration_days ?? '').trim();
  return {
    id: r.id,
    business_name: r.business_name,
    supervisory_body: r.supervisory_body ?? null,
    supervision_area: r.supervision_area ?? null,
    plan_year: r.plan_year ?? null,
    start_date: planDateIso(r.start_date),
    duration_days: /^\d+$/.test(days) ? Number(days) : null,
  };
}

const START_DATE_SQL = `CASE WHEN start_date ~ '^\\d{2}\\.\\d{2}\\.\\d{4}$' THEN to_date(start_date, 'DD.MM.YYYY') END`;
const ROW_COLUMNS = 'id, business_name, supervisory_body, supervision_area, plan_year, start_date, duration_days';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const MATCH_BASIS =
  'Збіг повної назви юрособи з ЄДР після нормалізації (регістр, лапки, апострофи, пробіли); ' +
  'інших чинних юросіб з такою самою назвою в ЄДР немає. Коду ЄДРПОУ в плані перевірок немає.';

export interface InspectionPlanParams {
  query?: string;
  edrpou?: string;
  supervisory_body?: string;
  supervision_area?: string;
  plan_year?: number;
  date_from?: string;
  date_to?: string;
  limit?: number;
  offset?: number;
}

export async function searchInspectionPlans(pool: Pool, params: InspectionPlanParams): Promise<any> {
  const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 100);
  const offset = Math.max(Number(params.offset) || 0, 0);
  const conditions: string[] = [];
  const values: any[] = [];
  const add = (sql: (n: number) => string, v: unknown) => { values.push(v); conditions.push(sql(values.length)); };

  if (params.supervisory_body?.trim()) add((n) => `supervisory_body ILIKE $${n}`, `%${escapeLike(params.supervisory_body.trim())}%`);
  if (params.supervision_area?.trim()) add((n) => `supervision_area ILIKE $${n}`, `%${escapeLike(params.supervision_area.trim())}%`);
  if (params.plan_year != null && Number.isInteger(Number(params.plan_year))) add((n) => `plan_year = $${n}`, Number(params.plan_year));
  if (params.date_from && ISO_DATE.test(params.date_from)) add((n) => `${START_DATE_SQL} >= $${n}::date`, params.date_from);
  if (params.date_to && ISO_DATE.test(params.date_to)) add((n) => `${START_DATE_SQL} <= $${n}::date`, params.date_to);

  const edrpou = params.edrpou != null ? String(params.edrpou).replace(/\D/g, '') : '';
  if (params.edrpou != null && String(params.edrpou).trim() !== '') {
    if (!/^\d{8}$/.test(edrpou)) return [{ found: false, message: 'Вкажіть 8-значний код ЄДРПОУ юридичної особи.' }];
    return byEdrpou(pool, edrpou, conditions, values, limit, offset);
  }

  const query = params.query?.trim();
  if (query) add((n) => `${normPlanNameSql('business_name')} LIKE $${n}`, `%${escapeLike(normalizePlanName(query))}%`);
  if (conditions.length === 0) {
    return [{ found: false, message: 'Вкажіть параметри пошуку: назву суб’єкта, ЄДРПОУ, орган нагляду, сферу або рік плану.' }];
  }

  values.push(limit, offset);
  const res = await pool.query(
    `SELECT ${ROW_COLUMNS}, count(*) OVER () AS _total FROM inspection_plans
     WHERE ${conditions.join(' AND ')}
     ORDER BY ${START_DATE_SQL} NULLS LAST, id
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  if (res.rows.length === 0) return [{ found: false, message: 'Запланованих перевірок за цими параметрами не знайдено.' }];
  return { total_count: Number(res.rows[0]._total), results: res.rows.map(formatInspectionPlanRow) };
}

async function byEdrpou(pool: Pool, edrpou: string, conditions: string[], values: any[], limit: number, offset: number): Promise<any> {
  const ent = await pool.query(`SELECT name, stan FROM legal_entities WHERE edrpou = $1 AND name IS NOT NULL`, [edrpou]);
  if (ent.rows.length === 0) {
    return [{ found: false, edrpou, message: `Код ${edrpou} не знайдено в ЄДР юридичних осіб: без назви з ЄДР плани перевірок (у них немає коду ЄДРПОУ) зіставити неможливо.` }];
  }
  const names = [...new Set(ent.rows.map((r: any) => String(r.name)))];
  const live = ent.rows.some((r: any) => !DEAD_STATES.includes(String(r.stan ?? '').trim()));

  const base = values.length;
  const res = await pool.query(
    `SELECT ${ROW_COLUMNS} FROM inspection_plans
     WHERE ${normPlanNameSql('business_name')} = ANY(SELECT ${normPlanNameSql('x')} FROM unnest($${base + 1}::text[]) AS x)
     ${conditions.length ? `AND ${conditions.join(' AND ')}` : ''}
     ORDER BY ${START_DATE_SQL} NULLS LAST, id`,
    [...values, names],
  );
  const matchedName = names[0];
  if (res.rows.length === 0) {
    return [{ found: false, edrpou, matched_name: matchedName, message: 'У планах перевірок немає записів з повною назвою цієї юрособи.' }];
  }

  // Namesakes: other ЄДР entities with the same normalised full name.
  let otherLive = 0;
  let otherTotal = 0;
  let probed = true;
  for (const name of names) {
    const probe = namesakeProbeQuery(name);
    if (!probe) { probed = false; break; }
    const r = await pool.query(
      `SELECT count(*) FILTER (WHERE coalesce(btrim(stan), '') <> ALL($3::text[])) AS live, count(*) AS total
       FROM legal_entities
       WHERE to_tsvector('simple', name) @@ to_tsquery('simple', $2)
         AND ${normPlanNameSql('name')} = ${normPlanNameSql('$1::text')}
         AND edrpou IS DISTINCT FROM $4`,
      [name, probe, DEAD_STATES, edrpou],
    );
    otherLive += Number(r.rows[0]?.live ?? 0);
    otherTotal += Number(r.rows[0]?.total ?? 0);
  }
  // A dead company is the subject of a plan row only if no other entity, live or dead, has its name.
  const unique = probed && otherLive === 0 && (live || otherTotal === 0);
  if (!unique) {
    const why = !probed
      ? 'назва надто коротка, щоб перевірити, чи немає в ЄДР однойменних юросіб'
      : otherLive
        ? `таку саму назву в ЄДР мають ще інші чинні юрособи (${otherLive})`
        : `юрособа припинена, а таку саму назву в ЄДР мають ще інші юрособи (${otherTotal})`;
    return [{
      found: false,
      ambiguous: true,
      edrpou,
      matched_name: matchedName,
      plan_rows_with_name: res.rows.length,
      ...(probed ? { namesakes_live: otherLive, namesakes_total: otherTotal } : {}),
      message: `Назва «${matchedName}» є в планах перевірок (записів: ${res.rows.length}), але ${why}. ` +
        'Коду ЄДРПОУ в планах немає, тому не можна визначити, якої юрособи стосуються ці перевірки; записи не показано. ' +
        'Їх можна переглянути пошуком за назвою.',
    }];
  }
  const page = res.rows.slice(offset, offset + limit);
  return {
    edrpou,
    matched_name: matchedName,
    match_basis: MATCH_BASIS,
    total_count: res.rows.length,
    results: page.map(formatInspectionPlanRow),
  };
}
