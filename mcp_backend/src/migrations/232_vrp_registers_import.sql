-- Migration 231: VRP (Вища рада правосуддя) judge registers as importable sources (LEXAI-2117)
--
-- vrp_dismissed_judges / vrp_suspended_judges / vrp_interference_reports were loaded once
-- (2026-03-23) by a script that is not in any repo, and judge_name came out empty in all
-- 738 rows. In all three data.gov.ua datasets the name column is the only header with a
-- typographic apostrophe: «Прізвище, ім’я, по батькові судді» (U+2019). Every other column
-- loaded; this one did not.
--
-- This migration registers the three datasets in import_source_catalog as json_array sources
-- with an explicit column mapping and replace=true (DELETE + INSERT in one transaction:
-- the registers have no stable key, «№» is renumbered on every release). The importer
-- matches keys apostrophe-insensitively and refuses to replace a table when a mapped
-- field is absent from the source, so an all-NULL column cannot be loaded again.
--
-- Data repair = one run of each source after deploy:
--   POST /api/tools/start_import {"name":"start_import","arguments":{"source_name":"vrp_dismissed_judges"}}
--   (likewise vrp_suspended_judges, vrp_interference_reports); opendata-sync runs them every Sunday.
--
-- Idempotent: tables are created only where missing (prod already has them), catalog rows upsert.

CREATE TABLE IF NOT EXISTS vrp_dismissed_judges (
  id                    SERIAL PRIMARY KEY,
  row_num               TEXT,
  judge_name            TEXT,
  court_name            TEXT,
  applicant             TEXT,
  reporter              TEXT,
  panel_decision_date   TEXT,
  panel_decision_num    TEXT,
  vrp_decision_date_num TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vrp_dismissed_court ON vrp_dismissed_judges (court_name);
CREATE INDEX IF NOT EXISTS idx_vrp_dismissed_judge_name ON vrp_dismissed_judges (judge_name);

CREATE TABLE IF NOT EXISTS vrp_suspended_judges (
  id                  SERIAL PRIMARY KEY,
  row_num             TEXT,
  judge_name          TEXT,
  court_name          TEXT,
  applicant           TEXT,
  reporter            TEXT,
  suspension_body     TEXT,
  decision_date       TEXT,
  decision_num        TEXT,
  suspension_reason   TEXT,
  suspension_deadline TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vrp_suspended_court ON vrp_suspended_judges (court_name);
CREATE INDEX IF NOT EXISTS idx_vrp_suspended_judge_name ON vrp_suspended_judges (judge_name);

CREATE TABLE IF NOT EXISTS vrp_interference_reports (
  id            SERIAL PRIMARY KEY,
  row_num       TEXT,
  judge_name    TEXT,
  court_name    TEXT,
  applicant     TEXT,
  reporter      TEXT,
  received_date TEXT,
  case_num      TEXT,
  check_result  TEXT,
  reaction      TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vrp_interference_court ON vrp_interference_reports (court_name);
CREATE INDEX IF NOT EXISTS idx_vrp_interference_judge_name ON vrp_interference_reports (judge_name);

-- ── Catalog ────────────────────────────────────────────────────────────
-- Resource URLs are the data.gov.ua resources ВРП updates in place (last_modified 2026-10-26).

INSERT INTO import_source_catalog (name, title, source_type, source_url, source_config, target_table, default_threads_per_ip, rate_limit_ms)
VALUES (
  'vrp_dismissed_judges',
  'ВРП — Судді, звільнені за істотний дисциплінарний проступок',
  'json_array',
  'https://data.gov.ua/dataset/50b36663-8a71-4453-926c-fd6ae1102aab/resource/cd82acaa-0e9f-4cf8-a95e-1e54966367d8/download/offense.json',
  jsonb_build_object(
    'format',  'json',
    'replace', true,
    'mapping', jsonb_build_object(
      'row_num',               '№',
      'judge_name',            'Прізвище, ім’я, по батькові судді',
      'court_name',            'Назва суду',
      'applicant',             'Автор звернення',
      'reporter',              'Доповідач',
      'panel_decision_date',   'Дата прийняття рішення палатою / Дата рішення ВККСУ',
      'panel_decision_num',    'Номер рішення палати / Номер рекомендації ВККСУ',
      'vrp_decision_date_num', 'Дата та номер рішення ВРП'
    )
  ),
  'vrp_dismissed_judges', 1, 1100
)
ON CONFLICT (name) DO UPDATE SET
  title = EXCLUDED.title, source_type = EXCLUDED.source_type, source_url = EXCLUDED.source_url,
  source_config = EXCLUDED.source_config, target_table = EXCLUDED.target_table;

INSERT INTO import_source_catalog (name, title, source_type, source_url, source_config, target_table, default_threads_per_ip, rate_limit_ms)
VALUES (
  'vrp_suspended_judges',
  'ВРП — Відсторонення суддів від здійснення правосуддя',
  'json_array',
  'https://data.gov.ua/dataset/f57b3f05-2709-4e95-8b60-dd2338076fef/resource/13cdde34-a54f-4fc6-9473-aeb1f347062e/download/release.json',
  jsonb_build_object(
    'format',  'json',
    'replace', true,
    'mapping', jsonb_build_object(
      'row_num',             '№',
      'judge_name',          'Прізвище, ім’я, по батькові судді',
      'court_name',          'Назва суду',
      'applicant',           'Автор звернення',
      'reporter',            'Доповідач',
      'suspension_body',     'Орган, що прийняв рішення про відсторонення',
      'decision_date',       'Дата прийняття рішення',
      'decision_num',        'Номер рішення',
      'suspension_reason',   'Підстава прийняття рішення про тимчасове відсторонення',
      'suspension_deadline', 'Граничний строк дії відсторонення'
    )
  ),
  'vrp_suspended_judges', 1, 1100
)
ON CONFLICT (name) DO UPDATE SET
  title = EXCLUDED.title, source_type = EXCLUDED.source_type, source_url = EXCLUDED.source_url,
  source_config = EXCLUDED.source_config, target_table = EXCLUDED.target_table;

-- The interference register has no «Автор звернення» column, so applicant stays NULL.
INSERT INTO import_source_catalog (name, title, source_type, source_url, source_config, target_table, default_threads_per_ip, rate_limit_ms)
VALUES (
  'vrp_interference_reports',
  'ВРП — Реєстр повідомлень суддів про втручання',
  'json_array',
  'https://data.gov.ua/dataset/44438a21-0538-4d33-a3f1-5693a77cc70c/resource/47ab5993-656c-43bc-93e2-2c796b476b0b/download/intervention.json',
  jsonb_build_object(
    'format',  'json',
    'replace', true,
    'mapping', jsonb_build_object(
      'row_num',       '№',
      'judge_name',    'Прізвище, ім’я, по батькові судді',
      'court_name',    'Назва суду',
      'reporter',      'Доповідач',
      'received_date', 'Дата надходження',
      'case_num',      'Справа № / документ',
      'check_result',  'Результат перевірки - рішення ВРП',
      'reaction',      'Реагування на рішення ВРП'
    )
  ),
  'vrp_interference_reports', 1, 1100
)
ON CONFLICT (name) DO UPDATE SET
  title = EXCLUDED.title, source_type = EXCLUDED.source_type, source_url = EXCLUDED.source_url,
  source_config = EXCLUDED.source_config, target_table = EXCLUDED.target_table;
