-- Migration 295: retire opendata_corruption (НАЗК «Реєстр корупціонерів», old feed).
--
-- Since LEXAI-2312 (PR #2794) the corruption_register registry reads
-- opendata_corruption_offenders, which the CKAN feed reloads as a whole. The old table
-- was upserted by record_id from corruptinfo.nazk.gov.ua and never deleted anything:
-- on prod 2026-11-20 it held the same 31,302 current records plus 35,190 that NAZK no
-- longer publishes. Nothing reads it any more (analyze_data now allows the offenders
-- table instead) and opendata-sync no longer schedules the nazk_corruption source.
-- A full CSV and schema backup was taken on local.lex before this migration.
DO $$
BEGIN
  IF to_regclass('public.import_source_catalog') IS NOT NULL THEN
    UPDATE import_source_catalog SET enabled = false WHERE name = 'nazk_corruption';
  END IF;
END $$;
DROP TABLE IF EXISTS opendata_corruption;
