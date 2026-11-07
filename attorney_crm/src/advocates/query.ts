import { ACTIVE_WHERE, ADVOCATE_SELECT, CITY_SQL, REGION_SQL } from './registry-sql';
import { STAGES } from '../practices';

export const PAGE_SIZE = 50;

export type SortKey = 'surname' | 'city' | 'region' | 'cases' | 'last_contact' | 'next_contact';

export interface AdvocateFilters {
  surnamePrefix?: string;
  city?: string;
  region?: string;
  justiceKind?: number;
  manualPractice?: string;
  stage?: string;
  sort?: SortKey;
  dir?: 'asc' | 'desc';
  page?: number;
}

/** Backslash-escapes LIKE metacharacters so user text matches literally. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

const SORTS: Record<SortKey, string> = {
  surname: 'a.family_name',
  city: `${CITY_SQL}`,
  region: `${REGION_SQL}`,
  cases: 'ps.cases',
  last_contact: 'nt.last_contact',
  next_contact: 'l.next_contact_at',
};

const DEFAULT_DIR: Record<SortKey, 'ASC' | 'DESC'> = {
  surname: 'ASC',
  city: 'ASC',
  region: 'ASC',
  cases: 'DESC',
  last_contact: 'DESC',
  next_contact: 'ASC',
};

export function buildAdvocateListQuery(f: AdvocateFilters): { sql: string; countSql: string; params: unknown[] } {
  const params: unknown[] = [];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  // $1 is always the justice kind (or NULL) for the practice-stats lateral.
  const kindParam = add(f.justiceKind ?? null);

  const where: string[] = [ACTIVE_WHERE];
  if (f.surnamePrefix?.trim()) where.push(`a.family_name ILIKE ${add(escapeLike(f.surnamePrefix.trim()) + '%')}`);
  if (f.city?.trim()) where.push(`${CITY_SQL} = ${add(f.city.trim())}`);
  if (f.region?.trim()) where.push(`${REGION_SQL} = ${add(f.region.trim())}`);
  if (f.justiceKind) where.push('ps.cases > 0');
  if (f.manualPractice?.trim()) where.push(`${add(f.manualPractice.trim())} = ANY(l.manual_practices)`);
  if (f.stage && (STAGES as readonly string[]).includes(f.stage)) {
    where.push(f.stage === 'new' ? "(l.stage IS NULL OR l.stage = 'new')" : `l.stage = ${add(f.stage)}`);
  }

  const sortKey: SortKey = f.sort && f.sort in SORTS ? f.sort : 'surname';
  const dir = f.dir === 'asc' ? 'ASC' : f.dir === 'desc' ? 'DESC' : DEFAULT_DIR[sortKey];
  const nulls = dir === 'DESC' ? 'NULLS LAST' : 'NULLS LAST';
  const orderBy =
    sortKey === 'surname'
      ? `ORDER BY a.family_name ${dir}, a.name ${dir}, a.additional_name ${dir}`
      : `ORDER BY ${SORTS[sortKey]} ${dir} ${nulls}, a.family_name ASC, a.name ASC`;

  const page = Math.max(1, Math.floor(f.page ?? 1));
  const offset = (page - 1) * PAGE_SIZE;

  const from = `
  FROM opendata_advocates a
  LEFT JOIN attorney_crm_leads l ON l.advocate_source_id = a.source_id
  LEFT JOIN LATERAL (
    SELECT max(n.created_at) AS last_contact FROM attorney_crm_notes n WHERE n.advocate_source_id = a.source_id
  ) nt ON true
  LEFT JOIN LATERAL (
    SELECT coalesce(sum(s.cases), 0)::int AS cases FROM attorney_crm_practice_stats s
    WHERE s.advocate_source_id = a.source_id AND (${kindParam}::int IS NULL OR s.justice_kind = ${kindParam}::int)
  ) ps ON true
  WHERE ${where.join(' AND ')}`;

  const sql = `SELECT ${ADVOCATE_SELECT},
  l.stage, l.next_contact_at, l.manual_practices, nt.last_contact, ps.cases AS kind_cases,
  (SELECT string_agg(ks.justice_kind || ':' || ks.cases, ',' ORDER BY ks.cases DESC)
     FROM (SELECT justice_kind, sum(cases) AS cases FROM attorney_crm_practice_stats s2
           WHERE s2.advocate_source_id = a.source_id GROUP BY justice_kind) ks) AS kind_summary
  ${from}
  ${orderBy}
  LIMIT ${PAGE_SIZE} OFFSET ${offset}`;

  const countSql = `SELECT count(*)::int AS total ${from}`;
  return { sql, countSql, params };
}
