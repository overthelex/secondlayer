\set ON_ERROR_STOP on
DROP TABLE IF EXISTS ae_stage_leg;
CREATE TABLE ae_stage_leg(j jsonb);
\copy ae_stage_leg(j) FROM '/tmp/ae_legislation.jsonl' WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')
SELECT count(*) AS staged, count(DISTINCT j->>'doc_id') AS distinct_ids FROM ae_stage_leg;

INSERT INTO ae_legislation (doc_id, jurisdiction, law_id, title, law_type, law_number, law_year,
                            language, full_text, text_source, source_url, pdf_url,
                            content_sha256, metadata_json)
SELECT DISTINCT ON (j->>'doc_id')
    j->>'doc_id', j->>'jurisdiction', (j->>'law_id')::int, j->>'title', j->>'law_type',
    j->>'law_number', NULLIF(j->>'law_year','')::int, j->>'language', j->>'full_text',
    j->>'text_source', j->>'source_url', j->>'pdf_url', j->>'content_sha256', j->'metadata_json'
FROM ae_stage_leg
ORDER BY j->>'doc_id', length(j->>'full_text') DESC NULLS LAST
ON CONFLICT (doc_id) DO UPDATE SET
    full_text = EXCLUDED.full_text, title = EXCLUDED.title, law_type = EXCLUDED.law_type,
    law_number = EXCLUDED.law_number, law_year = EXCLUDED.law_year,
    content_sha256 = EXCLUDED.content_sha256, metadata_json = EXCLUDED.metadata_json,
    text_source = EXCLUDED.text_source, updated_at = now();
DROP TABLE ae_stage_leg;

\echo '=== loaded ==='
SELECT count(*) AS laws, count(*) FILTER (WHERE law_year IS NOT NULL) AS with_year,
       min(law_year) AS first_year, max(law_year) AS last_year,
       pg_size_pretty(sum(length(full_text))::bigint) AS text_volume
FROM ae_legislation;
\echo '=== by type ==='
SELECT coalesce(law_type,'(unparsed)') AS law_type, count(*) FROM ae_legislation GROUP BY 1 ORDER BY 2 DESC;
\echo '=== arabic FTS on legislation ==='
EXPLAIN (ANALYZE, TIMING OFF, SUMMARY OFF, COSTS OFF)
SELECT count(*) FROM ae_legislation
WHERE to_tsvector('arabic', coalesce(title,'')||' '||coalesce(full_text,''))
      @@ plainto_tsquery('arabic','التحكيم');
