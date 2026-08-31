\set ON_ERROR_STOP on
DROP TABLE IF EXISTS ae_stage_moj;
CREATE TABLE ae_stage_moj(j jsonb);
\copy ae_stage_moj(j) FROM '/tmp/ae_moj_fsc.jsonl' WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')
SELECT count(*) AS staged, count(DISTINCT j->>'doc_id') AS distinct_ids FROM ae_stage_moj;

INSERT INTO ae_court_decisions (doc_id, source, jurisdiction, court_name, court_level,
                                case_number, case_title, decision_date, language,
                                decision_type, full_text, text_source, source_url, pdf_url,
                                content_sha256, metadata_json)
SELECT DISTINCT ON (j->>'doc_id')
    j->>'doc_id', j->>'source', j->>'jurisdiction', j->>'court_name', j->>'court_level',
    j->>'case_number', j->>'case_title', NULLIF(j->>'decision_date','')::date,
    j->>'language', j->>'decision_type', j->>'full_text', j->>'text_source',
    j->>'source_url', j->>'pdf_url', j->>'content_sha256', j->'metadata_json'
FROM ae_stage_moj
ORDER BY j->>'doc_id', length(j->>'full_text') DESC NULLS LAST
ON CONFLICT (doc_id) DO UPDATE SET
    full_text = EXCLUDED.full_text, case_title = EXCLUDED.case_title,
    case_number = EXCLUDED.case_number, decision_date = EXCLUDED.decision_date,
    decision_type = EXCLUDED.decision_type, text_source = EXCLUDED.text_source,
    content_sha256 = EXCLUDED.content_sha256, metadata_json = EXCLUDED.metadata_json,
    updated_at = now();
DROP TABLE ae_stage_moj;

\echo '=== Federal Supreme Court loaded ==='
SELECT count(*) AS judgments,
       count(*) FILTER (WHERE text_source = 'ocr') AS ocred,
       min(decision_date) AS first, max(decision_date) AS last,
       pg_size_pretty(sum(length(full_text))::bigint) AS text_volume
FROM ae_court_decisions WHERE source = 'moj_fsc';
\echo '=== by year ==='
SELECT extract(year FROM decision_date)::int AS yr, count(*)
FROM ae_court_decisions WHERE source = 'moj_fsc' GROUP BY 1 ORDER BY 1;
\echo '=== by chamber ==='
SELECT decision_type, count(*) FROM ae_court_decisions
WHERE source = 'moj_fsc' GROUP BY 1 ORDER BY 2 DESC;
\echo '=== whole AE corpus ==='
SELECT source, count(*), min(decision_date) AS first, max(decision_date) AS last
FROM ae_court_decisions GROUP BY 1 ORDER BY 2 DESC;
