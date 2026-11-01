-- Migration 238: longer download timeout for НАЗК's corruption-offenders API (LEXAI-2183)
--
-- After migration 237, every source of that batch loaded on prod except
-- nazk_corruption_offenders: tasks 1769 and 1772 failed with
-- «Відкритий API (getAllData): Request timeout» after ~3 minutes. From cthulhu,
-- https://corruptinfo.nazk.gov.ua/ep/1.0/corrupt/getAllData answers 200 with 55.6 MB, but
-- its first byte arrives only after ~163 s (168 s in total). The importer abandoned a
-- download after 60 s without data, three attempts in a row.
--
-- source_config.download_timeout_ms (new, default 60000) sets that idle timeout per source;
-- this source gets 10 minutes. The data.gov.ua JSON copies in the same dataset are not a
-- usable fallback: the newest is from 2024-11-05 (49,957 records vs 31,294 live, entries
-- since removed from the register) and would pass the 0.9 row-ratio guard.
--
-- Data repair = one run after deploy:
--   POST /api/tools/start_import {"name":"start_import","arguments":{"source_name":"nazk_corruption_offenders"}}
--
-- Idempotent: sets one key of one row.

UPDATE import_source_catalog
   SET source_config = coalesce(source_config, '{}'::jsonb) || jsonb_build_object('download_timeout_ms', 600000)
 WHERE name = 'nazk_corruption_offenders';
