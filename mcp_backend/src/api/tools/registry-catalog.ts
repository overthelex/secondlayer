/**
 * Registry Catalog — declarative config for all parametric opendata search tools.
 *
 * Each entry describes one registry: table, columns, searchable fields,
 * match types, ordering, and Ukrainian descriptions for the LLM.
 *
 * 22 registries consolidated from 5 former handler files:
 * opendata-registries-tools.ts, opendata-tools.ts, tier1-opendata-tools.ts,
 * state-registry-tools.ts, spending-tools.ts (partial).
 */

// MatchType / FieldDef are the canonical query-builder primitives, now owned by
// @secondlayer/shared/query-ir so registry AND EDRSR share one definition.
import type { MatchType, FieldDef } from '@secondlayer/shared';
export type { MatchType, FieldDef };

export interface RegistryDef {
  title: string;
  description: string;
  table: string;
  selectColumns: string;
  orderBy: string;
  fields: FieldDef[];
  emptyMessage: string;
  defaultLimit?: number;
  maxLimit?: number;
  requiredFields?: string[];
  /**
   * Constant SQL predicate ANDed into every query for this registry (no bind
   * params). Used when one physical table backs several logical registries —
   * e.g. the unified `ip_objects` table serves both `trademarks` (obj_type=4)
   * and `patents` (obj_type IN (1,2,6)).
   */
  baseWhere?: string;
  /**
   * Optional outer projection. When set, `selectColumns` becomes the INNER
   * select of `SELECT <outerColumns> FROM (SELECT <selectColumns> ... ORDER BY
   * ... LIMIT n) t`, and only the rows that survive the LIMIT reach these
   * expressions.
   *
   * This exists for one measured reason. A snippet like
   * `left(full_text || '', 400)` in a flat query is evaluated for every matching
   * row before the sort, so it detoasts the whole corpus the filter matched, not
   * the page the caller asked for. Measured on prod 2026-08-25, uk_court_decisions,
   * 12,019 matches, LIMIT 5: 2,250 ms flat against 31 ms deferred, a 71x
   * difference for identical output. The toast pointer survives the sort, so the
   * inner query can carry the raw column at no cost.
   *
   * Qualify outer expressions with `t.`. Any raw column named in `selectColumns`
   * but absent from `outerColumns` is fetched and then dropped, which is how the
   * body of a document stays out of the response.
   */
  outerColumns?: string;
  /**
   * Ordering for the outer select. Required whenever `outerColumns` is set:
   * a subquery's ORDER BY is not carried by SQL semantics into the enclosing
   * query, so without this the page would come back in whatever order the
   * executor happened to produce. Cheap — it sorts at most `limit` rows, the
   * inner ORDER BY having already chosen which rows those are.
   */
  outerOrderBy?: string;
  /**
   * Licence attribution carried back with every result from this registry.
   *
   * Not decoration. The Open Justice Licence requires the acknowledgement
   * "Contains information licensed under the Open Justice - Licence v2.0" on the
   * information it covers, and OGL v3.0 requires attribution for
   * legislation.gov.uk. We were relying on neither, which is a live breach of the
   * terms the corpora are already held under — older than any of the commitments
   * in the Find Case Law application.
   */
  attribution?: string;
}

export const REGISTRY_CATALOG: Record<string, RegistryDef> = {

  // ── opendata-registries-tools.ts ──────────────────────────────────

  public_organizations: {
    title: 'Реєстр громадських формувань',
    description: 'Пошук у реєстрі громадських формувань (ГО, партії, профспілки, релігійні організації тощо)\n\n1.08M записів. Пошук за назвою, ЄДРПОУ, типом реєстру, статусом, засновниками.',
    table: 'opendata_public_organizations',
    selectColumns: 'registry_type, reg_num, date_reg::text AS date_reg, name, edrpou, state, address, phone, founders, governing_body, kved, territory, obj_status',
    orderBy: 'date_reg DESC NULLS LAST',
    emptyMessage: 'Громадських формувань не знайдено',
    fields: [
      { name: 'name', description: 'Назва організації', match: 'ilike', columns: ['name'] },
      { name: 'edrpou', description: 'Код ЄДРПОУ', match: 'exact', columns: ['edrpou'] },
      { name: 'registry_type', description: 'Тип реєстру (ГО, партія, профспілка тощо)', match: 'ilike', columns: ['registry_type'] },
      { name: 'state', description: 'Стан (зареєстровано, припинено тощо)', match: 'ilike', columns: ['state'] },
      { name: 'founders', description: 'Засновники (пошук за текстом)', match: 'ilike_cast', columns: ['founders'] },
      { name: 'address', description: 'Адреса', match: 'ilike', columns: ['address'] },
    ],
  },

  case_distribution: {
    title: 'Розподіл судових справ',
    description: 'Пошук у протоколах автоматичного розподілу судових справ (ДСАУ)\n\n71K записів. Пошук за номером справи, суддею, судом, учасниками, категорією справи.',
    table: 'dsa_case_distribution',
    selectColumns: 'cause_number, court_name, case_category, case_complexity, case_essence, presiding_judge, panel_judges, participants, distribution_basis, distribution_start, distribution_end, excluded_judges, source_date::text AS source_date',
    orderBy: 'distribution_start DESC NULLS LAST',
    emptyMessage: 'Протоколів розподілу не знайдено',
    fields: [
      { name: 'cause_number', description: 'Номер справи', match: 'exact', columns: ['cause_number'] },
      { name: 'court_name', description: 'Назва суду', match: 'ilike', columns: ['court_name'] },
      { name: 'judges', description: 'Прізвище судді', match: 'ilike_multi', columns: ['judges', 'participating_judges', 'panel_judges'] },
      { name: 'presiding_judge', description: 'Головуючий суддя', match: 'ilike', columns: ['presiding_judge'] },
      { name: 'participants', description: 'Учасники справи', match: 'ilike', columns: ['participants'] },
      { name: 'case_category', description: 'Категорія справи', match: 'ilike', columns: ['case_category'] },
      { name: 'case_essence', description: 'Суть справи (ключові слова)', match: 'ilike', columns: ['case_essence'] },
    ],
  },

  missing_persons: {
    title: 'Зниклі безвісти',
    description: 'Пошук у реєстрі зниклих безвісти осіб (МВС)\n\n112K записів. Пошук за прізвищем, ОВД, категорією, датою зникнення, місцем.',
    table: 'opendata_missing_persons',
    selectColumns: 'last_name_u, first_name_u, middle_name_u, birth_date, sex, ovd, category, lost_date, lost_place, article_crim, restraint, contact',
    orderBy: 'lost_date DESC NULLS LAST',
    emptyMessage: 'Зниклих безвісти не знайдено',
    fields: [
      { name: 'last_name', description: 'Прізвище', match: 'ilike_multi', columns: ['last_name_u', 'last_name_r', 'last_name_e'] },
      { name: 'first_name', description: "Ім'я", match: 'ilike_multi', columns: ['first_name_u', 'first_name_r', 'first_name_e'] },
      { name: 'ovd', description: 'Орган внутрішніх справ', match: 'ilike', columns: ['ovd'] },
      { name: 'category', description: 'Категорія зниклого', match: 'ilike', columns: ['category'] },
      { name: 'lost_place', description: 'Місце зникнення', match: 'ilike', columns: ['lost_place'] },
      { name: 'sex', description: 'Стать (чол/жін)', match: 'exact', columns: ['sex'] },
    ],
  },

  securities_owners: {
    title: 'Власники цінних паперів',
    description: 'Пошук власників істотної участі у цінних паперах (НКЦПФР)\n\n128K записів. Пошук за емітентом, власником, ЄДРПОУ, ISIN-кодом, часткою.',
    table: 'opendata_securities_owners',
    selectColumns: 'report_date::text AS report_date, issuer_edrpou, issuer_name, isin_code, owner_edrpou, owner_name, owner_name_alt, owner_type, share_percent, nominal_value, share_count, country_code',
    orderBy: 'share_percent DESC NULLS LAST',
    emptyMessage: 'Власників цінних паперів не знайдено',
    fields: [
      { name: 'issuer_name', description: 'Назва емітента', match: 'ilike', columns: ['issuer_name'] },
      { name: 'issuer_edrpou', description: 'ЄДРПОУ емітента', match: 'exact', columns: ['issuer_edrpou'] },
      { name: 'owner_name', description: "Назва / ім'я власника", match: 'ilike_multi', columns: ['owner_name', 'owner_name_alt'] },
      { name: 'owner_edrpou', description: 'ЄДРПОУ власника', match: 'exact', columns: ['owner_edrpou'] },
      { name: 'isin_code', description: 'Код ISIN цінного паперу', match: 'exact', columns: ['isin_code'] },
      { name: 'min_share_percent', description: 'Мінімальна частка участі (%)', match: 'gte', columns: ['share_percent'], type: 'number' },
    ],
  },

  wanted_persons: {
    title: 'Розшукувані особи (МВС)',
    description: 'Пошук у реєстрі розшукуваних осіб (МВС)\n\n71K записів. Пошук за прізвищем, ОВД, статтею КК, категорією, запобіжним заходом.',
    table: 'opendata_wanted_persons',
    selectColumns: 'last_name_u, first_name_u, middle_name_u, birth_date, sex, ovd, category, lost_date, lost_place, article_crim, restraint, contact',
    orderBy: 'lost_date DESC NULLS LAST',
    emptyMessage: 'Розшукуваних осіб не знайдено',
    fields: [
      { name: 'last_name', description: 'Прізвище', match: 'ilike_multi', columns: ['last_name_u', 'last_name_r', 'last_name_e'] },
      { name: 'first_name', description: "Ім'я", match: 'ilike_multi', columns: ['first_name_u', 'first_name_r', 'first_name_e'] },
      { name: 'ovd', description: 'Орган внутрішніх справ', match: 'ilike', columns: ['ovd'] },
      { name: 'category', description: 'Категорія розшуку', match: 'ilike', columns: ['category'] },
      { name: 'article_crim', description: 'Стаття Кримінального кодексу', match: 'ilike', columns: ['article_crim'] },
      { name: 'restraint', description: 'Запобіжний захід', match: 'ilike', columns: ['restraint'] },
      { name: 'sex', description: 'Стать (чол/жін)', match: 'exact', columns: ['sex'] },
    ],
  },

  wanted_vehicles: {
    title: 'Розшукувані транспортні засоби',
    description: 'Пошук розшукуваних транспортних засобів (МВС)\n\n78K записів. Пошук за маркою, номером, кольором, номером кузова/шасі/двигуна.',
    table: 'opendata_wanted_vehicles',
    selectColumns: 'brand_model, car_type, color, vehicle_number, body_number, chassis_number, engine_number, illegal_seizure_date, organ_unit, insert_date',
    orderBy: 'insert_date DESC NULLS LAST',
    emptyMessage: 'Розшукуваних транспортних засобів не знайдено',
    fields: [
      { name: 'brand_model', description: 'Марка та модель', match: 'ilike', columns: ['brand_model'] },
      { name: 'vehicle_number', description: 'Державний номерний знак', match: 'ilike', columns: ['vehicle_number'] },
      { name: 'color', description: 'Колір', match: 'ilike', columns: ['color'] },
      { name: 'car_type', description: 'Тип транспорту', match: 'ilike', columns: ['car_type'] },
      { name: 'body_number', description: 'Номер кузова', match: 'exact', columns: ['body_number'] },
      { name: 'chassis_number', description: 'Номер шасі', match: 'exact', columns: ['chassis_number'] },
      { name: 'engine_number', description: 'Номер двигуна', match: 'exact', columns: ['engine_number'] },
      { name: 'organ_unit', description: 'Орган, що розшукує', match: 'ilike', columns: ['organ_unit'] },
    ],
  },

  court_experts: {
    title: 'Реєстр судових експертів',
    description: "Пошук атестованих судових експертів (Мін'юст)\n\n80K записів. Пошук за прізвищем, установою, регіоном, типом експертизи, спеціалізацією.",
    table: 'opendata_court_experts',
    selectColumns: 'surname, first_name, patronymic, org_name, region, phone, commission, license_num, valid_date, exp_type, specialization',
    orderBy: 'surname, first_name',
    emptyMessage: 'Судових експертів не знайдено',
    fields: [
      { name: 'surname', description: 'Прізвище експерта', match: 'ilike', columns: ['surname'] },
      { name: 'first_name', description: "Ім'я експерта", match: 'ilike', columns: ['first_name'] },
      { name: 'org_name', description: 'Назва установи', match: 'ilike', columns: ['org_name'] },
      { name: 'region', description: 'Регіон', match: 'ilike', columns: ['region'] },
      { name: 'exp_type', description: 'Тип експертизи', match: 'ilike', columns: ['exp_type'] },
      { name: 'specialization', description: 'Спеціалізація', match: 'ilike', columns: ['specialization'] },
      { name: 'license_num', description: 'Номер свідоцтва', match: 'exact', columns: ['license_num'] },
    ],
  },

  vat_payers: {
    title: 'Реєстр платників ПДВ',
    description: 'Пошук у реєстрі платників ПДВ (ДПС)\n\n264K записів. Пошук за назвою або кодом ПДВ.',
    table: 'opendata_vat_payers',
    selectColumns: 'name, kod_pdv, dat_reestr, dat_term',
    orderBy: 'dat_reestr DESC NULLS LAST',
    emptyMessage: 'Платників ПДВ не знайдено',
    fields: [
      { name: 'name', description: 'Назва компанії або ФОП', match: 'ilike', columns: ['name'] },
      { name: 'kod_pdv', description: 'Код ПДВ', match: 'exact', columns: ['kod_pdv'] },
    ],
  },

  // ── opendata-tools.ts ─────────────────────────────────────────────

  sanctions: {
    title: 'Санкційні списки',
    description: 'Пошук у міжнародних санкційних списках (OpenSanctions, 346 датасетів)\n\nВключає: РНБО, OFAC, EU, UN, UK та 340+ інших санкційних програм.\n1.25M записів: фізичні особи, компанії, судна, літаки, криптогаманці.',
    table: 'opensanctions_entities',
    selectColumns: 'id, schema, name, aliases, birth_date, countries, identifiers, sanctions, datasets, first_seen, last_seen',
    orderBy: 'last_seen DESC NULLS LAST',
    emptyMessage: 'Записів у санкційних списках не знайдено',
    fields: [
      { name: 'name', description: "Ім'я або назва (нечіткий пошук)", match: 'ilike_multi', columns: ['name', 'aliases'] },
      { name: 'country', description: 'Код країни (ua, ru, ir тощо)', match: 'ilike', columns: ['countries'] },
      { name: 'schema', description: 'Тип: Person, Company, Organization, Vessel, Aircraft, CryptoWallet', match: 'exact', columns: ['schema'] },
      { name: 'dataset', description: 'Датасет (ua_nsdc_sanctions, us_ofac_sdn, eu_fsf тощо)', match: 'ilike', columns: ['datasets'] },
      { name: 'identifier', description: 'Ідентифікатор (ІПН, паспорт, ЄДРПОУ)', match: 'ilike', columns: ['identifiers'] },
    ],
  },

  // Backed by the unified `ip_objects` table (НІПО/УІПВ SIS harvest — the live,
  // continuously-synced IP registry, 788K rows incl. applications + all types).
  // The legacy `opendata_trademarks`/`opendata_patents` tables are a bulk
  // snapshot that misses recent registrations (e.g. reg. №389137), so
  // search_registry now reads ip_objects. Result columns keep the old names
  // (mark_text/holder_*/nice_classes/ipc_codes) via aliases for a stable shape.
  trademarks: {
    title: 'Торговельні марки (НІПО/УІПВ)',
    description: 'Пошук торговельних марок — свідоцтв на знаки для товарів і послуг (реєстр НІПО/УІПВ ip_objects: заявки + зареєстровані, живий синк).\n\nПошук за текстом марки, власником, ЄДРПОУ, класом МКТП/NICE, статусом, номером свідоцтва/заявки.\n\nЧинність визначайте за legal_status / effective_expiry_date / termination_date, а НЕ за сирим полем status (воно з реєстру і буває стале). effective_expiry_date враховує поновлення; termination_date — дострокове припинення.',
    table: 'ip_objects',
    baseWhere: 'obj_type = 4',
    // Dates are ::text so node-postgres does not round-trip DATE columns through a
    // local-midnight JS Date (which JSON-serializes as the prior day in UTC —
    // an off-by-one that corrupts legal term calculations). ISO YYYY-MM-DD sorts
    // chronologically, so the text-aliased columns keep ORDER BY correct.
    //
    // The raw `status` column is unreliable (e.g. reg. №67482 reads "active" while the mark was
    // terminated 2025-07-22). Authoritative validity lives only in raw_data — surface it:
    //   effective_expiry_date = renewed term end (ProlonagationExpiryDate) or the original expiry;
    //   termination_date      = early termination (TerminationDate);
    //   status_color          = registry colour ('red' = not in force);
    //   legal_status          = derived headline the model should quote.
    // All via raw_data->> (null-safe: a row without these keys falls through to obj_state).
    // Date comparisons use ISO text (YYYY-MM-DD sorts chronologically) — no ::date casts, so a
    // malformed value can never throw and break the whole search.
    selectColumns: `obj_type_name, obj_state, app_number, app_date::text AS app_date, registration_number, registration_date::text AS registration_date, expiry_date::text AS expiry_date, COALESCE(NULLIF(raw_data->>'ProlonagationExpiryDate',''), expiry_date::text) AS effective_expiry_date, NULLIF(raw_data->>'ProlongationDate','') AS prolongation_date, NULLIF(raw_data->>'TerminationDate','') AS termination_date, NULLIF(raw_data->>'registration_status_color','') AS status_color, CASE WHEN NULLIF(raw_data->>'TerminationDate','') IS NOT NULL THEN 'дію припинено (достроково)' WHEN lower(COALESCE(raw_data->>'registration_status_color','')) = 'red' THEN 'не чинна' WHEN COALESCE(NULLIF(raw_data->>'ProlonagationExpiryDate',''), expiry_date::text) < CURRENT_DATE::text THEN 'строк дії сплив' WHEN obj_state = 2 THEN 'чинна' WHEN obj_state = 1 THEN 'заявка на розгляді' ELSE COALESCE(status, 'невідомо') END AS legal_status, title_ua AS mark_text, status, owner_name AS holder_name, owner_edrpou AS holder_edrpou, owner_country AS holder_country, classes AS nice_classes`,
    orderBy: 'COALESCE(registration_date, app_date) DESC NULLS LAST',
    emptyMessage: 'Торговельних марок не знайдено',
    fields: [
      { name: 'mark_text', description: 'Текст (словесна частина) торговельної марки', match: 'ilike', columns: ['title_ua'] },
      { name: 'holder_name', description: "Назва або ім'я власника / заявника", match: 'ilike', columns: ['owner_name'] },
      { name: 'holder_edrpou', description: 'ЄДРПОУ власника', match: 'exact', columns: ['owner_edrpou'] },
      { name: 'nice_class', description: 'Клас МКТП/NICE (1-45), напр. "34"', match: 'array_contains_text', columns: ['classes'] },
      { name: 'status', description: 'Сирий статус марки з реєстру для фільтрації: "active" / "stopped". УВАГА: буває стале — фактичну чинність дивіться у legal_status/termination_date/effective_expiry_date у результатах, а не тут.', match: 'exact_ci', columns: ['status'] },
      { name: 'registration_number', description: 'Номер свідоцтва / реєстрації', match: 'exact', columns: ['registration_number'] },
      // Synonyms the model reaches for on "перевір свідоцтво №N" — map to registration_number.
      { name: 'certificate', description: 'Номер свідоцтва (синонім registration_number)', match: 'exact', columns: ['registration_number'] },
      { name: 'certificate_number', description: 'Номер свідоцтва (синонім registration_number)', match: 'exact', columns: ['registration_number'] },
      { name: 'app_number', description: 'Номер заявки (напр. m202420274)', match: 'exact', columns: ['app_number'] },
    ],
  },

  patents: {
    title: 'Патенти, корисні моделі, промзразки (НІПО/УІПВ)',
    description: 'Пошук патентів на винаходи, корисних моделей та промислових зразків (реєстр НІПО/УІПВ ip_objects: заявки + охоронні документи, живий синк).\n\nПошук за назвою, власником, кодом МПК/Локарно, номером заявки/патенту.\n\nЧинність визначайте за legal_status / effective_expiry_date / termination_date, а НЕ за сирим полем status.',
    table: 'ip_objects',
    baseWhere: 'obj_type IN (1, 2, 6)',
    // Dates ::text — see trademarks note (avoids node-postgres DATE off-by-one).
    // Validity (legal_status/effective_expiry_date/termination_date/status_color) surfaced from
    // raw_data the same way as trademarks — see the trademarks selectColumns note. Null-safe.
    selectColumns: `obj_type_name, obj_state, app_number, app_date::text AS app_date, registration_number, registration_date::text AS registration_date, expiry_date::text AS expiry_date, COALESCE(NULLIF(raw_data->>'ProlonagationExpiryDate',''), expiry_date::text) AS effective_expiry_date, NULLIF(raw_data->>'TerminationDate','') AS termination_date, NULLIF(raw_data->>'registration_status_color','') AS status_color, CASE WHEN NULLIF(raw_data->>'TerminationDate','') IS NOT NULL THEN 'дію припинено (достроково)' WHEN lower(COALESCE(raw_data->>'registration_status_color','')) = 'red' THEN 'не чинний' WHEN COALESCE(NULLIF(raw_data->>'ProlonagationExpiryDate',''), expiry_date::text) < CURRENT_DATE::text THEN 'строк дії сплив' WHEN obj_state = 2 THEN 'чинний' WHEN obj_state = 1 THEN 'заявка на розгляді' ELSE COALESCE(status, 'невідомо') END AS legal_status, title_ua, title_en, abstract_ua, classes AS ipc_codes, owner_name, owner_country, status`,
    orderBy: 'COALESCE(registration_date, app_date) DESC NULLS LAST',
    emptyMessage: 'Патентів не знайдено',
    fields: [
      { name: 'title', description: 'Назва винаходу / корисної моделі', match: 'ilike_multi', columns: ['title_ua', 'title_en'] },
      { name: 'owner_name', description: "Ім'я або назва патентовласника", match: 'ilike', columns: ['owner_name'] },
      { name: 'ipc_code', description: 'Код МПК/Локарно (наприклад, A61K)', match: 'array_contains_text', columns: ['classes'] },
      { name: 'app_number', description: 'Номер заявки', match: 'exact', columns: ['app_number'] },
      { name: 'registration_number', description: 'Номер патенту / свідоцтва', match: 'exact', columns: ['registration_number'] },
      // Synonyms the model reaches for — map to registration_number.
      { name: 'certificate', description: 'Номер патенту/свідоцтва (синонім registration_number)', match: 'exact', columns: ['registration_number'] },
      { name: 'certificate_number', description: 'Номер патенту/свідоцтва (синонім registration_number)', match: 'exact', columns: ['registration_number'] },
      { name: 'obj_type', description: 'Тип: 1=винахід, 2=корисна модель, 6=промисл. зразок', match: 'exact', columns: ['obj_type'], type: 'number' },
      { name: 'status', description: 'Сирий статус з реєстру для фільтрації. УВАГА: буває стале — фактичну чинність дивіться у legal_status/termination_date у результатах.', match: 'exact_ci', columns: ['status'] },
    ],
  },

  corruption_register: {
    title: 'Реєстр корупціонерів',
    description: 'Пошук у Єдиному реєстрі осіб, які вчинили корупційні правопорушення\n\n58K записів. Пошук за прізвищем, статтею КК, назвою суду, видом покарання.',
    table: 'opendata_corruption',
    selectColumns: 'last_name, first_name, patronymic, entity_type, offense_name, punishment_type, punishment, codex_articles, court_case_number, sentence_date, court_name',
    orderBy: 'sentence_date DESC NULLS LAST',
    emptyMessage: 'Записів у реєстрі корупціонерів не знайдено',
    fields: [
      { name: 'last_name', description: 'Прізвище', match: 'ilike', columns: ['last_name'] },
      { name: 'first_name', description: "Ім'я", match: 'ilike', columns: ['first_name'] },
      { name: 'offense_name', description: 'Назва правопорушення', match: 'ilike', columns: ['offense_name'] },
      { name: 'codex_articles', description: 'Статті кодексу', match: 'ilike', columns: ['codex_articles'] },
      { name: 'court_name', description: 'Назва суду', match: 'ilike', columns: ['court_name'] },
    ],
  },

  lawyers: {
    title: 'Реєстр адвокатів',
    description: 'Пошук у Єдиному реєстрі адвокатів України\n\n73K записів. Пошук за прізвищем, радою адвокатів, статусом, номером свідоцтва.',
    table: 'opendata_lawyers',
    selectColumns: 'lawyer_id, last_name, first_name, patronymic, ra_name, certificate_num, certificate_date, decision_num, decision_date, authority_name, email, status, status_description, work_address, org_forms',
    orderBy: 'last_name, first_name',
    emptyMessage: 'Адвокатів не знайдено',
    fields: [
      { name: 'last_name', description: 'Прізвище адвоката', match: 'ilike', columns: ['last_name'] },
      { name: 'first_name', description: "Ім'я адвоката", match: 'ilike', columns: ['first_name'] },
      { name: 'ra_name', description: 'Назва ради адвокатів регіону', match: 'ilike', columns: ['ra_name'] },
      { name: 'status', description: 'Статус (діє, зупинено, припинено)', match: 'ilike', columns: ['status'] },
      { name: 'certificate_num', description: 'Номер свідоцтва', match: 'exact', columns: ['certificate_num'] },
    ],
  },

  law_firms: {
    title: 'Юридичні фірми та адвокатські об’єднання',
    description: 'Пошук юридичних фірм, адвокатських об’єднань і юридичних компаній (КВЕД 69.10 — діяльність у сфері права)\n\n10.7K записів. Пошук за назвою, ЄДРПОУ, email, сайтом.\nУВАГА: назви в реєстрі — у формі «НАЗВА, ОРГ-ФОРМА» (наприклад «ЕВЕРЛІҐАЛ, АДВОКАТСЬКЕ ОБ’ЄДНАННЯ»), тому шукати варто за коренем назви. Одна фірма може мати кілька юросіб з різними ЄДРПОУ.',
    table: 'opendata_law_firms',
    selectColumns: 'edrpou, name, email, phone, website, kved, source',
    orderBy: 'name',
    emptyMessage: 'Юридичних фірм не знайдено',
    fields: [
      { name: 'name', description: 'Назва фірми або адвокатського об’єднання', match: 'ilike', columns: ['name'] },
      { name: 'edrpou', description: 'Код ЄДРПОУ', match: 'exact', columns: ['edrpou'] },
      { name: 'email', description: 'Email', match: 'ilike', columns: ['email'] },
      { name: 'website', description: 'Вебсайт', match: 'ilike', columns: ['website'] },
    ],
  },

  bankruptcy_announcements: {
    title: 'Оголошення про банкрутство та неплатоспроможність',
    description: 'Пошук офіційних оголошень у справах про банкрутство/неплатоспроможність: відкриття провадження, санація, ліквідація, аукціони\n\n74.7K записів. Пошук за назвою або ЄДРПОУ боржника, номером справи, судом, типом оголошення.\nНЕ плутати з openreyestr_search_bankruptcy_cases — там картки справ з ЄДР, а тут стрічка публікацій. Поле case_number — це номер справи в ЄДРСР, за ним можна одразу підняти рішення через search_court_decisions.',
    table: 'opendata_bankruptcy',
    selectColumns: "case_num, publish_date, case_type, firm_edrpou, firm_name, case_number, court_name, start_date_auc, end_date_auc, end_registration_date",
    orderBy: "to_date(NULLIF(publish_date, ''), 'DD.MM.YYYY') DESC NULLS LAST",
    emptyMessage: 'Оголошень про банкрутство не знайдено',
    fields: [
      { name: 'firm_name', description: 'Назва боржника (юрособа або ПІБ ФОП/фізособи)', match: 'ilike', columns: ['firm_name'] },
      { name: 'firm_edrpou', description: 'ЄДРПОУ або ІПН боржника', match: 'exact', columns: ['firm_edrpou'] },
      { name: 'case_number', description: 'Номер судової справи (як у ЄДРСР)', match: 'exact', columns: ['case_number'] },
      { name: 'court_name', description: 'Назва суду', match: 'ilike', columns: ['court_name'] },
      { name: 'case_type', description: 'Тип оголошення (відкриття провадження, санація, ліквідація, аукціон)', match: 'ilike', columns: ['case_type'] },
    ],
  },

  judge_candidates: {
    title: 'Кандидати на посаду судді',
    description: 'Пошук у рейтинговому списку кандидатів на посаду судді (ВККС)\n\n645 записів. Пошук за ПІБ; є місце в рейтингу, бали тестування й практичного завдання, дата затвердження та строк дії.',
    table: 'opendata_judge_candidates',
    selectColumns: 'rank_position, full_name, gender, test_score, practical_score, total_score, approval_date::text AS approval_date, expiry_date::text AS expiry_date',
    orderBy: 'rank_position NULLS LAST',
    emptyMessage: 'Кандидатів на посаду судді не знайдено',
    fields: [
      { name: 'full_name', description: 'ПІБ кандидата', match: 'ilike', columns: ['full_name'] },
      { name: 'gender', description: 'Стать (Ч/Ж)', match: 'exact', columns: ['gender'] },
    ],
  },

  vrp_decisions: {
    title: 'Рішення ВРП',
    description: 'Пошук рішень Вищої ради правосуддя (ВРП)\n\n16.5K записів. Пошук за назвою, органом, номером рішення, датою.\nВключає голосування та тексти рішень.',
    table: 'vrp_decisions',
    selectColumns: 'id, date_time, authority, title, decision_num, proceeding_ids, voting_title, voting_for, voting_against, voting_type, voting_result, texts',
    orderBy: 'date_time DESC NULLS LAST',
    emptyMessage: 'Рішень ВРП не знайдено',
    fields: [
      { name: 'title', description: 'Назва рішення (нечіткий пошук)', match: 'ilike', columns: ['title'] },
      { name: 'authority', description: 'Орган (наприклад, Пленум ВРП, Дисциплінарна палата)', match: 'exact', columns: ['authority'] },
      { name: 'decision_num', description: 'Номер рішення', match: 'exact', columns: ['decision_num'] },
      { name: 'date_from', description: 'Дата від (YYYY-MM-DD)', match: 'gte', columns: ['date_time'] },
      { name: 'date_to', description: 'Дата до (YYYY-MM-DD)', match: 'lte', columns: ['date_time'] },
    ],
  },

  declaration_checks: {
    title: 'Перевірки декларацій (НАЗК)',
    description: 'Пошук результатів перевірок декларацій (НАЗК)\n\n2K записів. Пошук за прізвищем, посадою, статусом перевірки, результатом.',
    table: 'opendata_declaration_checks',
    selectColumns: 'id, declaration_uid, family_name, name, additional_name, position, position_category, reporting_period, status, result, result_url, measures, completion_year',
    orderBy: 'family_name, name',
    emptyMessage: 'Перевірок декларацій не знайдено',
    fields: [
      { name: 'family_name', description: 'Прізвище декларанта', match: 'ilike', columns: ['family_name'] },
      { name: 'name', description: "Ім'я декларанта", match: 'ilike', columns: ['name'] },
      { name: 'position', description: 'Посада', match: 'ilike', columns: ['position'] },
      { name: 'status', description: 'Статус перевірки', match: 'ilike', columns: ['status'] },
      { name: 'result', description: 'Результат перевірки', match: 'ilike', columns: ['result'] },
    ],
  },

  wage_debtors: {
    title: 'Боржники із зарплати',
    description: 'Пошук боржників із заробітної плати\n\n1.3K записів. Пошук за назвою підприємства, регіоном, формою власності, видом діяльності.',
    table: 'opendata_wage_debtors',
    selectColumns: 'id, region, company_name, ownership_form, economic_activity, debt_2018_01, debt_2019_01, debt_2019_02_25, debt_reason',
    orderBy: 'company_name',
    emptyMessage: 'Боржників із зарплати не знайдено',
    fields: [
      { name: 'company_name', description: 'Назва підприємства', match: 'ilike', columns: ['company_name'] },
      { name: 'region', description: 'Регіон', match: 'ilike', columns: ['region'] },
      { name: 'ownership_form', description: 'Форма власності', match: 'ilike', columns: ['ownership_form'] },
      { name: 'economic_activity', description: 'Вид економічної діяльності', match: 'ilike', columns: ['economic_activity'] },
    ],
  },

  large_taxpayers: {
    title: 'Великі платники податків',
    description: 'Пошук у реєстрі великих платників податків\n\n1.3K записів. Пошук за ЄДРПОУ або назвою підприємства.',
    table: 'opendata_large_taxpayers',
    selectColumns: 'id, edrpou, name',
    orderBy: 'name',
    emptyMessage: 'Великих платників податків не знайдено',
    fields: [
      { name: 'edrpou', description: 'Код ЄДРПОУ', match: 'exact', columns: ['edrpou'] },
      { name: 'name', description: 'Назва підприємства', match: 'ilike', columns: ['name'] },
    ],
  },

  // ── tier1-opendata-tools.ts ───────────────────────────────────────

  vehicle_registrations: {
    title: 'Реєстрація транспорту',
    description: 'Пошук у реєстрі транспортних засобів та їх власників (МВС)\n\n19.5M записів з 2013 року. Дані: VIN, держномер, марка, модель, рік, колір, тип, реєстраційні операції.',
    table: 'opendata_vehicle_registrations',
    selectColumns: 'person_type, d_reg::text AS d_reg, oper_name, brand, model, vin, make_year, color, kind, body, purpose, fuel, capacity, n_reg_new, dep',
    orderBy: 'd_reg DESC NULLS LAST',
    emptyMessage: 'Транспортних засобів не знайдено',
    fields: [
      { name: 'vin', description: 'VIN-код транспортного засобу', match: 'exact', columns: ['vin'], transform: 'uppercase' },
      { name: 'n_reg_new', description: 'Державний номерний знак', match: 'ilike', columns: ['n_reg_new'], transform: 'uppercase' },
      { name: 'brand', description: 'Марка (TOYOTA, BMW тощо)', match: 'ilike', columns: ['brand'], transform: 'uppercase' },
      { name: 'model', description: 'Модель', match: 'ilike', columns: ['model'], transform: 'uppercase' },
      { name: 'make_year', description: 'Рік випуску', match: 'exact', columns: ['make_year'], type: 'number' },
      { name: 'oper_name', description: 'Тип операції (ПЕРЕРЕЄСТРАЦІЯ, ПЕРВИННА тощо)', match: 'ilike', columns: ['oper_name'] },
    ],
  },

  lustration: {
    title: 'Реєстр люстрації',
    description: 'Пошук у реєстрі осіб, щодо яких застосовано Закон "Про очищення влади"\n\n587 записів. Люстровані особи — заборона обіймати публічні посади.',
    table: 'opendata_lustration',
    selectColumns: 'fio, job, judgment, period',
    orderBy: 'fio',
    emptyMessage: 'Люстрованих осіб не знайдено',
    fields: [
      { name: 'fio', description: 'ПІБ особи', match: 'ilike', columns: ['fio'] },
      { name: 'job', description: 'Посада / місце роботи', match: 'ilike', columns: ['job'] },
    ],
  },

  state_aid: {
    title: 'Державна допомога',
    description: 'Пошук у реєстрі державної допомоги (АМКУ)\n\nПрограми держдопомоги з надавачами та отримувачами.',
    table: 'opendata_state_aid',
    selectColumns: 'provider_name, recipient_name, program_name, row_data',
    orderBy: 'id DESC',
    emptyMessage: 'Записів держдопомоги не знайдено',
    fields: [
      { name: 'provider_name', description: 'Назва надавача допомоги', match: 'ilike', columns: ['provider_name'] },
      { name: 'recipient_name', description: 'Назва отримувача допомоги', match: 'ilike', columns: ['recipient_name'] },
      { name: 'program_name', description: 'Назва програми допомоги', match: 'ilike', columns: ['program_name'] },
    ],
  },

  financial_statements: {
    title: 'Фінансова звітність',
    description: 'Пошук фінансової звітності підприємств за ЄДРПОУ (Держстат)\n\n504K XML-звітів. Баланси, звіти про фінрезультати (Форми 1-6) за ЄДРПОУ та рік.',
    table: 'opendata_financial_statements',
    selectColumns: 'tin, c_doc, c_doc_sub, c_doc_ver, period_year, period_month, period_type, c_reg, c_raj, form_type',
    orderBy: 'period_year DESC, form_type',
    emptyMessage: 'Фінансову звітність не знайдено',
    defaultLimit: 20,
    maxLimit: 50,
    requiredFields: ['tin'],
    fields: [
      { name: 'tin', description: 'ЄДРПОУ / ІПН підприємства', match: 'exact', columns: ['tin'] },
      { name: 'period_year', description: 'Рік звітності (2021-2025)', match: 'exact', columns: ['period_year'], type: 'number' },
      { name: 'form_type', description: 'Тип форми (S0100115 = Форма 1 тощо)', match: 'ilike', columns: ['form_type'] },
    ],
  },

  // ── state-registry-tools.ts ───────────────────────────────────────

  nbu_banks: {
    title: 'Банки з ліцензією НБУ',
    description: 'Пошук банків з ліцензією Національного банку України\n\nРеєстр містить усі банки України з банківською ліцензією НБУ (60 банків).\nДжерело: bank.gov.ua (Open Data API)',
    table: 'nbu_banks',
    selectColumns: 'shortname, fullname, kod_edrpou, n_stan, d_open, d_close, num_lic, dt_lic, n_pr_lic, n_obl, np, adress, p_ind, telefon, website, name_e, shortname_en, glmfo, idnbu',
    orderBy: 'shortname',
    emptyMessage: 'Банків не знайдено',
    fields: [
      { name: 'query', description: 'Назва банку або частина назви', match: 'ilike_multi', columns: ['shortname', 'fullname'] },
      { name: 'edrpou', description: 'Код ЄДРПОУ банку', match: 'exact', columns: ['kod_edrpou'] },
      { name: 'status', description: 'Статус банку (Нормальний, Неплатоспроможний, В стані ліквідації)', match: 'exact', columns: ['n_stan'] },
    ],
  },

  // ── US Open Data registries ──────────────────────────────────────

  us_court_opinions: {
    title: 'US Court Opinions (6.9M decisions)',
    description: 'Full-text search across 6.9M US court opinions from the Caselaw Access Project.\nCovers federal and state courts, 1658–2020. 360 years of legal history.\n\nSearch by text keywords (FTS on preview), reporter series (e.g. f2d, us, s-ct), or text length.',
    table: 'us_court_opinions',
    selectColumns: 'id, reporter_series, author, text_length, text_preview',
    orderBy: 'text_length DESC',
    emptyMessage: 'No US court opinions found matching criteria',
    defaultLimit: 20,
    maxLimit: 50,
    fields: [
      { name: 'query', description: 'Full-text search in opinion text (English)', match: 'fts', columns: ['text_preview'] },
      { name: 'reporter', description: 'Reporter series (e.g. f2d, f3d, us, s-ct for Supreme Court)', match: 'exact', columns: ['reporter_series'] },
      { name: 'author', description: 'Author or URL containing court/jurisdiction info', match: 'ilike', columns: ['author'] },
    ],
  },

  us_sanctions_screening: {
    title: 'Sanctions & PEP Screening (1.26M entities)',
    description: 'Screen persons and entities against OFAC SDN, SAM.gov exclusions, and 100+ international sanctions/PEP lists via OpenSanctions.\n\n1.26M entities: 80% persons, 9% companies, 6% legal entities. Daily updates.\n\nUse for KYC/AML compliance, due diligence, counterparty screening.',
    table: 'opensanctions_entities',
    selectColumns: 'id, schema, name, aliases, birth_date, countries, addresses, identifiers, sanctions, datasets, first_seen, last_seen',
    orderBy: 'last_seen DESC NULLS LAST',
    emptyMessage: 'No sanctioned entities found matching criteria',
    fields: [
      { name: 'name', description: 'Person or entity name (fuzzy search)', match: 'fts_simple', columns: ['name'] },
      { name: 'aliases', description: 'Search in aliases/alternate names', match: 'ilike', columns: ['aliases'] },
      { name: 'schema', description: 'Entity type: Person, Company, LegalEntity, Organization, Vessel, CryptoWallet', match: 'exact', columns: ['schema'] },
      { name: 'countries', description: 'Country code (e.g. us, ru, ir, cn)', match: 'ilike', columns: ['countries'] },
      { name: 'datasets', description: 'Source dataset (e.g. us_ofac_sdn, us_sam_exclusions)', match: 'ilike', columns: ['datasets'] },
    ],
  },

  us_sec_filers: {
    title: 'SEC EDGAR Registered Filers (969K companies)',
    description: 'Search SEC-registered entities: public companies, funds, investment advisers, broker-dealers.\n\n969K filers with CIK, ticker, SIC industry code, EIN, state of incorporation, filing count.\nCovers all entities that file with the SEC.',
    table: 'us_sec_filers',
    selectColumns: 'cik, entity_name, entity_type, sic, sic_description, ticker, exchanges, ein, state_of_incorporation, fiscal_year_end, filing_count, category, state, city',
    orderBy: 'filing_count DESC NULLS LAST',
    emptyMessage: 'No SEC filers found matching criteria',
    fields: [
      { name: 'name', description: 'Company or entity name', match: 'ilike', columns: ['entity_name'] },
      { name: 'ticker', description: 'Stock ticker symbol (e.g. AAPL, TSLA)', match: 'exact', columns: ['ticker'], transform: 'uppercase' },
      { name: 'cik', description: 'SEC Central Index Key (10-digit number)', match: 'exact', columns: ['cik'] },
      { name: 'sic', description: 'SIC industry code (e.g. 7372 for software)', match: 'exact', columns: ['sic'] },
      { name: 'ein', description: 'Employer Identification Number', match: 'exact', columns: ['ein'] },
      { name: 'state', description: 'State of incorporation (2-letter code)', match: 'exact', columns: ['state_of_incorporation'], transform: 'uppercase' },
    ],
  },

  us_fec_contributions: {
    title: 'US Political Contributions (58M donations)',
    description: 'Search individual political contributions reported to the FEC.\n\n58M records from 2000–2024 election cycles. Contributions over $200 by individuals to federal candidates, PACs, party committees.\n\nFind who donated to whom, how much, employer/occupation of donors.',
    table: 'us_fec_contributions',
    selectColumns: 'contributor_name, city, state, zip_code, employer, occupation, transaction_date::text AS transaction_date, transaction_amount, committee_id, memo_text',
    orderBy: 'transaction_amount DESC NULLS LAST',
    emptyMessage: 'No FEC contributions found matching criteria',
    defaultLimit: 50,
    maxLimit: 100,
    requiredFields: ['donor'],
    fields: [
      { name: 'donor', description: 'Contributor name (LAST, FIRST format)', match: 'fts_simple', columns: ['contributor_name'] },
      { name: 'employer', description: 'Employer of contributor', match: 'ilike', columns: ['employer'] },
      { name: 'state', description: 'Donor state (2-letter code)', match: 'exact', columns: ['state'], transform: 'uppercase' },
      { name: 'committee', description: 'Recipient committee ID (e.g. C00401224)', match: 'exact', columns: ['committee_id'] },
      { name: 'min_amount', description: 'Minimum contribution amount ($)', match: 'gte', columns: ['transaction_amount'], type: 'number' },
      { name: 'occupation', description: 'Occupation of contributor', match: 'ilike', columns: ['occupation'] },
    ],
  },

  us_osha_enforcement: {
    title: 'OSHA Workplace Enforcement (377K employers)',
    description: 'Search OSHA enforcement history by employer.\n\n377K employers with citation counts, penalties, violation types (willful, repeat, serious).\nDate range: 2009–2026. Useful for vendor safety screening and due diligence.',
    table: 'us_osha_enforcement',
    selectColumns: 'employer_id, employer_name, city, state, naics_code, naics_description, parent_name, citation_count, inspection_count, penalties_current_total, willful_count, repeat_count, serious_count, earliest_citation::text AS earliest_citation, latest_citation::text AS latest_citation',
    orderBy: 'penalties_current_total DESC NULLS LAST',
    emptyMessage: 'No OSHA enforcement records found for this employer',
    fields: [
      { name: 'employer', description: 'Employer name', match: 'fts_simple', columns: ['employer_name'] },
      { name: 'parent', description: 'Parent company name', match: 'ilike', columns: ['parent_name'] },
      { name: 'state', description: 'State (2-letter code)', match: 'exact', columns: ['state'], transform: 'uppercase' },
      { name: 'naics', description: 'NAICS industry code', match: 'exact', columns: ['naics_code'] },
      { name: 'min_penalties', description: 'Minimum total penalties ($)', match: 'gte', columns: ['penalties_current_total'], type: 'number' },
    ],
  },

  us_epa_facilities: {
    title: 'EPA Regulated Facilities (3.2M sites)',
    description: 'Search EPA-regulated facilities across the US.\n\n3.2M facilities from the Facility Registry Service (FRS). Includes location, NAICS/SIC codes, EPA region.\nCovers facilities under Clean Air Act, Clean Water Act, RCRA, SDWA, TRI programs.',
    table: 'us_epa_facilities',
    selectColumns: 'registry_id, fac_name, fac_street, fac_city, fac_state, fac_zip, fac_county, fac_epa_region, fac_lat, fac_long, fac_naics_codes, fac_sic_codes',
    orderBy: 'fac_name',
    emptyMessage: 'No EPA facilities found matching criteria',
    fields: [
      { name: 'name', description: 'Facility name', match: 'fts_simple', columns: ['fac_name'] },
      { name: 'state', description: 'State (2-letter code)', match: 'exact', columns: ['fac_state'], transform: 'uppercase' },
      { name: 'city', description: 'City name', match: 'ilike', columns: ['fac_city'] },
      { name: 'zip', description: 'ZIP code', match: 'exact', columns: ['fac_zip'] },
      { name: 'naics', description: 'NAICS code (in comma-separated list)', match: 'ilike', columns: ['fac_naics_codes'] },
      { name: 'county', description: 'County name', match: 'ilike', columns: ['fac_county'] },
      { name: 'epa_region', description: 'EPA region number (01-10)', match: 'exact', columns: ['fac_epa_region'] },
    ],
  },

  us_cfpb_complaints: {
    title: 'CFPB Consumer Complaints (15M complaints)',
    description: 'Search consumer financial complaints from the CFPB database.\n\n15M complaints since 2011. Search by company, product, state, issue.\nUse for financial partner screening, complaint pattern analysis.',
    table: 'us_cfpb_complaints',
    selectColumns: 'complaint_id, date_received::text AS date_received, product_normalized as product, issue, company, state, company_response, timely_response, consumer_complaint_narrative',
    orderBy: 'date_received DESC NULLS LAST',
    emptyMessage: 'No CFPB complaints found matching criteria',
    defaultLimit: 30,
    requiredFields: ['company'],
    fields: [
      { name: 'company', description: 'Company name (bank, lender, servicer)', match: 'fts_simple', columns: ['company'] },
      { name: 'product', description: 'Product: Credit reporting, Mortgage, Bank account, Credit card / prepaid, Debt collection, etc.', match: 'exact', columns: ['product_normalized'] },
      { name: 'state', description: 'Consumer state (2-letter code)', match: 'exact', columns: ['state'], transform: 'uppercase' },
      { name: 'issue', description: 'Issue description', match: 'ilike', columns: ['issue'] },
    ],
  },

  us_fda_enforcement: {
    title: 'FDA Enforcement & Recalls (17.6K actions)',
    description: 'Search FDA drug and food enforcement actions (recalls).\n\n17.6K enforcement actions since 2011. Includes product description, reason for recall, classification (Class I/II/III), recalling firm.',
    table: 'us_fda_enforcement',
    selectColumns: 'recall_number, status, classification, product_type, recalling_firm, city, state, recall_initiation_date::text AS recall_initiation_date, reason_for_recall, product_description, distribution_pattern',
    orderBy: 'recall_initiation_date DESC NULLS LAST',
    emptyMessage: 'No FDA enforcement actions found',
    fields: [
      { name: 'firm', description: 'Recalling firm name', match: 'fts_simple', columns: ['recalling_firm'] },
      { name: 'product', description: 'Product description keywords', match: 'fts_simple', columns: ['product_description'] },
      { name: 'reason', description: 'Reason for recall keywords', match: 'ilike', columns: ['reason_for_recall'] },
      { name: 'classification', description: 'Risk class: Class I (dangerous), Class II (may cause harm), Class III (unlikely harm)', match: 'exact', columns: ['classification'] },
      { name: 'state', description: 'State (2-letter code)', match: 'exact', columns: ['state'], transform: 'uppercase' },
    ],
  },

  // ── M&A / antitrust / sanctions demo sources (migration 169) ──────
  // NOTE: РНБО sanctions are intentionally NOT here — that registry (opendata_drs_sanctions,
  // same official ДРС source) is served by the openreyestr_search_rnbo_sanctions tool, which
  // is refreshed from the same dump. Exposing a "Держреєстр санкцій (РНБО)" registry here too
  // made the chat pick search_registry over the intended openreyestr path (duplicate entry).

  nazk_war_sanctions: {
    title: 'Війна і санкції (ГУР)',
    description: "Пошук на порталі «Війна і санкції» (war-sanctions.gur.gov.ua). 18K записів у 14 категоріях: санкційні фізособи/юрособи, судна, тіньовий флот, rostec, виробники БПЛА, пропагандисти тощо. Пошук за іменем, категорією, ІПН, юрисдикцією санкцій.",
    table: 'opendata_nazk_war_sanctions',
    selectColumns: 'category, source_id, url, page_title, name_uk, tin, sanction_jurisdictions',
    orderBy: 'category ASC, source_id ASC',
    emptyMessage: 'Записів не знайдено',
    fields: [
      { name: 'name', description: "Ім'я / назва (укр або англ)", match: 'ilike_multi', columns: ['name_uk', 'page_title'] },
      { name: 'category', description: 'Категорія: sanctions_persons, sanctions_companies, transport_ships, transport_shadow-fleet, rostec, uav_companies, propaganda_persons тощо', match: 'exact', columns: ['category'] },
      { name: 'tin', description: 'ІПН / податковий номер', match: 'exact', columns: ['tin'] },
      { name: 'jurisdiction', description: 'Юрисдикція санкцій (USA, EU, UK, Canada, Switzerland, Australia, Japan, NZ)', match: 'ilike_cast', columns: ['sanction_jurisdictions'] },
    ],
  },

  amcu_bid_rigging: {
    title: 'АМКУ — спотворення торгів (антиконкурентні узгоджені дії)',
    description: 'Пошук у зведених відомостях АМКУ про спотворення результатів торгів (тендерів). 458K рядків. Пошук за назвою порушника, ЄДРПОУ, датою рішення.',
    table: 'opendata_amcu_bid_rigging',
    selectColumns: 'source_file, decision_date, entity_name, entity_edrpou, row_data',
    orderBy: 'decision_date DESC NULLS LAST',
    emptyMessage: 'Порушень не знайдено',
    fields: [
      { name: 'entity_name', description: 'Назва суб’єкта господарювання, який вчинив порушення', match: 'fts_simple', columns: ['entity_name'] },
      { name: 'edrpou', description: 'ЄДРПОУ / РНОКПП порушника', match: 'exact', columns: ['entity_edrpou'] },
      { name: 'date_from', description: 'Дата рішення від (YYYY-MM-DD)', match: 'gte', columns: ['decision_date'] },
      { name: 'date_to', description: 'Дата рішення до (YYYY-MM-DD)', match: 'lte', columns: ['decision_date'] },
    ],
  },

  amcu_decisions: {
    title: 'АМКУ — рішення та рекомендації',
    description: 'Пошук у рішеннях і рекомендаціях АМКУ (антимонопольна практика, концентрації, узгоджені дії). 6K документів; повнотекстовий пошук доступний для витягнутих текстів (docx). Пошук за текстом, номером рішення, типом, датою.',
    table: 'opendata_amcu_decisions',
    // left(body_text || '', 600): see the note above the UK block. Unguarded, this
    // registry raises `invalid byte sequence for encoding "UTF8": 0xd0` on prod
    // today — Cyrillic is two bytes, so a byte-slice lands mid-character far more
    // often than in English text.
    selectColumns: 'archive_file, doc_file, doc_kind, decision_no, decision_date, extracted, body_text',
    outerColumns: "t.archive_file, t.doc_file, t.doc_kind, t.decision_no, t.decision_date, t.extracted, left(t.body_text || '', 600) AS snippet",
    orderBy: 'decision_date DESC NULLS LAST',
    outerOrderBy: 't.decision_date DESC NULLS LAST',
    emptyMessage: 'Рішень АМКУ не знайдено',
    fields: [
      { name: 'text', description: 'Ключові слова у тексті рішення', match: 'fts_simple', columns: ['body_text'] },
      { name: 'doc_kind', description: 'Тип: rishennia (рішення), rekomendatsii (рекомендації), list (списки)', match: 'exact', columns: ['doc_kind'] },
      { name: 'decision_no', description: 'Номер рішення', match: 'ilike', columns: ['decision_no'] },
      { name: 'date_from', description: 'Дата від (YYYY-MM-DD)', match: 'gte', columns: ['decision_date'] },
      { name: 'date_to', description: 'Дата до (YYYY-MM-DD)', match: 'lte', columns: ['decision_date'] },
    ],
  },

  rada_stenograms: {
    title: 'ВРУ — стенограми пленарних засідань',
    description: 'Повнотекстовий пошук у стенограмах пленарних засідань Верховної Ради (намір законодавця). 6.8K документів усіх скликань. Пошук за текстом, скликанням, датою засідання, типом.',
    table: 'opendata_rada_stenograms',
    // Same detoast guard as amcu_decisions; unguarded this raises 0xd1 on prod.
    selectColumns: 'convocation, sitting_date, doc_kind, source_file, body_text',
    outerColumns: "t.convocation, t.sitting_date, t.doc_kind, t.source_file, left(t.body_text || '', 600) AS snippet",
    orderBy: 'sitting_date DESC NULLS LAST',
    outerOrderBy: 't.sitting_date DESC NULLS LAST',
    emptyMessage: 'Стенограм не знайдено',
    fields: [
      { name: 'text', description: 'Ключові слова у тексті стенограми', match: 'fts_simple', columns: ['body_text'] },
      { name: 'convocation', description: 'Номер скликання (1-9)', match: 'exact', columns: ['convocation'], type: 'number' },
      { name: 'doc_kind', description: 'Тип: stenogram (стенограма), agenda (порядок денний), stenpog (погоджувальна рада)', match: 'exact', columns: ['doc_kind'] },
      { name: 'date_from', description: 'Дата засідання від (YYYY-MM-DD)', match: 'gte', columns: ['sitting_date'] },
      { name: 'date_to', description: 'Дата засідання до (YYYY-MM-DD)', match: 'lte', columns: ['sitting_date'] },
    ],
  },
  // ── UK (legislation.gov.uk + Find Case Law) ───────────────────────
  //
  // English descriptions, following the us_* block: these registries are not
  // Ukrainian open data and the model answers about them in English.
  //
  // Two things below look like noise and are not.
  //
  // 1. `left(col || '', n)` rather than `left(col, n)`. On PostgreSQL 15.16
  //    a bare left()/substr() over a TOASTed text value takes the byte-slice
  //    path and can fail outright with `invalid byte sequence for encoding
  //    "UTF8"`. Measured on prod 2026-08-25: 341 of the 54,453 judgments raise
  //    it, 0.63%, while length() over the same column is fine on every row —
  //    the data is valid, the slice is not. Concatenating an empty string
  //    forces a full detoast first. Verified over all 54,453 judgments and all
  //    1,262,603 provisions with no error.
  //
  // 2. The table name in orderBy. `decision_date::text AS decision_date` puts
  //    an output alias in scope, and a bare ORDER BY binds to the alias, so the
  //    sort would run on text rather than on the date column. ISO dates happen
  //    to sort identically, but qualifying the name keeps the sort on the real
  //    column and lets the btree index stay eligible.

  uk_legislation: {
    attribution: 'Contains public sector information licensed under the Open Government Licence v3.0. Source: legislation.gov.uk, The National Archives.',
    title: 'UK Legislation Register (158K acts)',
    description: `The UK statute book from legislation.gov.uk: 158,317 items with 254,814 point-in-time versions. Acts of Parliament (ukpga), Statutory Instruments (uksi), Welsh SIs (wsi), Northern Ireland Orders in Council (nisi), Church Measures (ukcm), Local and Private Acts (ukla, ukppa), and pre-Union acts (aep, apgb). Open Government Licence v3.0.

Use this to identify an act and read its status. Provision text lives in uk_legislation_provisions; amendments in uk_legislation_effects.

unapplied_effects on a row is the editorial backlog: changes that are law but not yet written into the published text.`,
    table: 'uk_legislation',
    selectColumns: "id, leg_type, year, number, title, document_status, extent, enactment_date::text AS enactment_date, made_date::text AS made_date, coming_into_force::text AS coming_into_force, version_count, unapplied_effects, source_url",
    orderBy: 'year DESC NULLS LAST, id',
    emptyMessage: 'No UK legislation found matching criteria',
    fields: [
      { name: 'title', description: 'Act or instrument title, e.g. "Companies Act"', match: 'ilike', columns: ['title'] },
      { name: 'id', description: 'legislation.gov.uk identifier, e.g. ukpga/2006/46', match: 'exact', columns: ['id'] },
      { name: 'leg_type', description: 'ukpga (Act of Parliament), uksi (Statutory Instrument), wsi, nisi, ukcm, ukla, ukppa, aep, apgb', match: 'exact', columns: ['leg_type'] },
      { name: 'year', description: 'Year of the act or instrument', match: 'exact', columns: ['year'], type: 'number' },
      { name: 'number', description: 'Chapter or SI number within the year', match: 'exact', columns: ['number'] },
      { name: 'status', description: 'revised (point-in-time text maintained) or final (enacted text only)', match: 'exact', columns: ['document_status'] },
      { name: 'year_from', description: 'Year from', match: 'gte', columns: ['year'], type: 'number' },
      { name: 'year_to', description: 'Year to', match: 'lte', columns: ['year'], type: 'number' },
    ],
  },

  uk_legislation_provisions: {
    attribution: 'Contains public sector information licensed under the Open Government Licence v3.0. Source: legislation.gov.uk, The National Archives.',
    title: 'UK Legislation Text (1.26M provisions)',
    description: `Full-text search over 1,262,603 provisions — sections, articles, regulations, schedule paragraphs — of UK legislation, with the version date each one belongs to.

Coverage caveat, measured rather than assumed: only 70,296 of the 158,317 items in the register have machine-readable text. The other 88,021 are published by legislation.gov.uk as scanned PDFs only (mostly pre-1988 Statutory Instruments and Local Acts), so a search that finds nothing for an older instrument means there is no text to search, not that the instrument does not exist.

Rows are per version, so one section can appear several times with different valid_from dates; the newest is returned first.`,
    table: 'uk_legislation_provisions',
    selectColumns: 'leg_id, valid_from::text AS valid_from, provision_label, provision_type, title, n_chars, provision_uri, text',
    outerColumns: "t.leg_id, t.valid_from, t.provision_label, t.provision_type, t.title, t.n_chars, t.provision_uri, left(t.text || '', 800) AS snippet",
    orderBy: 'uk_legislation_provisions.valid_from DESC NULLS LAST, leg_id, ord',
    // `ord` is not carried out of the subquery, so the outer sort tie-breaks on
    // leg_id only. The inner ORDER BY has already chosen the page; this just
    // fixes the order it is presented in.
    outerOrderBy: 't.valid_from DESC NULLS LAST, t.leg_id',
    emptyMessage: 'No UK legislation text found matching criteria',
    defaultLimit: 20,
    maxLimit: 50,
    fields: [
      { name: 'query', description: 'Full-text search in provision text (English)', match: 'fts', columns: ['text'] },
      { name: 'leg_id', description: 'Restrict to one act, e.g. ukpga/2006/46', match: 'exact', columns: ['leg_id'] },
      { name: 'label', description: 'Provision label, e.g. "s. 172" or "reg. 4"', match: 'ilike', columns: ['provision_label'] },
      { name: 'provision_type', description: 'section, article, regulation, rule, paragraph, schedule', match: 'exact', columns: ['provision_type'] },
      { name: 'heading', description: 'Provision heading', match: 'ilike', columns: ['title'] },
      { name: 'version_from', description: 'Version in force from (YYYY-MM-DD)', match: 'gte', columns: ['valid_from'] },
      { name: 'version_to', description: 'Version in force up to (YYYY-MM-DD)', match: 'lte', columns: ['valid_from'] },
    ],
  },

  uk_legislation_effects: {
    attribution: 'Contains public sector information licensed under the Open Government Licence v3.0. Source: legislation.gov.uk, The National Archives.',
    title: 'UK Changes to Legislation (1.21M amendments)',
    description: `Every amendment legislation.gov.uk publishes: 1,213,289 effects, stated by the source rather than inferred from diffs. Each row says which provision of which act was changed, by which provision of which other act, of what kind, and from when.

990,458 are applied — already written into the published text. 222,831 are NOT: they are law but the editorial text has not caught up, and they are invisible to anyone reading the act. 32,766 acts carry such a backlog.

Search by the act that was changed (affected), by the act doing the changing (affecting), or by effect type.`,
    table: 'uk_legislation_effects',
    selectColumns: "effect_id, affected_id, affected_title, affected_provisions, effect_type, applied, in_force_date::text AS in_force_date, affecting_id, affecting_title, affecting_provisions, commencement_authority, notes",
    orderBy: 'uk_legislation_effects.in_force_date DESC NULLS LAST',
    emptyMessage: 'No UK amendments found matching criteria',
    fields: [
      { name: 'affected', description: 'Act that was changed, e.g. ukpga/2006/46', match: 'exact', columns: ['affected_id'] },
      { name: 'affected_title', description: 'Title of the act that was changed', match: 'ilike', columns: ['affected_title'] },
      { name: 'affecting', description: 'Act making the change, e.g. ukpga/2026/21', match: 'exact', columns: ['affecting_id'] },
      { name: 'affecting_title', description: 'Title of the act making the change', match: 'ilike', columns: ['affecting_title'] },
      { name: 'effect_type', description: 'coming into force, words substituted, inserted, repealed, omitted, revoked', match: 'ilike', columns: ['effect_type'] },
      { name: 'applied', description: 'true = already in the published text; false = outstanding editorial backlog', match: 'exact', columns: ['applied'], type: 'boolean' },
      { name: 'affected_year', description: 'Year of the act that was changed', match: 'exact', columns: ['affected_year'], type: 'number' },
      { name: 'in_force_from', description: 'In force from (YYYY-MM-DD)', match: 'gte', columns: ['in_force_date'] },
      { name: 'in_force_to', description: 'In force up to (YYYY-MM-DD)', match: 'lte', columns: ['in_force_date'] },
    ],
  },

  uk_court_decisions: {
    attribution: 'Contains information licensed under the Open Justice - Licence v2.0. Source: Find Case Law, The National Archives.',
    title: 'UK Court Judgments (54K decisions)',
    description: `54,453 judgments from Find Case Law (The National Archives), 2001-2026, full text on 99.95% of rows. UK Supreme Court, Court of Appeal (Civil), High Court (Chancery, Administrative, Commercial, Family), Privy Council and UK tribunals.

Coverage gaps worth knowing before relying on a nil result: no Court of Appeal (Criminal), no Scotland, no Northern Ireland, and the Administrative Court series stops at 2016.

Licence: Find Case Law judgments are published under the Open Justice Licence. Rows carry the licence they arrived under.`,
    table: 'uk_court_decisions',
    selectColumns: 'id, neutral_citation, case_number, court_code, court_name, decision_date::text AS decision_date, judge, parties, licence, source_url, full_text',
    outerColumns: "t.id, t.neutral_citation, t.case_number, t.court_code, t.court_name, t.decision_date, t.judge, t.parties, t.licence, t.source_url, left(t.full_text || '', 400) AS snippet",
    orderBy: 'uk_court_decisions.decision_date DESC NULLS LAST',
    outerOrderBy: 't.decision_date DESC NULLS LAST',
    emptyMessage: 'No UK judgments found matching criteria',
    defaultLimit: 20,
    maxLimit: 50,
    fields: [
      // ftsExpression reproduces idx_uk_court_fts verbatim. Searching full_text
      // alone would not match the index and would sequentially scan 2 GB.
      {
        name: 'query',
        description: 'Full-text search across parties, abstract and judgment text (English)',
        match: 'fts',
        columns: ['full_text'],
        ftsExpression: "COALESCE(parties, '') || ' ' || COALESCE(abstract, '') || ' ' || COALESCE(full_text, '')",
      },
      { name: 'citation', description: 'Neutral citation, e.g. [2021] UKSC 20', match: 'ilike', columns: ['neutral_citation'] },
      { name: 'case_number', description: 'Court case number', match: 'exact', columns: ['case_number'] },
      { name: 'court', description: 'Court code, e.g. uksc, ewca/civ, ewhc/ch, ewhc/admin, ewhc/comm, ewhc/fam, ukpc', match: 'exact', columns: ['court_code'] },
      { name: 'parties', description: 'Party names', match: 'ilike', columns: ['parties'] },
      { name: 'judge', description: 'Judge name', match: 'ilike', columns: ['judge'] },
      { name: 'date_from', description: 'Decision date from (YYYY-MM-DD)', match: 'gte', columns: ['decision_date'] },
      { name: 'date_to', description: 'Decision date to (YYYY-MM-DD)', match: 'lte', columns: ['decision_date'] },
    ],
  },
};
