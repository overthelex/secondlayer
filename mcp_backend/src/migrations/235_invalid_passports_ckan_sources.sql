-- Migration 235: invalid passports import from the re-published МВС datasets (LEXAI-2181)
--
-- opendata_invalid_passports (2,887,669 rows) and opendata_invalid_passports_foreign
-- (195,387 rows) were last loaded on 2026-03-27. Every daily opendata-sync run since
-- 2026-04-16 failed with «Cannot download JSON» (168 + 167 failed import_tasks by
-- 2026-11-01): the catalog pointed at fixed resource URLs that now return 404.
--
-- In April 2026 МВС re-published both registers under new dataset ids (the old ids survive
-- as the datasets' slugs):
--   * internal passports: dataset 41d166e9-d1b8-4a54-8e0a-363b02e2f11d (slug ab09ed00-…),
--     26 regional files mvswantedpassport_vNN.json (+ a schema file), modified ~2026-05-01;
--     3,013,271 records, 2,889,765 distinct ID (duplicates differ in INSERT_DATE/OVD/status).
--   * foreign passports: dataset 247b7401-481d-4d03-88a5-6609670b6bc1 (slug b465b821-…),
--     mvswantedpassport_z.json (passports for travel abroad, 198,619) and
--     mvswantedpassport_m.json (seafarer IDs, 801); 195,582 distinct ID.
-- Record format is unchanged (ID, OVD, D_SERIES, D_NUMBER, D_TYPE, D_STATUS, THEFT_DATA,
-- INSERT_DATE) and series are already Latin.
--
-- The catalog now names the dataset instead of a file: the importer resolves the resource
-- list with CKAN package_show on every run (source_config.ckan_package + resource_pattern),
-- streams every file into a staging table, refuses to swap if the result is < 90% of the
-- current row count or fewer than min_files matched, and then brings the table to the new
-- content in one transaction. Duplicate IDs keep the record with the latest insert_date.
-- Series go through the same normalizePassportSeries() the search tool uses. Runs are
-- skipped while no resource changed since the last successful load.
--
-- Data repair = one run of each source after deploy (or wait for the 04:00 / 04:15 cron):
--   POST /api/tools/start_import {"name":"start_import","arguments":{"source_name":"invalid_passports"}}
--   POST /api/tools/start_import {"name":"start_import","arguments":{"source_name":"invalid_passports_foreign"}}
--
-- Idempotent: catalog rows upsert by name.

INSERT INTO import_source_catalog (name, title, source_type, source_url, source_config, target_table, default_threads_per_ip, rate_limit_ms)
VALUES (
  'invalid_passports',
  'МВС — Недійсні паспорти',
  'json_array',
  'https://data.gov.ua/dataset/41d166e9-d1b8-4a54-8e0a-363b02e2f11d',
  jsonb_build_object(
    'format',           'json',
    'ckan_package',     '41d166e9-d1b8-4a54-8e0a-363b02e2f11d',
    'resource_pattern', '^mvswantedpassport_v\d+\.json$',
    'min_files',        20,
    'replace',          true,
    'unique_key',       jsonb_build_array('id'),
    'dedup_order',      'insert_date',
    'min_rows_ratio',   0.9,
    'skip_unchanged',   true,
    'mapping', jsonb_build_object(
      'id',          'ID',
      'ovd',         'OVD',
      'd_series',    'D_SERIES',
      'd_number',    'D_NUMBER',
      'd_type',      'D_TYPE',
      'd_status',    'D_STATUS',
      'theft_date',  'THEFT_DATA',
      'insert_date', 'INSERT_DATE'
    ),
    'transforms', jsonb_build_object(
      'd_series',    'passport_series',
      'theft_date',  'iso_date',
      'insert_date', 'iso_date'
    )
  ),
  'opendata_invalid_passports', 1, 0
)
ON CONFLICT (name) DO UPDATE SET
  title = EXCLUDED.title, source_type = EXCLUDED.source_type, source_url = EXCLUDED.source_url,
  source_config = EXCLUDED.source_config, target_table = EXCLUDED.target_table, enabled = true;

INSERT INTO import_source_catalog (name, title, source_type, source_url, source_config, target_table, default_threads_per_ip, rate_limit_ms)
VALUES (
  'invalid_passports_foreign',
  'МВС — Недійсні закордонні паспорти',
  'json_array',
  'https://data.gov.ua/dataset/247b7401-481d-4d03-88a5-6609670b6bc1',
  jsonb_build_object(
    'format',           'json',
    'ckan_package',     '247b7401-481d-4d03-88a5-6609670b6bc1',
    'resource_pattern', '^mvswantedpassport_(?!shema)[a-z0-9_]+\.json$',
    'min_files',        2,  -- _z (passports) + _m (seafarer IDs): losing _m would not trip the row-ratio guard
    'replace',          true,
    'unique_key',       jsonb_build_array('id'),
    'dedup_order',      'insert_date',
    'min_rows_ratio',   0.9,
    'skip_unchanged',   true,
    'mapping', jsonb_build_object(
      'id',          'ID',
      'ovd',         'OVD',
      'd_series',    'D_SERIES',
      'd_number',    'D_NUMBER',
      'd_type',      'D_TYPE',
      'd_status',    'D_STATUS',
      'theft_date',  'THEFT_DATA',
      'insert_date', 'INSERT_DATE'
    ),
    'transforms', jsonb_build_object(
      'd_series',    'passport_series',
      'theft_date',  'iso_date',
      'insert_date', 'iso_date'
    )
  ),
  'opendata_invalid_passports_foreign', 1, 0
)
ON CONFLICT (name) DO UPDATE SET
  title = EXCLUDED.title, source_type = EXCLUDED.source_type, source_url = EXCLUDED.source_url,
  source_config = EXCLUDED.source_config, target_table = EXCLUDED.target_table, enabled = true;
