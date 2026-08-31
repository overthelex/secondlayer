\set ON_ERROR_STOP on

DROP TABLE IF EXISTS ae_stage_laws, ae_stage_amend, ae_stage_change;
CREATE TABLE ae_stage_laws(j jsonb);
CREATE TABLE ae_stage_amend(j jsonb);
CREATE TABLE ae_stage_change(j jsonb);
\copy ae_stage_laws(j)   FROM '/tmp/leg_laws.jsonl'       WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')
\copy ae_stage_amend(j)  FROM '/tmp/leg_amendments.jsonl' WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')
\copy ae_stage_change(j) FROM '/tmp/leg_changes.jsonl'    WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')
SELECT (SELECT count(*) FROM ae_stage_laws)   AS laws,
       (SELECT count(*) FROM ae_stage_amend)  AS amendments,
       (SELECT count(*) FROM ae_stage_change) AS changes;

UPDATE ae_legislation l SET
    issue_date     = NULLIF(s.j->>'issue_date','')::date,
    effective_date = NULLIF(s.j->>'effective_date','')::date,
    gazette_date   = NULLIF(s.j->>'gazette_date','')::date,
    gazette_number = s.j->>'gazette_number',
    status         = s.j->>'status',
    status_ar      = s.j->>'status_ar',
    last_update    = NULLIF(s.j->>'last_update','')::date,
    amendments_count = NULLIF(s.j->>'amendments_declared','')::int,
    updated_at     = now()
FROM ae_stage_laws s
WHERE l.law_id = (s.j->>'law_id')::int;

INSERT INTO ae_legislation_amendments (amendment_id, law_id, modification_id, amend_date,
        amend_year, amend_date_raw, amending_title, amending_pdf_url, articles_changed)
SELECT DISTINCT ON (j->>'amendment_id')
    j->>'amendment_id', (j->>'law_id')::int, NULLIF(j->>'modification_id','')::int,
    NULLIF(j->>'amend_date','')::date, NULLIF(j->>'amend_year','')::int,
    j->>'amend_date_raw', j->>'amending_title', j->>'amending_pdf_url',
    NULLIF(j->>'articles_changed','')::int
FROM ae_stage_amend
ORDER BY j->>'amendment_id'
ON CONFLICT (amendment_id) DO UPDATE SET
    amend_date = EXCLUDED.amend_date, amending_title = EXCLUDED.amending_title,
    articles_changed = EXCLUDED.articles_changed;

INSERT INTO ae_legislation_article_changes (change_id, amendment_id, law_id, seq,
        article_label, article_no, new_text, previous_text, new_sha256,
        previous_sha256, previous_versions, text_changed)
SELECT DISTINCT ON (j->>'change_id')
    j->>'change_id', j->>'amendment_id', (j->>'law_id')::int, NULLIF(j->>'seq','')::int,
    j->>'article_label', j->>'article_no', j->>'new_text', j->>'previous_text',
    j->>'new_sha256', j->>'previous_sha256', NULLIF(j->>'previous_versions','')::int,
    (j->>'text_changed')::boolean
FROM ae_stage_change
ORDER BY j->>'change_id'
ON CONFLICT (change_id) DO UPDATE SET
    new_text = EXCLUDED.new_text, previous_text = EXCLUDED.previous_text,
    new_sha256 = EXCLUDED.new_sha256, previous_sha256 = EXCLUDED.previous_sha256,
    text_changed = EXCLUDED.text_changed;

-- Resolve each amending act to the act in our corpus, by its number and year.
UPDATE ae_legislation_amendments a SET amending_law_id = l.law_id
FROM ae_legislation l
WHERE a.amending_law_id IS NULL
  AND l.law_number IS NOT NULL AND l.law_year IS NOT NULL
  AND a.amending_title ~ ('رقم[^0-9]{0,4}' || l.law_number || '[^0-9]')
  AND a.amending_title LIKE '%لسنة ' || l.law_year || '%';

DROP TABLE ae_stage_laws, ae_stage_amend, ae_stage_change;

\echo '=== acts with publication metadata ==='
SELECT count(*) AS acts,
       count(issue_date) AS with_issue_date,
       count(gazette_number) AS with_gazette,
       count(*) FILTER (WHERE status = 'in_force') AS in_force,
       count(*) FILTER (WHERE status = 'repealed') AS repealed
FROM ae_legislation;

\echo '=== amendments ==='
SELECT count(*) AS amendments,
       count(DISTINCT law_id) AS laws_amended,
       count(amending_law_id) AS linked_to_an_act_we_hold,
       min(amend_date) AS first, max(amend_date) AS last
FROM ae_legislation_amendments;

\echo '=== article-level changes ==='
SELECT count(*) AS changes,
       count(*) FILTER (WHERE previous_text IS NOT NULL) AS with_previous_text,
       count(*) FILTER (WHERE text_changed) AS text_actually_differs,
       count(DISTINCT law_id) AS laws
FROM ae_legislation_article_changes;

\echo '=== amendments per decade ==='
SELECT (amend_year / 10) * 10 AS decade, count(*)
FROM ae_legislation_amendments WHERE amend_year IS NOT NULL GROUP BY 1 ORDER BY 1;

\echo '=== most-amended acts ==='
-- Identify acts by number and year, never by a prefix of the text: both left()
-- and substring() raise a spurious "invalid byte sequence" on these columns.
SELECT a.law_id, l.law_type, l.law_number, l.law_year, count(*) AS amendments
FROM ae_legislation_amendments a LEFT JOIN ae_legislation l USING (law_id)
GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC LIMIT 10;

\echo '=== most recent article changes ==='
SELECT law_id, article_label, amend_date,
       length(text_before) AS len_before, length(text_after) AS len_after
FROM ae_legislation_article_history
WHERE text_changed ORDER BY amend_date DESC LIMIT 8;
