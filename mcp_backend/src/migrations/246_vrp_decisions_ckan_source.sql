-- Migration 246: ВРП decisions as an importable CKAN source (LEXAI-2126)
--
-- vrp_decisions was loaded once (2026-03-23) by a script that is not in any repo and stopped
-- at 2026-02-25. data.gov.ua dataset 4b4dc451 publishes a cumulative decisions_YYYY-MM-DD.json
-- (2023-11-23 onwards; the 2026-08-31 file runs to 2026-09-22). Every matching JSON resource
-- is loaded into staging, deduplicated on the stable ВРП id, and swapped in one transaction
-- (min_rows_ratio guard). proceedingId and texts are JSON lists for TEXT[] columns, hence
-- pg_text_array; votingResult (list of objects) goes to jsonb as JSON text.
--
-- Data repair = one run after deploy:
--   POST /api/tools/start_import {"name":"start_import","arguments":{"source_name":"vrp_decisions"}}
-- opendata-sync then runs it every Sunday.
--
-- Idempotent: catalog row upserts by name.

INSERT INTO import_source_catalog (name, title, source_type, source_url, source_config, target_table, default_threads_per_ip, rate_limit_ms)
VALUES (
  'vrp_decisions',
  'ВРП — Рішення Вищої ради правосуддя та її органів',
  'json_array',
  'https://data.gov.ua/dataset/4b4dc451-414f-40e3-88e8-c642eb9b2f31',
  jsonb_build_object(
    'format',              'json',
    'ckan_package',        '4b4dc451-414f-40e3-88e8-c642eb9b2f31',
    'resource_pattern',    '^decisions_\d{4}-\d{2}-\d{2}\.json$',
    'replace',             true,
    'unique_key',          jsonb_build_array('id'),
    'dedup_order',         'date_time',
    'min_rows_ratio',      0.9,
    'skip_unchanged',      true,
    'download_timeout_ms', 600000,
    'mapping', jsonb_build_object(
      'id',             'id',
      'date_time',      'dateTime',
      'authority',      'authority',
      'title',          'title',
      'decision_num',   'decisionNum',
      'proceeding_ids', 'proceedingId',
      'voting_title',   'votingTitle',
      'voting_for',     'votingFor',
      'voting_against', 'votingAgainst',
      'voting_type',    'votingType',
      'voting_result',  'votingResult',
      'texts',          'texts'
    ),
    'transforms', jsonb_build_object(
      'proceeding_ids', 'pg_text_array',
      'texts',          'pg_text_array'
    )
  ),
  'vrp_decisions', 1, 0
)
ON CONFLICT (name) DO UPDATE SET
  title = EXCLUDED.title, source_type = EXCLUDED.source_type, source_url = EXCLUDED.source_url,
  source_config = EXCLUDED.source_config, target_table = EXCLUDED.target_table, enabled = true;
