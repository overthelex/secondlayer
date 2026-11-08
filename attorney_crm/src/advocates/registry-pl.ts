// SQL over public.pl_lawyers (alias `a`), aliased to the AdvocateRow raw column names
// so the views need no special cases beyond what the tenant flags tell them.
import type { RegistryAdapter } from '../tenant/types';

const PHONE_SQL = "NULLIF(CONCAT_WS(', ', NULLIF(a.phone, ''), NULLIF(a.phone2, '')), '')";

export const PL_REGISTRY: RegistryAdapter = {
  table: 'public.pl_lawyers a',
  idColumn: 'a.lawyer_id',
  select: `
  a.lawyer_id AS source_id, a.surname AS family_name, a.given_names AS first_name, '' AS patronymic,
  a.status, NULLIF(a.status_raw, '') AS status_description,
  NULLIF(a.email, '') AS email,
  ${PHONE_SQL} AS phone,
  NULLIF(CONCAT_WS(', ', NULLIF(a.address, ''), NULLIF(CONCAT_WS(' ', NULLIF(a.postcode, ''), NULLIF(a.city, '')), '')), '') AS work_address,
  a.city, a.chamber AS region,
  NULLIF(a.office_name, '') AS org_forms,
  NULL::text AS ra_name,
  a.entry_number AS certificate_num, a.entry_date AS certificate_date,
  NULL::text AS decision_num, NULL::date AS decision_date, NULL::text AS authority_name,
  a.profession, a.practices AS declared_practices, a.practice_tags_raw, a.profile_url, a.directory_url`,
  activeWhere: "a.status = 'active'",
  surnameColumn: 'a.surname',
  firstNameColumn: 'a.given_names',
  patronymicColumn: null,
  citySql: 'a.city',
  regionSql: 'a.chamber',
  professionSql: 'a.profession',
  declaredPracticesSql: 'a.practices',
  phoneSqlForToday: PHONE_SQL,
  citySqlForToday: 'a.city',
};
