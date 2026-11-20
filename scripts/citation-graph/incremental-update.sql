-- incremental-update.sql  (LEXAI-2323) — executed by incremental-update.py, in ONE
-- transaction on the connection that filled the session temp tables
--   inc_docs(doc_id)                              every decision read in this run
--   inc_case(from_case_id, to_case_number, citation_context, justice_kind, adj_year)
--   inc_statute(doc_id, citation_type, law_number, law_article, adj_year)
-- and sets the watermark to :new_watermark. Commit with the watermark or not at all, so
-- a rerun after a failure repeats exactly the same decisions and never counts one twice.
--
-- What it keeps current, for decisions newer than the watermark:
--   edrsr_case_index            the cases of the new decisions (member_count, dates, latest)
--   case_citation_edges/links   the same rows and resolver rules as rebuild-case-graph-01
--   case_citation_counts        incremented by the new resolved, non-self links
--   decision_statute_citations  + statute_article_stats incremented
-- What it does not: a link written earlier as case_not_in_corpus does not resolve when its
-- case appears later, and member_count/latest_doc_id on older links are not refreshed.
-- The periodic full rebuild (RUNBOOK-decision-citation-layer.md) settles both.

-- Resolver key, identical to rebuild-case-graph-01-finalize.sql.
CREATE OR REPLACE FUNCTION pg_temp.cg_norm(c text) RETURNS text
LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE
    WHEN btrim(c) ~ '^\d{1,4}/\d{1,10}/\d{2,4}$' THEN btrim(c)
    WHEN btrim(c) ~ '^\d{1,4}/\d{1,10}/\d{2,4}\s*[-‐‑‒–—―−]\s*[A-Za-zА-Яа-яІіЇїЄєҐґ]{1,3}$'
     AND translate(lower(regexp_replace(btrim(c), '^.*[-‐‑‒–—―−]\s*', '')), 'aekcopxhwrgf', 'аексорхнцкпа')
         IN ('ц','к','п','а','г','е','ап','нр','б','н','на','зн','кр')
    THEN substring(btrim(c) from '^(\d{1,4}/\d{1,10}/\d{2,4})') || '-' ||
         translate(lower(regexp_replace(btrim(c), '^.*[-‐‑‒–—―−]\s*', '')), 'aekcopxhwrgf', 'аексорхнцкпа')
  END
$f$;

-- 1. Case dimension for the new decisions' cases -----------------------------
CREATE TEMP TABLE inc_doc ON COMMIT DROP AS
SELECT DISTINCT ON (d.doc_id) d.doc_id, d.justice_kind, d.cause_num, pg_temp.cg_norm(d.cause_num) AS own_norm
  FROM edrsr_documents d JOIN inc_docs n ON n.doc_id = d.doc_id
 ORDER BY d.doc_id, d.adjudication_date DESC NULLS LAST;

INSERT INTO edrsr_case_index (cause_num, member_count, first_date, last_date, latest_doc_id)
SELECT d.cause_num, count(*)::int, min(d.adjudication_date), max(d.adjudication_date),
       (array_agg(d.doc_id ORDER BY d.adjudication_date DESC NULLS LAST))[1]
  FROM edrsr_documents d
 WHERE d.cause_num IN (SELECT DISTINCT cause_num FROM inc_doc WHERE cause_num <> '')
 GROUP BY d.cause_num
ON CONFLICT (cause_num) DO UPDATE
   SET member_count = EXCLUDED.member_count, first_date = EXCLUDED.first_date,
       last_date = EXCLUDED.last_date, latest_doc_id = EXCLUDED.latest_doc_id;

-- 2. Edges ------------------------------------------------------------------
CREATE TEMP TABLE inc_edge ON COMMIT DROP AS
WITH ins AS (
  INSERT INTO case_citation_edges (from_case_id, to_case_number, citation_context, justice_kind, adj_year)
  SELECT DISTINCT ON (c.from_case_id, c.to_case_number)
         c.from_case_id, c.to_case_number, c.citation_context, COALESCE(c.justice_kind, d.justice_kind), c.adj_year
    FROM inc_case c LEFT JOIN inc_doc d ON d.doc_id = c.from_case_id
   ORDER BY c.from_case_id, c.to_case_number
  ON CONFLICT (from_case_id, to_case_number) DO NOTHING
  RETURNING id, from_case_id, to_case_number, citation_context, adj_year)
SELECT * FROM ins;

-- 3. Links: resolver lookups restricted to the bases the new edges cite --------
CREATE TEMP TABLE inc_bases ON COMMIT DROP AS
SELECT DISTINCT split_part(to_case_number, '-', 1) AS base FROM inc_edge;

-- cause_nums on those bases. edrsr_case_index is keyed on the spelling, so each base is
-- found through the spellings that can produce it: the bare base and base + separator.
CREATE TEMP TABLE inc_norm ON COMMIT DROP AS
SELECT DISTINCT ON (norm) norm, split_part(norm, '-', 1) AS base, cause_num, member_count, latest_doc_id
  FROM (SELECT pg_temp.cg_norm(i.cause_num) AS norm, i.cause_num, i.member_count, i.latest_doc_id
          FROM inc_bases b
          JOIN edrsr_case_index i ON i.cause_num >= b.base AND i.cause_num < b.base || '~'
        ) s
 WHERE norm IS NOT NULL AND split_part(norm, '-', 1) IN (SELECT base FROM inc_bases)
 ORDER BY norm, member_count DESC NULLS LAST, cause_num;
CREATE TEMP TABLE inc_base ON COMMIT DROP AS
SELECT base, count(*)::int AS n_cases, min(norm) AS only_norm, bool_or(norm = base) AS has_bare
  FROM inc_norm GROUP BY base;

CREATE TEMP TABLE inc_link ON COMMIT DROP AS
SELECT e.from_case_id AS from_doc_id,
       COALESCE(r.cause_num, e.to_case_number) AS to_case_number,
       r.cause_num IS NOT NULL AS resolved,
       COALESCE(r.member_count, 0) AS member_count,
       r.latest_doc_id,
       COALESCE(fd.own_norm = r.norm, false)
         OR COALESCE(fd.own_norm = e.to_case_number, false)
         OR COALESCE(e.to_case_number !~ '-' AND split_part(fd.own_norm, '-', 1) = e.to_case_number, false)
         AS is_self_citation,
       CASE WHEN x.norm IS NOT NULL AND x.cause_num = e.to_case_number THEN 'exact'
            WHEN x.norm IS NOT NULL THEN 'normalized'
            WHEN y.norm IS NOT NULL AND e.to_case_number ~ '-' THEN 'suffix_dropped'
            WHEN y.norm IS NOT NULL THEN 'suffix_completed' END AS match_method,
       CASE WHEN r.cause_num IS NULL THEN
            CASE WHEN e.to_case_number !~ '-' AND b.n_cases > 1 THEN 'ambiguous_suffix'
                 ELSE 'case_not_in_corpus' END
       END AS unresolved_reason,
       e.citation_context, e.adj_year, e.id AS src_edge_id
  FROM inc_edge e
  LEFT JOIN inc_norm x ON x.norm = e.to_case_number
  LEFT JOIN inc_base b ON b.base = split_part(e.to_case_number, '-', 1)
  LEFT JOIN inc_norm y ON x.norm IS NULL AND b.n_cases = 1
        AND y.norm = CASE WHEN e.to_case_number !~ '-' THEN b.only_norm
                          WHEN b.has_bare THEN b.base END
  CROSS JOIN LATERAL (SELECT COALESCE(x.norm, y.norm) AS norm,
                             COALESCE(x.cause_num, y.cause_num) AS cause_num,
                             COALESCE(x.member_count, y.member_count) AS member_count,
                             COALESCE(x.latest_doc_id, y.latest_doc_id) AS latest_doc_id) r
  LEFT JOIN inc_doc fd ON fd.doc_id = e.from_case_id;

INSERT INTO case_citation_links
  (from_doc_id, to_case_number, resolved, member_count, latest_doc_id, is_self_citation,
   match_method, unresolved_reason, citation_context, adj_year, src_edge_id)
SELECT from_doc_id, to_case_number, resolved, member_count, latest_doc_id, is_self_citation,
       match_method, unresolved_reason, citation_context, adj_year, src_edge_id
  FROM inc_link;

INSERT INTO case_citation_counts (cause_num, citing_decisions)
SELECT to_case_number, count(DISTINCT from_doc_id)::int
  FROM inc_link WHERE resolved AND NOT is_self_citation GROUP BY to_case_number
ON CONFLICT (cause_num) DO UPDATE
   SET citing_decisions = case_citation_counts.citing_decisions + EXCLUDED.citing_decisions;

-- 4. Statute layer ----------------------------------------------------------
-- A decision already in the layer (read by the full rebuild's open-ended last chunk) is
-- skipped whole, so neither its rows nor the stats are counted twice.
CREATE TEMP TABLE inc_stat ON COMMIT DROP AS
SELECT DISTINCT s.doc_id, s.citation_type, s.law_number, s.law_article, s.adj_year
  FROM inc_statute s
 WHERE NOT EXISTS (SELECT 1 FROM decision_statute_citations c WHERE c.doc_id = s.doc_id);
INSERT INTO decision_statute_citations (doc_id, citation_type, law_number, law_article, adj_year)
SELECT doc_id, citation_type, law_number, law_article, adj_year FROM inc_stat;

INSERT INTO statute_article_stats (law_number, law_article, total_citations, unique_decisions)
SELECT law_number, law_article, count(*), count(DISTINCT doc_id)
  FROM inc_stat WHERE law_article <> '' GROUP BY law_number, law_article
ON CONFLICT (law_number, law_article) DO UPDATE
   SET total_citations  = statute_article_stats.total_citations  + EXCLUDED.total_citations,
       unique_decisions = statute_article_stats.unique_decisions + EXCLUDED.unique_decisions;

-- 5. Watermark --------------------------------------------------------------
INSERT INTO citation_graph_watermark (layer, max_doc_id, updated_at)
VALUES ('decisions', %(new_watermark)s, now())
ON CONFLICT (layer) DO UPDATE SET max_doc_id = EXCLUDED.max_doc_id, updated_at = now();
