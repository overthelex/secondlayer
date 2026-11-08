import { STAGES } from '../practices';
import { tenant } from '../tenant';
import type { RegistryAdapter } from '../tenant/types';

export const PAGE_SIZE = 50;

export type SortKey = 'surname' | 'city' | 'region' | 'cases' | 'last_contact' | 'next_contact';

export interface AdvocateFilters {
  surnamePrefix?: string;
  city?: string;
  region?: string;
  profession?: string;
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

const DEFAULT_DIR: Record<SortKey, 'ASC' | 'DESC'> = {
  surname: 'ASC',
  city: 'ASC',
  region: 'ASC',
  cases: 'DESC',
  last_contact: 'DESC',
  next_contact: 'ASC',
};

export function buildAdvocateListQuery(
  f: AdvocateFilters,
  r: RegistryAdapter = tenant().registry,
  derived: boolean = tenant().derivedPractices,
): { sql: string; countSql: string; params: unknown[] } {
  const params: unknown[] = [];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  // $1 is always the justice kind (or NULL) for the practice-stats lateral.
  const kindParam = add(derived ? (f.justiceKind ?? null) : null);

  const sorts: Record<SortKey, string> = {
    surname: r.surnameColumn,
    city: r.citySql,
    region: r.regionSql,
    cases: 'ps.cases',
    last_contact: 'nt.last_contact',
    next_contact: 'l.next_contact_at',
  };

  const where: string[] = [r.activeWhere];
  if (f.surnamePrefix?.trim()) where.push(`${r.surnameColumn} ILIKE ${add(escapeLike(f.surnamePrefix.trim()) + '%')}`);
  if (f.city?.trim()) where.push(`${r.citySql} = ${add(f.city.trim())}`);
  if (f.region?.trim()) where.push(`${r.regionSql} = ${add(f.region.trim())}`);
  if (f.profession?.trim() && r.professionSql) where.push(`${r.professionSql} = ${add(f.profession.trim())}`);
  if (derived && f.justiceKind) where.push('ps.cases > 0');
  if (f.manualPractice?.trim()) {
    const p = add(f.manualPractice.trim());
    where.push(r.declaredPracticesSql ? `(${p} = ANY(l.manual_practices) OR ${p} = ANY(${r.declaredPracticesSql}))` : `${p} = ANY(l.manual_practices)`);
  }
  if (f.stage && (STAGES as readonly string[]).includes(f.stage)) {
    where.push(f.stage === 'new' ? "(l.stage IS NULL OR l.stage = 'new')" : `l.stage = ${add(f.stage)}`);
  }

  const sortKey: SortKey = f.sort && f.sort in sorts ? f.sort : 'surname';
  const dir = f.dir === 'asc' ? 'ASC' : f.dir === 'desc' ? 'DESC' : DEFAULT_DIR[sortKey];
  const nameOrder = [r.surnameColumn, r.firstNameColumn, r.patronymicColumn].filter(Boolean) as string[];
  const orderBy =
    sortKey === 'surname'
      ? `ORDER BY ${nameOrder.map((c) => `${c} ${dir}`).join(', ')}`
      : `ORDER BY ${sorts[sortKey]} ${dir} NULLS LAST, ${r.surnameColumn} ASC, ${r.firstNameColumn} ASC`;

  const page = Math.max(1, Math.floor(f.page ?? 1));
  const offset = (page - 1) * PAGE_SIZE;

  const statsLateral = derived
    ? `LEFT JOIN LATERAL (
    SELECT coalesce(sum(s.cases), 0)::int AS cases FROM attorney_crm_practice_stats s
    WHERE s.advocate_source_id = ${r.idColumn} AND (${kindParam}::int IS NULL OR s.justice_kind = ${kindParam}::int)
  ) ps ON true`
    : `LEFT JOIN LATERAL (SELECT 0::int AS cases WHERE ${kindParam}::int IS NULL) ps ON true`;

  const from = `
  FROM ${r.table}
  LEFT JOIN attorney_crm_leads l ON l.advocate_source_id = ${r.idColumn}
  LEFT JOIN LATERAL (
    SELECT max(n.created_at) AS last_contact FROM attorney_crm_notes n WHERE n.advocate_source_id = ${r.idColumn}
  ) nt ON true
  ${statsLateral}
  WHERE ${where.join(' AND ')}`;

  const kindSummary = derived
    ? `(SELECT string_agg(ks.justice_kind || ':' || ks.cases, ',' ORDER BY ks.cases DESC)
     FROM (SELECT justice_kind, sum(cases) AS cases FROM attorney_crm_practice_stats s2
           WHERE s2.advocate_source_id = ${r.idColumn} GROUP BY justice_kind) ks)`
    : 'NULL::text';

  const sql = `SELECT ${r.select},
  l.stage, l.next_contact_at, l.manual_practices, nt.last_contact, ps.cases AS kind_cases,
  ${kindSummary} AS kind_summary
  ${from}
  ${orderBy}
  LIMIT ${PAGE_SIZE} OFFSET ${offset}`;

  const countSql = `SELECT count(*)::int AS total ${from}`;
  return { sql, countSql, params };
}
