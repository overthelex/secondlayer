// SQL expressions over opendata_advocates (alias `a`). Copied from
// mcp_backend/src/api/tools/registry-catalog.ts (lawyers registry) so the CRM and
// the MCP tool show the same phone, address, bureau and status for an advocate.

export const ACTIVE_WHERE = "a.status <> 'TRUE'";

export const STATUS_SQL =
  "(CASE WHEN a.status = 'TRUE' AND a.status_description ILIKE '%припинен%' THEN 'terminated' " +
  "WHEN a.status = 'TRUE' THEN 'suspended' ELSE 'active' END)";

export const PHONE_SQL =
  "COALESCE(NULLIF(TRIM(a.work_address->0->>'workAddressContacts'), ''), " +
  "(SELECT NULLIF(TRIM(o->>'orgFormContacts'), '') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.org_forms) = 'array' THEN a.org_forms ELSE '[]'::jsonb END) o " +
  "WHERE NULLIF(TRIM(o->>'orgFormContacts'), '') IS NOT NULL LIMIT 1))";

export const ADDRESS_SQL =
  "NULLIF(CONCAT_WS(', ', NULLIF(a.work_address->0->>'workAddressPostCode', ''), " +
  "NULLIF(a.work_address->0->>'workAddressRegion', ''), NULLIF(a.work_address->0->>'workAddressDistrict', ''), " +
  "NULLIF(a.work_address->0->>'workAddressCity', ''), " +
  "NULLIF(CONCAT_WS(' ', NULLIF(a.work_address->0->>'workAddressStreetType', ''), NULLIF(a.work_address->0->>'workAddressStreetName', '')), ''), " +
  "NULLIF(CONCAT_WS(' ', NULLIF(a.work_address->0->>'workAddressHouseNum', ''), NULLIF(a.work_address->0->>'workAddressExtNum', '')), ''), " +
  "NULLIF(CONCAT_WS(' ', NULLIF(a.work_address->0->>'workAddressAptType', ''), NULLIF(a.work_address->0->>'workAddressAptNum', '')), '')), '')";

export const CITY_SQL = "(a.work_address->0->>'workAddressCity')";
export const REGION_SQL = "(a.work_address->0->>'workAddressRegion')";

export const ORG_FORMS_SQL =
  "(SELECT string_agg(CONCAT_WS(' ', NULLIF(o->>'orgFormType', ''), NULLIF(o->>'orgFormName', '')), '; ') " +
  "FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.org_forms) = 'array' THEN a.org_forms ELSE '[]'::jsonb END) o)";

/** Columns every advocate query selects, aliased for AdvocateRow. */
export const ADVOCATE_SELECT = `
  a.source_id, a.family_name, a.name AS first_name, a.additional_name AS patronymic,
  ${STATUS_SQL} AS status, NULLIF(a.status_description, '') AS status_description,
  NULLIF(a.email, '') AS email,
  ${PHONE_SQL} AS phone,
  ${ADDRESS_SQL} AS work_address,
  ${CITY_SQL} AS city, ${REGION_SQL} AS region,
  ${ORG_FORMS_SQL} AS org_forms,
  a.ra_name, a.certificate_num, a.certificate_date, a.decision_num, a.decision_date, a.authority_name`;
