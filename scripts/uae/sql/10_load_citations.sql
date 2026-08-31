\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS ae_case_legislation_citations (
    citation_id text PRIMARY KEY,
    doc_id      text NOT NULL,
    law_type    text,          -- normalised from the wording used in the judgment
    kind_ar     text,          -- the wording itself
    law_number  text,
    law_year    int,
    law_id      int,           -- resolved against ae_legislation, null when unknown
    resolution  text,          -- how it was resolved, so weak links stay visible
    articles    text[],        -- article numbers named beside the citation
    mentions    int,
    raw         text,
    imported_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ae_cit_doc ON ae_case_legislation_citations (doc_id);
CREATE INDEX IF NOT EXISTS idx_ae_cit_law ON ae_case_legislation_citations (law_id);
CREATE INDEX IF NOT EXISTS idx_ae_cit_numyear ON ae_case_legislation_citations (law_number, law_year);

DROP TABLE IF EXISTS ae_stage_cit;
CREATE TABLE ae_stage_cit(j jsonb);
\copy ae_stage_cit(j) FROM '/tmp/citations.jsonl' WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')
SELECT count(*) AS staged FROM ae_stage_cit;

INSERT INTO ae_case_legislation_citations (citation_id, doc_id, law_type, kind_ar,
        law_number, law_year, articles, mentions, raw)
SELECT DISTINCT ON (j->>'citation_id')
    j->>'citation_id', j->>'doc_id', j->>'law_type', j->>'kind_ar',
    j->>'law_number', (j->>'law_year')::int,
    ARRAY(SELECT jsonb_array_elements_text(j->'articles')),
    NULLIF(j->>'mentions','')::int, j->>'raw'
FROM ae_stage_cit
ORDER BY j->>'citation_id'
ON CONFLICT (citation_id) DO UPDATE SET
    articles = EXCLUDED.articles, mentions = EXCLUDED.mentions;
DROP TABLE ae_stage_cit;

-- Resolution runs strongest-first and records which rule fired, so a weak link
-- can be filtered out later rather than being indistinguishable from a firm one.
UPDATE ae_case_legislation_citations c SET law_id = l.law_id, resolution = 'type+number+year'
FROM ae_legislation l
WHERE c.law_id IS NULL AND l.law_number = c.law_number AND l.law_year = c.law_year
  AND l.law_type = c.law_type;

UPDATE ae_case_legislation_citations c SET law_id = u.law_id, resolution = 'number+year'
FROM (SELECT law_number, law_year, min(law_id) AS law_id
      FROM ae_legislation WHERE law_number IS NOT NULL AND law_year IS NOT NULL
      GROUP BY 1, 2 HAVING count(*) = 1) u
WHERE c.law_id IS NULL AND u.law_number = c.law_number AND u.law_year = c.law_year;

-- Judgment -> article, wherever the cited article exists in the article corpus.
CREATE OR REPLACE VIEW ae_case_article_citations AS
SELECT c.doc_id, c.law_id, c.law_number, c.law_year, art AS article_no,
       a.article_id, a.article_label, a.text AS article_text
FROM ae_case_legislation_citations c
CROSS JOIN LATERAL unnest(c.articles) AS art
LEFT JOIN ae_legislation_articles a
       ON a.law_id = c.law_id AND a.article_no = art
WHERE c.law_id IS NOT NULL;

\echo '=== citations ==='
SELECT count(*) AS citations, count(DISTINCT doc_id) AS judgments,
       count(law_id) AS resolved, count(DISTINCT law_id) AS distinct_acts,
       count(*) FILTER (WHERE cardinality(articles) > 0) AS with_article_numbers
FROM ae_case_legislation_citations;

\echo '=== how they resolved ==='
SELECT coalesce(resolution, 'unresolved') AS rule, count(*)
FROM ae_case_legislation_citations GROUP BY 1 ORDER BY 2 DESC;

\echo '=== citing judgments per source ==='
SELECT d.source, count(DISTINCT d.doc_id) AS judgments_total,
       count(DISTINCT c.doc_id) AS judgments_citing
FROM ae_court_decisions d
LEFT JOIN ae_case_legislation_citations c USING (doc_id)
GROUP BY 1 ORDER BY 2 DESC;

\echo '=== most-cited acts ==='
SELECT c.law_id, c.law_number, c.law_year, l.law_type,
       count(DISTINCT c.doc_id) AS citing_judgments
FROM ae_case_legislation_citations c JOIN ae_legislation l USING (law_id)
GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC LIMIT 15;

\echo '=== judgment -> article edges that land on a real article ==='
SELECT count(*) AS article_edges,
       count(article_id) AS matched_an_article_we_hold,
       count(DISTINCT doc_id) AS judgments
FROM ae_case_article_citations;
