-- Court names and case numbers the PL decision rows do not carry in their own columns.
--
-- Common-court judgments (SAOS COMMON, ncourt, hf-pl-court-raw) identify the court by an 8-digit
-- code: the first 8 digits of the portal feed id (SAOS source_url `id=`, ncourt courtId,
-- hf court_id). 426K SAOS rows and every ncourt row have no court_name, but the same codes appear
-- on 49K SAOS rows and 9.9K hf rows that do, so the code -> name table is read off the data
-- itself (303 codes, 15.11.2026: covers 439,369 of 440,942 unnamed rows). Where one code has
-- several spellings ("Sąd Apelacyjnyw Warszawie", renamed Stargard), the most frequent wins.
--
-- hf-pl-nsa (1.9M rows) and hf-pl-court-raw keep the case number in metadata_json->>'docket_number'.
--
-- Both are resolved at read time (pl-legal-tools.ts courtNameSql / caseNumberSql) instead of
-- rewriting the rows: an update of 2.3M rows of this 105 GB table is not a HOT update and would
-- re-insert every row into the full-text GIN index.
--
-- On pg-lawrider the expression index was built by hand with CREATE INDEX CONCURRENTLY;
-- IF NOT EXISTS makes this a no-op there.

CREATE TABLE IF NOT EXISTS pl_court_codes (
  code   TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  n_rows INTEGER NOT NULL
);

INSERT INTO pl_court_codes (code, name, n_rows)
SELECT code, name, n FROM (
  SELECT code, name, n, row_number() OVER (PARTITION BY code ORDER BY n DESC, name) AS rk FROM (
    SELECT code, name, sum(n)::int AS n FROM (
      SELECT substring(source_url FROM 'id=(\d{8})') AS code, court_name AS name, count(*) AS n
      FROM pl_court_decisions
      WHERE source = 'saos' AND court_type = 'COMMON' AND court_name IS NOT NULL
      GROUP BY 1, 2
      UNION ALL
      SELECT metadata_json->>'court_id', court_name, count(*)
      FROM pl_court_decisions
      WHERE source = 'hf-pl-court-raw' AND court_name IS NOT NULL
      GROUP BY 1, 2
    ) x WHERE code IS NOT NULL GROUP BY 1, 2
  ) y
) z
WHERE rk = 1 AND NOT EXISTS (SELECT 1 FROM pl_court_codes)
ON CONFLICT (code) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_pl_court_case_num_any ON pl_court_decisions
  ((coalesce(case_number, metadata_json->>'docket_number')));
