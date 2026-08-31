\set ON_ERROR_STOP on

-- Judgments name an act more loosely than the corpus types it: "القانون رقم 42
-- لسنة 2022" says nothing about decree versus law, and the same number and year
-- can belong to several instruments.  These passes relax the match in defined
-- steps and record which step fired, so a firm link and a weaker one never look
-- alike downstream.
--
-- What does NOT work, and was tried: ranking the candidates by how specific the
-- instrument type is.  It resolves everything and is confidently wrong - the
-- Arbitration Law 6/2018 came out as the supplementary budget decree 6/2018,
-- which is a plausible-looking edge that would quietly poison the graph.  The
-- subject phrase a judgment gives alongside the number ("بشأن التحكيم") is the
-- signal that actually distinguishes them, and where there is no subject phrase
-- the citation is left unresolved rather than guessed.

DROP VIEW IF EXISTS ae_legislation_type_rank;
CREATE VIEW ae_legislation_type_rank AS
SELECT law_id, law_number, law_year, law_type,
       CASE WHEN law_type IN ('resolution', 'cabinet_resolution',
                              'ministerial_resolution', 'regulation')
            THEN 'res' ELSE 'law' END AS family
FROM ae_legislation
WHERE law_number IS NOT NULL AND law_year IS NOT NULL;

-- Undo the ranked guesses from any earlier run of this script.
UPDATE ae_case_legislation_citations
SET law_id = NULL, resolution = NULL
WHERE resolution IN ('family+number+year (ambiguous)', 'subject+number+year');

-- Pass 3: same number, year and type family, and only one act qualifies.
WITH unique_family AS (
    SELECT law_number, law_year, family, min(law_id) AS law_id
    FROM ae_legislation_type_rank GROUP BY 1, 2, 3 HAVING count(*) = 1)
UPDATE ae_case_legislation_citations c
SET law_id = u.law_id, resolution = 'family+number+year'
FROM unique_family u
WHERE c.law_id IS NULL AND u.law_number = c.law_number AND u.law_year = c.law_year
  AND u.family = CASE WHEN c.law_type IN ('resolution', 'cabinet_resolution',
                                          'ministerial_resolution', 'regulation')
                      THEN 'res' ELSE 'law' END;

-- Pass 4: several acts share the number and year, so decide on the subject the
-- judgment named alongside it.
--
-- word_similarity, not similarity: the subject is a short phrase and the title
-- is long, and plain trigram similarity drowns the signal - on decree-law
-- 33/2021 it scored the right act 0.095 and the wrong one 0.057, while
-- word_similarity gave 0.42 against 0.16. A win must also clear the runner-up by
-- a margin, so that a genuinely undecidable pair is left unresolved instead of
-- being decided by noise.
WITH subj AS (
    SELECT citation_id, law_number, law_year,
           substring(regexp_replace(raw, '\s+', ' ', 'g')
                     from '(?:بشأن|في شأن|بإصدار)\s+(.{6,60})') AS subject
    FROM ae_case_legislation_citations
    WHERE law_id IS NULL),
scored AS (
    SELECT s.citation_id, l.law_id,
           word_similarity(s.subject, l.title) AS sim,
           row_number() OVER (PARTITION BY s.citation_id
                              ORDER BY word_similarity(s.subject, l.title) DESC) AS rn,
           lead(word_similarity(s.subject, l.title)) OVER (
               PARTITION BY s.citation_id
               ORDER BY word_similarity(s.subject, l.title) DESC) AS runner_up
    FROM subj s
    JOIN ae_legislation l ON l.law_number = s.law_number AND l.law_year = s.law_year
    WHERE s.subject IS NOT NULL AND l.title IS NOT NULL)
UPDATE ae_case_legislation_citations c
SET law_id = sc.law_id, resolution = 'subject+number+year'
FROM scored sc
WHERE c.citation_id = sc.citation_id AND c.law_id IS NULL
  AND sc.rn = 1 AND sc.sim >= 0.25
  AND (sc.runner_up IS NULL OR sc.sim >= sc.runner_up * 1.4);

\echo '=== resolution after all passes ==='
SELECT coalesce(resolution, 'unresolved') AS rule, count(*) AS citations,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM ae_case_legislation_citations GROUP BY 1 ORDER BY 2 DESC;

\echo '=== coverage ==='
SELECT count(*) AS citations, count(law_id) AS resolved,
       count(DISTINCT doc_id) AS judgments,
       count(DISTINCT doc_id) FILTER (WHERE law_id IS NOT NULL) AS judgments_with_a_resolved_act,
       count(DISTINCT law_id) AS distinct_acts
FROM ae_case_legislation_citations;

\echo '=== the unresolved remainder is dominated by acts we do not hold ==='
SELECT law_number, law_year, count(*) AS citations
FROM ae_case_legislation_citations WHERE law_id IS NULL
GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10;

\echo '=== judgment -> article edges ==='
SELECT count(*) AS article_edges,
       count(article_id) AS matched_an_article_we_hold,
       count(DISTINCT doc_id) AS judgments
FROM ae_case_article_citations;
