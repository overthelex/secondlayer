import type { Queryable } from '../db';
import { JUSTICE_KINDS, type Stage } from '../practices';
import { buildAdvocateListQuery, PAGE_SIZE, type AdvocateFilters } from './query';
import { tenant } from '../tenant';

export interface KindCount {
  justiceKind: number;
  name: string;
  cases: number;
}

export interface AdvocateRow {
  sourceId: string;
  familyName: string;
  firstName: string;
  patronymic: string;
  fullName: string;
  status: 'active' | 'suspended' | 'terminated';
  statusDescription: string | null;
  email: string | null;
  phone: string | null;
  workAddress: string | null;
  city: string | null;
  region: string | null;
  orgForms: string | null;
  raName: string | null;
  certificateNum: string | null;
  certificateDate: Date | null;
  decisionNum: string | null;
  decisionDate: Date | null;
  authorityName: string | null;
  stage: Stage;
  nextContactAt: Date | null;
  manualPractices: string[];
  lastContact: Date | null;
  kindCases: number;
  kinds: KindCount[];
  profession: string | null;
  declaredPractices: string[];
  practiceTagsRaw: string[];
  profileUrl: string | null;
  directoryUrl: string | null;
}

type RawRow = Record<string, unknown>;

export function parseKindSummary(summary: string | null | undefined): KindCount[] {
  if (!summary) return [];
  return summary
    .split(',')
    .map((part) => part.split(':'))
    .filter((p) => p.length === 2)
    .map(([k, c]) => {
      const justiceKind = Number(k);
      return { justiceKind, name: JUSTICE_KINDS[justiceKind] ?? `#${justiceKind}`, cases: Number(c) };
    });
}

function mapRow(r: RawRow): AdvocateRow {
  const str = (k: string) => (r[k] == null || r[k] === '' ? null : String(r[k]));
  const date = (k: string) => (r[k] ? new Date(r[k] as string) : null);
  const familyName = String(r.family_name ?? '');
  const firstName = String(r.first_name ?? '');
  const patronymic = String(r.patronymic ?? '');
  return {
    sourceId: String(r.source_id),
    familyName,
    firstName,
    patronymic,
    fullName: [familyName, firstName, patronymic].filter(Boolean).join(' '),
    status: (r.status as AdvocateRow['status']) ?? 'active',
    statusDescription: str('status_description'),
    email: str('email'),
    phone: str('phone'),
    workAddress: str('work_address'),
    city: str('city'),
    region: str('region'),
    orgForms: str('org_forms'),
    raName: str('ra_name'),
    certificateNum: str('certificate_num'),
    certificateDate: date('certificate_date'),
    decisionNum: str('decision_num'),
    decisionDate: date('decision_date'),
    authorityName: str('authority_name'),
    stage: (r.stage as Stage) ?? 'new',
    nextContactAt: date('next_contact_at'),
    manualPractices: Array.isArray(r.manual_practices) ? (r.manual_practices as string[]) : [],
    lastContact: date('last_contact'),
    kindCases: Number(r.kind_cases ?? 0),
    kinds: parseKindSummary(r.kind_summary as string | null),
    profession: str('profession'),
    declaredPractices: Array.isArray(r.declared_practices) ? (r.declared_practices as string[]) : [],
    practiceTagsRaw: Array.isArray(r.practice_tags_raw) ? (r.practice_tags_raw as string[]) : [],
    profileUrl: str('profile_url'),
    directoryUrl: str('directory_url'),
  };
}

export async function listAdvocates(
  pool: Queryable,
  f: AdvocateFilters,
): Promise<{ rows: AdvocateRow[]; total: number; page: number; pageSize: number }> {
  const q = buildAdvocateListQuery(f);
  const [rows, count] = await Promise.all([
    pool.query<RawRow>(q.sql, q.params),
    pool.query<{ total: number }>(q.countSql, q.params),
  ]);
  return { rows: rows.rows.map(mapRow), total: Number(count.rows[0]?.total ?? 0), page: Math.max(1, f.page ?? 1), pageSize: PAGE_SIZE };
}

/** One advocate by source_id, any status (a suspended advocate's page still opens). */
export async function getAdvocate(pool: Queryable, sourceId: string): Promise<AdvocateRow | null> {
  const t = tenant();
  const reg = t.registry;
  const kindSummary = t.derivedPractices
    ? `(SELECT string_agg(ks.justice_kind || ':' || ks.cases, ',' ORDER BY ks.cases DESC)
          FROM (SELECT justice_kind, sum(cases) AS cases FROM attorney_crm_practice_stats s2
                WHERE s2.advocate_source_id = ${reg.idColumn} GROUP BY justice_kind) ks)`
    : 'NULL::text';
  const r = await pool.query<RawRow>(
    `SELECT ${reg.select},
       l.stage, l.next_contact_at, l.manual_practices,
       (SELECT max(n.created_at) FROM attorney_crm_notes n WHERE n.advocate_source_id = ${reg.idColumn}) AS last_contact,
       0 AS kind_cases,
       ${kindSummary} AS kind_summary
     FROM ${reg.table}
     LEFT JOIN attorney_crm_leads l ON l.advocate_source_id = ${reg.idColumn}
     WHERE ${reg.idColumn} = $1
     LIMIT 1`,
    [sourceId],
  );
  return r.rows[0] ? mapRow(r.rows[0]) : null;
}

export interface PracticeProfile {
  kinds: { justiceKind: number; name: string; cases: number; firstYear: number | null; lastYear: number | null }[];
  topCategories: { categoryCode: number; name: string; cases: number }[];
}

export async function getPracticeProfile(pool: Queryable, sourceId: string): Promise<PracticeProfile> {
  if (!tenant().derivedPractices) return { kinds: [], topCategories: [] };
  const kinds = await pool.query<{ justice_kind: number; cases: number; first_year: number | null; last_year: number | null }>(
    `SELECT justice_kind, sum(cases)::int AS cases, min(first_year) AS first_year, max(last_year) AS last_year
       FROM attorney_crm_practice_stats WHERE advocate_source_id = $1
      GROUP BY justice_kind ORDER BY cases DESC`,
    [sourceId],
  );
  const cats = await pool.query<{ category_code: number; name: string | null; cases: number }>(
    `SELECT s.category_code, c.name, sum(s.cases)::int AS cases
       FROM attorney_crm_practice_stats s
       LEFT JOIN edrsr_cause_categories c ON c.category_code = s.category_code
      WHERE s.advocate_source_id = $1 AND s.category_code IS NOT NULL
      GROUP BY s.category_code, c.name ORDER BY cases DESC LIMIT 3`,
    [sourceId],
  );
  return {
    kinds: kinds.rows.map((k) => ({
      justiceKind: k.justice_kind,
      name: JUSTICE_KINDS[k.justice_kind] ?? `#${k.justice_kind}`,
      cases: Number(k.cases),
      firstYear: k.first_year,
      lastYear: k.last_year,
    })),
    topCategories: cats.rows.map((c) => ({ categoryCode: c.category_code, name: c.name ?? `#${c.category_code}`, cases: Number(c.cases) })),
  };
}

// Filter dropdown values: distinct cities/regions among active advocates, cached 1 h.
const CACHE_MS = 3600 * 1000;
const cache = new Map<string, { at: number; values: string[] }>();

async function distinctValues(pool: Queryable, key: string, expr: string, now: number): Promise<string[]> {
  const hit = cache.get(key);
  if (hit && now - hit.at <= CACHE_MS) return hit.values;
  const reg = tenant().registry;
  const r = await pool.query<{ v: string }>(
    `SELECT DISTINCT ${expr} AS v FROM ${reg.table} WHERE ${reg.activeWhere} AND NULLIF(TRIM(${expr}), '') IS NOT NULL ORDER BY 1`,
  );
  const values = r.rows.map((x) => x.v);
  cache.set(key, { at: now, values });
  return values;
}

export function listCities(pool: Queryable, now: number = Date.now()): Promise<string[]> {
  return distinctValues(pool, `${tenant().id}:city`, tenant().registry.citySql, now);
}

export function listRegions(pool: Queryable, now: number = Date.now()): Promise<string[]> {
  return distinctValues(pool, `${tenant().id}:region`, tenant().registry.regionSql, now);
}
