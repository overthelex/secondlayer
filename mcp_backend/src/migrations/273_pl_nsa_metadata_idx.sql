-- Filters on the NSA/WSA metadata of pl_court_decisions (pl_search_court_decisions: authority,
-- case_symbol, judge, final).
--
-- hf-pl-nsa (1.9M rows) leaves the judges/keywords/legal_bases columns empty and keeps everything
-- in metadata_json: challenged_authority (organ name), case_type_description (array of NSA symbols
-- with their description, "6110 Podatek od towarów i usług"), judges / presiding_judge /
-- judge_rapporteur, finality ("orzeczenie prawomocne" / "orzeczenie nieprawomocne"),
-- related_docket_numbers, keywords, thesis. pl_get_court_decision reads them at query time
-- (pl-legal-tools.ts); the rows are not rewritten: an update of 1.9M rows of this 105 GB table is
-- not a HOT update and would re-insert every row into the full-text GIN index.
--
-- The filters do not use expression indexes on pl_court_decisions. metadata_json of an NSA row is
-- ~8 KB compressed and lives in TOAST, so a trigram match is rechecked by detoasting every
-- candidate: measured 15.11.2026, "odsetki" + authority took 37 s, + case_symbol 45 s. This narrow
-- copy of the four filter fields (~2.5M rows) is rechecked in-row instead.
--
-- hf-pl-nsa and hf-pl-court-raw are snapshot imports, SAOS/ncourt carry judges in the column.
-- After an import that adds such rows: REFRESH MATERIALIZED VIEW CONCURRENTLY pl_decision_meta.
-- A schema-only dump leaves it empty: refresh it after a restore.
--
-- symbols holds every 3- and 4-digit prefix of each NSA symbol code ({611, 6110, 658}), so
-- case_symbol is an exact array match. judges is the bench as "Name Surname; ..." text.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE MATERIALIZED VIEW IF NOT EXISTS pl_decision_meta AS
SELECT d.id, d.decision_date,
       nullif(btrim(d.metadata_json->>'challenged_authority'), '') AS authority,
       nullif(ARRAY(
         SELECT DISTINCT left(c.code, l)
         FROM (SELECT substring(x FROM '^\d+') AS code
               FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(d.metadata_json->'case_type_description') = 'array'
                                                   THEN d.metadata_json->'case_type_description' END) x) c,
              generate_series(3, length(c.code)) l
         WHERE c.code IS NOT NULL ORDER BY 1), '{}') AS symbols,
       nullif(array_to_string(CASE
         WHEN jsonb_typeof(d.judges) = 'array' AND jsonb_array_length(d.judges) > 0
           THEN ARRAY(SELECT coalesce(j->>'name', j #>> '{}') FROM jsonb_array_elements(d.judges) j)
         WHEN jsonb_typeof(d.metadata_json->'judges') = 'array'
           THEN ARRAY(SELECT jsonb_array_elements_text(d.metadata_json->'judges'))
         WHEN d.metadata_json->>'presiding_judge' IS NOT NULL THEN ARRAY[d.metadata_json->>'presiding_judge'] END, '; '), '') AS judges,
       CASE d.metadata_json->>'finality' WHEN 'orzeczenie prawomocne' THEN true
                                         WHEN 'orzeczenie nieprawomocne' THEN false END AS final
FROM pl_court_decisions d
WHERE d.source IN ('hf-pl-nsa', 'hf-pl-court-raw')
   OR (jsonb_typeof(d.judges) = 'array' AND jsonb_array_length(d.judges) > 0);

-- On pg-lawrider these were built by hand (CREATE INDEX CONCURRENTLY), then ANALYZE pl_decision_meta.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pl_decision_meta_id ON pl_decision_meta (id);
CREATE INDEX IF NOT EXISTS idx_pl_decision_meta_authority ON pl_decision_meta USING gin (authority gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_pl_decision_meta_symbols ON pl_decision_meta USING gin (symbols);
CREATE INDEX IF NOT EXISTS idx_pl_decision_meta_judges ON pl_decision_meta USING gin (judges gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_pl_decision_meta_final ON pl_decision_meta (final, decision_date);
CREATE INDEX IF NOT EXISTS idx_pl_decision_meta_date ON pl_decision_meta (decision_date);
