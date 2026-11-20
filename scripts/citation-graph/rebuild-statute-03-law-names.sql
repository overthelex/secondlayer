-- rebuild-statute-03-law-names.sql  (LEXAI-2323)
--
-- One-off fix of the 20.11.2026 full-text pass, before the extractor learned to
-- (a) look codex abbreviations up case-insensitively: 'КЗПП' / 'КУПАП' -> full names, and
-- (b) fold Cyrillic Roman numerals in act numbers: '2262-ХІІ' -> '2262-XII'
-- (normalize_law_ref / CODEX_BY_UPPER in extract-citations.py; the incremental job and
-- any later rebuild write the canonical spelling directly). Batched by doc_id range,
-- one transaction per batch, so it can be interrupted and rerun. Then rerun
-- rebuild-statute-02-finalize.sql for VACUUM and statute_article_stats.

\set ON_ERROR_STOP on
\timing on
SET statement_timeout = '30min';
SET lock_timeout = '10s';

SELECT format($q$UPDATE decision_statute_citations SET law_number = CASE law_number
                  WHEN 'КЗПП'  THEN 'Кодекс законів про працю України'
                  WHEN 'КУПАП' THEN 'Кодекс України про адміністративні правопорушення'
                  ELSE upper(translate(regexp_replace(law_number, '\s*-\s*', '-'), 'ХІВМСхівмс', 'XIVMCXIVMC')) END
                 WHERE doc_id >= %s AND doc_id < %s
                   AND (law_number IN ('КЗПП', 'КУПАП')
                        OR (law_number ~* '^\d+\s*-\s*[IVXLCХІВМ]+$'
                            AND law_number <> upper(translate(regexp_replace(law_number, '\s*-\s*', '-'), 'ХІВМСхівмс', 'XIVMCXIVMC'))))$q$,
              lo, lo + 5000000)
  FROM generate_series(0, (SELECT max(doc_id) FROM decision_statute_citations), 5000000) lo
\gexec
