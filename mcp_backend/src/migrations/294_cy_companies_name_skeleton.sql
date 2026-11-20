-- Migration 294 (LEXAI-2310): transliteration lookup in the Cyprus DRCOR register.
--
-- ЄДР writes most Cypriot founders in Ukrainian transliteration («ЕЙНТРІВУД ІНВЕСТМЕНТС
-- ЛІМІТЕД»), DRCOR in Latin («AINTREEWOOD INVESTMENTS LIMITED»). Both are reduced to a
-- consonant skeleton (legal-form words dropped, vowels / h / spaces / doubled letters removed,
-- c/k/q, s/z, ph/f, x/ks, w/v, j/g folded); the index finds the names sharing a founder's
-- skeleton, and search_cyprus_companies ranks them by spelling similarity.
--
-- cy_name_skeleton() must stay identical to cyNameSkeleton() in
-- mcp_backend/src/api/tools/cyprus-names.ts for Latin input. Checked on all 502,583 C/O names
-- of the 02.11.2026 snapshot: 0 differences.
--
-- Not CONCURRENTLY: a function and an index in one file run in one implicit transaction.
-- The build reads 576K rows (about 9 s of regexp work on local.lex) and holds a SHARE lock,
-- which blocks only writes: the monthly DRCOR loader, not readers.
CREATE OR REPLACE FUNCTION cy_name_skeleton(name text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
  SELECT regexp_replace(
    regexp_replace(
      regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
        regexp_replace(
          regexp_replace(replace(lower(name), '&', ' and '), '[^a-z0-9]+', ' ', 'g'),
          '\m(limited|ltd|limitid|plc|pls|public|pablik|pablyk|company|co|kompani|kompaniya|inc|ink|llc)\M', ' ', 'g'),
        'ph', 'f', 'g'), 'th', 't', 'g'), 'ck', 'k', 'g'), 'x', 'ks', 'g'), 'c(?=[eiy])', 's', 'g'), '[cq]', 'k', 'g'),
        'z', 's', 'g'), 'w', 'v', 'g'), 'j', 'g', 'g'),
      '[aeiouyh ]', '', 'g'),
    '(.)\1+', '\1', 'g')
$fn$;

CREATE INDEX IF NOT EXISTS idx_cy_companies_name_skeleton ON cy_companies (cy_name_skeleton(name));
