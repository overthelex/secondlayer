-- LEXAI-2173: search_court_case_status returned stage_date «29.02.2424» (990/326/23) and
-- «01.12.2323» (9901/221/21), and those rows sorted first.
--
-- The typos are in the ДСА source, not in our parsing: the export of 30.10.2026 still has
-- 9901/221/21 at «01.12.2323» (990/326/23 has since been corrected there to 29.02.2024),
-- plus ~115 other mistyped years («15.02.0180», «25.05.5018», «28.08.9022»). The table was
-- loaded verbatim as text. The importer (src/scripts/import-court-case-status.ts) now
-- normalises dates via court-case-status-dates.ts; this applies the same rules to the
-- stored rows:
--   * a doubled two-digit year (2323, 2424, 2121 …) becomes 20YY when that is plausible;
--   * any other year outside 1991 .. next year, or an impossible day/month, becomes NULL.
-- Prod snapshot 31.10.2026 (1,249,720 rows): stage_date 12 repaired + 99 nulled,
-- registration_date 2 repaired + 1 nulled.
-- Idempotent: after one run no stored value matches the WHERE clauses any more. The casts
-- sit inside CASE so they only run on values that matched the date pattern.

UPDATE opendata_court_case_status
   SET stage_date = substr(stage_date, 1, 6) || '20' || substr(stage_date, 9, 2)
 WHERE CASE WHEN stage_date ~ '^\d{2}\.\d{2}\.(2[0-9])\1$'
         THEN substr(stage_date, 7, 4)::int > extract(year FROM now())::int + 1
          AND ('20' || substr(stage_date, 9, 2))::int <= extract(year FROM now())::int + 1
         ELSE false END;

UPDATE opendata_court_case_status
   SET registration_date = substr(registration_date, 1, 6) || '20' || substr(registration_date, 9, 2)
 WHERE CASE WHEN registration_date ~ '^\d{2}\.\d{2}\.(2[0-9])\1$'
         THEN substr(registration_date, 7, 4)::int > extract(year FROM now())::int + 1
          AND ('20' || substr(registration_date, 9, 2))::int <= extract(year FROM now())::int + 1
         ELSE false END;

UPDATE opendata_court_case_status
   SET stage_date = NULL
 WHERE CASE WHEN stage_date ~ '^\d{2}\.\d{2}\.\d{4}$'
         THEN substr(stage_date, 7, 4)::int NOT BETWEEN 1991 AND extract(year FROM now())::int + 1
           OR substr(stage_date, 4, 2)::int NOT BETWEEN 1 AND 12
           OR substr(stage_date, 1, 2)::int NOT BETWEEN 1 AND 31
         ELSE false END;

UPDATE opendata_court_case_status
   SET registration_date = NULL
 WHERE CASE WHEN registration_date ~ '^\d{2}\.\d{2}\.\d{4}$'
         THEN substr(registration_date, 7, 4)::int NOT BETWEEN 1991 AND extract(year FROM now())::int + 1
           OR substr(registration_date, 4, 2)::int NOT BETWEEN 1 AND 12
           OR substr(registration_date, 1, 2)::int NOT BETWEEN 1 AND 31
         ELSE false END;

-- The catalog entry pointed at a dataset that data.gov.ua no longer serves (every weekly
-- start_import since 19.04.2026 failed with «Cannot download JSON»), and json_array without
-- mapping/unique_key could never have loaded it anyway. Point it at the live ДСА dataset and
-- disable it: the source is a ~0.9 GB ZIP of TSV files, loaded by the script above.
UPDATE import_source_catalog
   SET source_url = 'https://data.gov.ua/dataset/0ad60ea9-b029-456d-abc0-8c77a99b205c',
       source_type = 'file_download',
       enabled = false
 WHERE name = 'court_case_status'
   AND source_url <> 'https://data.gov.ua/dataset/0ad60ea9-b029-456d-abc0-8c77a99b205c';
