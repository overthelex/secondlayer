-- Migration 237: import catalog sources whose data.gov.ua resources moved (LEXAI-2183)
--
-- Ten catalog rows from migration 125 pointed at fixed resource URLs that return 404, and
-- every scheduled run failed with «Cannot download JSON» (23-170 failed import_tasks each,
-- none ever completed). The rows also had no mapping, so even a successful download would
-- only have logged «upsert skipped». The tables were filled once by hand in March 2026.
--
-- Six sources move to the CKAN path from LEXAI-2181 (resources resolved with package_show
-- on every run, all files streamed into staging, guarded swap in one transaction). That
-- path now also reads CSV and small XLSX files (source_config.format), can take only the
-- newest of several dated snapshots (latest_only) and filter resources by CKAN format.
--
--   source                     dataset (id / slug)                       format      file vs table (01.11.2026)
--   advocates                  e1af20b8-… НААУ «Єдиний реєстр адвокатів»   JSON 234 MB 74,000 vs 72,839
--   court_schedule             3a321301-… ДСА «Список справ призначених…»  TSV 400 MB  587,740 vs 480,686
--   nazk_corruption_offenders  560e5f5d-… НАЗК, resource format "API"     JSON 55 MB  31,294 vs 28,833
--   nazk_declaration_checks    144a7349-… НАЗК «Результати повної перевірки» CSV       2,005 vs 2,005
--   large_taxpayers            36cabc4a-… ДПС «Реєстр великих платників»   CSV (;)     1,343 vs 1,343
--   state_aid                  16fcf128-… (slug) АМКУ «Реєстр держдопомоги» XLSX      354 vs 355 (misparsed)
--
-- nazk_corruption_offenders reads НАЗК's live API resource, not the JSON dumps in the
-- dataset (last one 2024-11, 49,957 records incl. entries since removed from the register).
-- Its resource last_modified is from 2021 and never changes, so skip_unchanged is off.
-- state_aid: the March load took the Ukrainian label row as data and left decision_date /
-- amount empty; this config skips that row and maps amount (theAmountOfStateAid).
--
-- Four sources are disabled (startImport now refuses a disabled source):
--   dsfmu_terrorism   the XLSX is a «LegalActs» sheet linking to fiu.gov.ua, not the list of
--                     persons; the 3 rows in opendata_terrorism_persons are its header rows.
--   judge_candidates  ВККС publishes three XLSX lists (адміністративні / загальні /
--                     господарські суди) the table cannot tell apart; not updated since
--                     2024-11-12; the table holds the 645-row administrative list.
--   lustration        one ZIP of windows-1251 XML, unchanged since 2024-07-02; 587 records,
--                     the table holds the same 587.
--   wage_debtors      a 7z of 25 regional .xls as of 25.02.2019, unchanged since 2019-03-11;
--                     the table already holds that snapshot.
--
-- Data repair = one run of each migrated source after deploy (all are guarded):
--   POST /api/tools/start_import {"name":"start_import","arguments":{"source_name":"<name>"}}
--
-- Idempotent: catalog rows upsert by name; the disables are plain UPDATEs.

INSERT INTO import_source_catalog (name, title, source_type, source_url, source_config, target_table, default_threads_per_ip, rate_limit_ms)
VALUES (
  'advocates',
  'НААУ — Єдиний реєстр адвокатів України',
  'json_array',
  'https://data.gov.ua/dataset/e1af20b8-c80b-4f2c-bf82-566567ef936e',
  jsonb_build_object(
    'format',           'json',
    'ckan_package',     'e1af20b8-c80b-4f2c-bf82-566567ef936e',
    'resource_pattern', '^register-[0-9-]+\.json$',
    'latest_only',      true,
    'min_files',        1,
    'replace',          true,
    'min_rows_ratio',   0.9,
    'skip_unchanged',   true,
    'mapping', jsonb_build_object(
      'source_id',            'ID',
      'family_name',          'familyName',
      'name',                 'name',
      'additional_name',      'additionalName',
      'ra_name',              'raName',
      'decision_num',         'decisionNum',
      'decision_date',        'decisionDate',
      'certificate_num',      'certificateNum',
      'certificate_date',     'certificateDate',
      'authority_name',       'authorityName',
      'other_info',           'otherinfo',
      'email',                'email',
      'status',               'status',
      'status_description',   'statusDescription',
      'work_address',         'workAddress',
      'additional_addresses', 'additionalAddresses',
      'org_forms',            'orgforms'
    ),
    'transforms', jsonb_build_object('status_description', 'join')
  ),
  'opendata_advocates', 1, 0
)
ON CONFLICT (name) DO UPDATE SET
  title = EXCLUDED.title, source_type = EXCLUDED.source_type, source_url = EXCLUDED.source_url,
  source_config = EXCLUDED.source_config, target_table = EXCLUDED.target_table, enabled = true;

INSERT INTO import_source_catalog (name, title, source_type, source_url, source_config, target_table, default_threads_per_ip, rate_limit_ms)
VALUES (
  'court_schedule',
  'ДСА — Список справ, призначених до розгляду',
  'json_array',
  'https://data.gov.ua/dataset/3a321301-a06f-487b-9d19-e6b917250aee',
  jsonb_build_object(
    'format',           'csv',
    'csv_delimiter',    E'\t',
    'ckan_package',     '3a321301-a06f-487b-9d19-e6b917250aee',
    'resource_pattern', '^spisok-sprav-priznachenih-do-rozglyadu\.csv$',
    'min_files',        1,
    'replace',          true,
    -- A rolling window of future hearings: the size moves with the calendar (480,686 in
    -- March, 587,740 on 01.11), so the guard only catches a load that collapsed.
    'min_rows_ratio',   0.7,
    'skip_unchanged',   true,
    'mapping', jsonb_build_object(
      'hearing_date',     'date',
      'judges',           'judges',
      'case_number',      'case',
      'court_name',       'court_name',
      'court_room',       'court_room',
      'case_involved',    'case_involved',
      'case_description', 'case_description'
    )
  ),
  'opendata_court_schedule', 1, 0
)
ON CONFLICT (name) DO UPDATE SET
  title = EXCLUDED.title, source_type = EXCLUDED.source_type, source_url = EXCLUDED.source_url,
  source_config = EXCLUDED.source_config, target_table = EXCLUDED.target_table, enabled = true;

INSERT INTO import_source_catalog (name, title, source_type, source_url, source_config, target_table, default_threads_per_ip, rate_limit_ms)
VALUES (
  'nazk_corruption_offenders',
  'НАЗК — Єдиний державний реєстр осіб, які вчинили корупційні правопорушення',
  'json_array',
  'https://data.gov.ua/dataset/560e5f5d-0b8b-491e-a0b1-72eb08602edc',
  jsonb_build_object(
    'format',           'json',
    'ckan_package',     '560e5f5d-0b8b-491e-a0b1-72eb08602edc',
    'resource_format',  'API',
    'resource_pattern', '^getAllData$',
    'min_files',        1,
    'replace',          true,
    'min_rows_ratio',   0.9,
    'skip_unchanged',   false,
    'mapping', jsonb_build_object(
      'source_id',         'id',
      'punishment_type',   'punishmentType.name',
      'entity_type',       'entityType.name',
      'last_name',         'indLastNameOnOffenseMoment',
      'first_name',        'indFirstNameOnOffenseMoment',
      'patronymic',        'indPatronymicOnOffenseMoment',
      'offense_id',        'offenseId',
      'offense_name',      'offenseName',
      'punishment',        'punishment',
      'court_case_number', 'courtCaseNumber',
      'sentence_date',     'sentenceDate',
      'sentence_number',   'sentenceNumber',
      'punishment_start',  'punishmentStart',
      'court_id',          'courtId',
      'court_name',        'courtName',
      'codex_articles',    'codexArticles'
    )
  ),
  'opendata_corruption_offenders', 1, 0
)
ON CONFLICT (name) DO UPDATE SET
  title = EXCLUDED.title, source_type = EXCLUDED.source_type, source_url = EXCLUDED.source_url,
  source_config = EXCLUDED.source_config, target_table = EXCLUDED.target_table, enabled = true;

INSERT INTO import_source_catalog (name, title, source_type, source_url, source_config, target_table, default_threads_per_ip, rate_limit_ms)
VALUES (
  'nazk_declaration_checks',
  'НАЗК — Результати повних перевірок декларацій',
  'json_array',
  'https://data.gov.ua/dataset/144a7349-4349-4211-9a5a-d58e98558673',
  jsonb_build_object(
    'format',           'csv',
    'csv_delimiter',    ',',
    'ckan_package',     '144a7349-4349-4211-9a5a-d58e98558673',
    'resource_pattern', '^declarationcheck\.csv$',
    'min_files',        1,
    'replace',          true,
    'min_rows_ratio',   0.9,
    'skip_unchanged',   true,
    'mapping', jsonb_build_object(
      'declaration_uid',   'declarationUid',
      'uid',               'uid',
      'family_name',       'familyName',
      'name',              'name',
      'additional_name',   'additionalName',
      'position',          'position',
      'position_category', 'positionCategory',
      'reporting_period',  'reportingPeriod',
      'status',            'status',
      'result',            'result',
      'result_url',        'resultUrl',
      'measures',          'measures',
      'completion_year',   'completionYear'
    )
  ),
  'opendata_declaration_checks', 1, 0
)
ON CONFLICT (name) DO UPDATE SET
  title = EXCLUDED.title, source_type = EXCLUDED.source_type, source_url = EXCLUDED.source_url,
  source_config = EXCLUDED.source_config, target_table = EXCLUDED.target_table, enabled = true;

INSERT INTO import_source_catalog (name, title, source_type, source_url, source_config, target_table, default_threads_per_ip, rate_limit_ms)
VALUES (
  'large_taxpayers',
  'ДПС — Реєстр великих платників податків',
  'json_array',
  'https://data.gov.ua/dataset/36cabc4a-f172-450d-a906-64cf28cdb34b',
  jsonb_build_object(
    'format',           'csv',
    'csv_delimiter',    ';',
    'ckan_package',     '36cabc4a-f172-450d-a906-64cf28cdb34b',
    'resource_pattern', '\.csv$',
    'latest_only',      true,   -- one file per year's list (2019, 2022 so far)
    'min_files',        1,
    'replace',          true,
    'min_rows_ratio',   0.5,    -- a new year's list may legitimately be much shorter
    'skip_unchanged',   true,
    'mapping', jsonb_build_object(
      'edrpou', 'Код за ЄДРПОУ платника податків',
      'name',   'Найменування платника податків'
    )
  ),
  'opendata_large_taxpayers', 1, 0
)
ON CONFLICT (name) DO UPDATE SET
  title = EXCLUDED.title, source_type = EXCLUDED.source_type, source_url = EXCLUDED.source_url,
  source_config = EXCLUDED.source_config, target_table = EXCLUDED.target_table, enabled = true;

INSERT INTO import_source_catalog (name, title, source_type, source_url, source_config, target_table, default_threads_per_ip, rate_limit_ms)
VALUES (
  'state_aid',
  'АМКУ — Реєстр державної допомоги',
  'json_array',
  'https://data.gov.ua/dataset/16fcf128-1a28-41d5-8081-3dfffe68b397',
  jsonb_build_object(
    'format',           'xlsx',
    'ckan_package',     '16fcf128-1a28-41d5-8081-3dfffe68b397',
    'resource_pattern', '^reestr_dd_.*\.xlsx$',
    'latest_only',      true,   -- a dated snapshot per release (reestr_dd_27_10_2026-1.xlsx)
    'header_row',       1,      -- English field names
    'skip_rows',        1,      -- second header row with Ukrainian labels
    'min_files',        1,
    'replace',          true,
    'min_rows_ratio',   0.9,
    'skip_unchanged',   true,
    'mapping', jsonb_build_object(
      'row_data',         '',
      'program_name',     'nameOfProgram',
      'provider_edrpou',  'EDRPOU',
      'provider_name',    'theOneWhoProvidesStateAid',
      'recipient_edrpou', 'EDRPOU_2',
      'recipient_name',   'oneWhoReceivesStateAid',
      'decision_date',    'dateOfDecision',
      'amount',           'theAmountOfStateAid'
    ),
    'transforms', jsonb_build_object(
      'provider_edrpou',  'trim',
      'recipient_edrpou', 'trim',
      'decision_date',    'iso_date',
      'amount',           'number'
    )
  ),
  'opendata_state_aid', 1, 0
)
ON CONFLICT (name) DO UPDATE SET
  title = EXCLUDED.title, source_type = EXCLUDED.source_type, source_url = EXCLUDED.source_url,
  source_config = EXCLUDED.source_config, target_table = EXCLUDED.target_table, enabled = true;

UPDATE import_source_catalog SET enabled = false,
  source_config = coalesce(source_config, '{}'::jsonb) || jsonb_build_object('disabled_reason',
    'LEXAI-2183: XLSX набору ДСФМУ a140de93 містить лише посилання на перелік (LegalActs), а не самих осіб')
WHERE name = 'dsfmu_terrorism';

UPDATE import_source_catalog SET enabled = false,
  source_config = coalesce(source_config, '{}'::jsonb) || jsonb_build_object('disabled_reason',
    'LEXAI-2183: ВККС публікує три окремі XLSX-рейтинги (адмін./загальні/господарські суди), таблиця їх не розрізняє; набір 98684f72 не оновлювався з 12.11.2024')
WHERE name = 'judge_candidates';

UPDATE import_source_catalog SET enabled = false,
  source_config = coalesce(source_config, '{}'::jsonb) || jsonb_build_object('disabled_reason',
    'LEXAI-2183: ZIP з XML (windows-1251), не оновлювався з 02.07.2024; таблиця містить ті самі 587 записів')
WHERE name = 'lustration';

UPDATE import_source_catalog SET enabled = false,
  source_config = coalesce(source_config, '{}'::jsonb) || jsonb_build_object('disabled_reason',
    'LEXAI-2183: набір Мінсоцполітики 20b9c337 — 7z з 25 XLS станом на 25.02.2019, не оновлювався з 11.03.2019; таблиця вже містить цей зріз')
WHERE name = 'wage_debtors';
