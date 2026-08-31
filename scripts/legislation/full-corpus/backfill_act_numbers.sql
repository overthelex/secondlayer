-- backfill_act_numbers.sql
--
-- Populates npa.act_number from npa.act. Deterministic, offline, no network.
-- Requires migration 187_npa_act_number.sql.
--
-- Deliberately NOT a migration: this derives ~700K rows, and doing that inside
-- migrate.ts's single db.query() would hold a needless lock on deploy.
--
-- Run:
--   ssh prod "docker exec -i secondlayer-postgres-prod \
--     psql -U secondlayer -d secondlayer_prod -v ON_ERROR_STOP=1" \
--     < scripts/legislation/full-corpus/backfill_act_numbers.sql
--
-- Idempotent: rebuilds inside one transaction. Safe to re-run.
--
-- It deliberately does NOT use TRUNCATE, which takes ACCESS EXCLUSIVE for the
-- whole transaction and would block every resolver lookup for the entire
-- ~630K-row rebuild once the resolver is live. DELETE takes only ROW
-- EXCLUSIVE, so readers keep serving the previous generation from their own
-- MVCC snapshot and see the new one atomically at COMMIT. The dead rows are
-- reclaimed by the VACUUM at the end.
--
-- Reading npa.act inside that same transaction also gives the build a single
-- consistent snapshot, so an act ingested mid-run cannot land with a partial
-- set of aliases: it is either wholly in this rebuild or wholly in the next.

\set ON_ERROR_STOP on
SET statement_timeout = '1800s';

BEGIN;

DELETE FROM npa.act_number;
DELETE FROM npa.act_number_residual;

-- ---------------------------------------------------------------------------
-- 1. Every act gets its own nreg as an alias, without exception, so the
--    resolver never has to fall back to scanning npa.act.
INSERT INTO npa.act_number (alias_norm, nreg, alias_raw, kind, is_primary, confidence, source)
SELECT npa.norm_number(nreg), nreg, nreg, 'nreg', true, 1.0, 'derived:nreg'
FROM npa.act
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Laws, ВР УРСР era: nreg "{core}-{cc}" with cc 01..12 -> «{core}-{Roman(cc)}».
--    cc 12 stays XII: «2262-XII» is the form in universal use, never «2262-I».
--    (There is no cc = 13: the 1994-1998 convocation numbered its laws
--    "{n}/{YY}-ВР" instead, which is class 4 below.)
INSERT INTO npa.act_number (alias_norm, nreg, alias_raw, kind, is_primary, confidence, source)
SELECT npa.norm_number(core || '-' || npa.roman(cc)), nreg, core || '-' || npa.roman(cc),
       'official', true, 1.0, 'derived:law-cc'
FROM (
  SELECT nreg, split_part(nreg, '-', 1) AS core, substring(nreg from '-(\d\d)$')::int AS cc
  FROM npa.act
  WHERE nreg ~ '^[0-9]+[а-яіїєґ]?-(0[1-9]|1[0-2])$'
    -- КУпАП's two split halves are handled in step 11. The generic rule would
    -- derive «80731-X», a number that does not exist: the trailing 1/2 is
    -- Rada's part index, not part of the act number, which is 8073-X.
    AND nreg NOT IN ('80731-10', '80732-10')
) s
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Laws, independent Ukraine: cc 14..20 -> «{core}-{Roman(cc - 11)}».
INSERT INTO npa.act_number (alias_norm, nreg, alias_raw, kind, is_primary, confidence, source)
SELECT npa.norm_number(core || '-' || npa.roman(cc - 11)), nreg, core || '-' || npa.roman(cc - 11),
       'official', true, 1.0, 'derived:law-cc'
FROM (
  SELECT nreg, split_part(nreg, '-', 1) AS core, substring(nreg from '-(\d\d)$')::int AS cc
  FROM npa.act WHERE nreg ~ '^[0-9]+[а-яіїєґ]?-(1[4-9]|20)$'
) s
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3b. The dual Roman form -- cc 14 ONLY, and only because it is attested.
--
--     One convocation, two names. Rada continued the УРСР count (XIV) for a
--     while and switched to the independent-Ukraine count (III) later, so the
--     SAME convocation produced «996-XIV» (1999) and «2947-III» (2002).
--     Both forms appear in real citations, so both must resolve.
--
--     Measured over the 39 924 Roman-suffixed basis_act values extracted from
--     Rada's own amendment blocks in legislation_article_amendments:
--       IX 20812 · VIII 7103 · VI 5915 · IV 2430 · VII 2237 · V 601 · III 512
--       · XIV 245 · XII 54 · XI 15 · XV 0 · XIII 0
--     XIV is real; XV is never used, so cc 15 gets no alt form. Extending this
--     rule to cc 15 "for symmetry" would have invented 3 306 aliases such as
--     «435-XV» that no source has ever written.
INSERT INTO npa.act_number (alias_norm, nreg, alias_raw, kind, is_primary, confidence, source)
SELECT npa.norm_number(core || '-' || npa.roman(cc)), nreg, core || '-' || npa.roman(cc),
       'official_alt', true, 1.0, 'derived:law-cc-ursr-form'
FROM (
  SELECT nreg, split_part(nreg, '-', 1) AS core, substring(nreg from '-(\d\d)$')::int AS cc
  FROM npa.act WHERE nreg ~ '^[0-9]+[а-яіїєґ]?-14$'
) s
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Декрети КМУ 1992-93 (cc 92/93, types_raw = 8): the official number IS the
--    nreg, verbatim -- «Декрет КМУ № 12-92». Not an outlier class after all.
INSERT INTO npa.act_number (alias_norm, nreg, alias_raw, kind, is_primary, confidence, source)
SELECT npa.norm_number(nreg), nreg, nreg, 'official', true, 1.0, 'derived:decree'
FROM npa.act WHERE nreg ~ '^[0-9]+-(92|93)$'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. The "{n}/{YY}-суфікс" family (laws 1994-1998, укази, розпорядження):
--    the official number is the same string with the suffix upper-cased,
--    «254к/96-вр» -> «254к/96-ВР».
INSERT INTO npa.act_number (alias_norm, nreg, alias_raw, kind, is_primary, confidence, source)
SELECT npa.norm_number(nreg), nreg,
       regexp_replace(nreg, '-([а-яіїєґ]+)$', '-' || upper(substring(nreg from '-([а-яіїєґ]+)$'))),
       'official', true, 1.0, 'derived:slash-suffix'
FROM npa.act WHERE nreg ~ '^[0-9]+[а-яіїєґ]?/[0-9]{2,4}-[а-яіїєґ]+$'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6. Укази without a suffix: «100/2000» is already the official number.
INSERT INTO npa.act_number (alias_norm, nreg, alias_raw, kind, is_primary, confidence, source)
SELECT npa.norm_number(nreg), nreg, nreg, 'official', true, 1.0, 'derived:ukaz'
FROM npa.act WHERE nreg ~ '^[0-9]+[а-яіїєґ]?/[0-9]{2,4}$'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 7. КМУ постанови/розпорядження «{n}-{yyyy}-п»: cited as a bare number plus a
--    date («постанова КМУ від 21.10.2022 № 1199»), so the alias is the number
--    alone -- ambiguous by construction, hence confidence < 1 and kind
--    core_only. The date does the disambiguating at query time.
INSERT INTO npa.act_number (alias_norm, nreg, alias_raw, kind, is_primary, confidence, source)
SELECT npa.norm_number(core), nreg, core, 'core_only', false,
       GREATEST(1.0 / cnt, 0.01), 'derived:kmu'
FROM (
  SELECT nreg, split_part(nreg, '-', 1) AS core,
         count(*) OVER (PARTITION BY split_part(nreg, '-', 1),
                                     substring(nreg from '-([пр])$')) AS cnt
  FROM npa.act WHERE nreg ~ '^[0-9]+[а-яіїєґ]?-[0-9]{2,4}-[прpr]$'
) s
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 8. Classes whose registry id IS their only identifier: Мін'юст registration
--    numbers (z####-##), international instruments (995_###) and the
--    departmental/archival families (n…, v…). These have no separate official
--    number to derive; the row records that as a fact rather than leaving the
--    act looking unclassified.
--    Note the two-digit tail here is a YEAR, not a convocation -- v010_600-05
--    is 2005 -- which is why every convocation rule above is anchored to
--    ^[0-9]+ and never matches these.
INSERT INTO npa.act_number (alias_norm, nreg, alias_raw, kind, is_primary, confidence, source)
SELECT npa.norm_number(nreg), nreg, nreg,
       CASE WHEN nreg ~ '^z' THEN 'reg_mojust'
            WHEN nreg ~ '^[0-9]{3}_'  THEN 'treaty'
            ELSE 'reg_mojust' END,
       true, 1.0, 'derived:selfid'
FROM npa.act
WHERE nreg ~ '^[a-z]' OR nreg ~ '^[0-9]{3}_'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 9. Visual-homoglyph aliases, restricted to the "/YY-вр" family.
--
--    LLMs and users retype «254к/96-вр» as «254k/96-bp» (в reads as B, р as P)
--    -- the two-entry hardcode in legislation-service.ts existed for exactly
--    this. So the map here is VISUAL: р->p, not the transliterated р->r that
--    npa.norm_number applies. An earlier revision used r and produced
--    «254k/96-br», an alias that could never match the «254k/96-bp» it exists
--    to catch -- a dead row that looked like coverage.
--
--    It stays restricted to this family and is never applied to the bare
--    -п / -р suffixes: there, visual р->p would collide with transliterated
--    п->p and merge 154-2022-п with 154-2022-р, which are different acts.
INSERT INTO npa.act_number (alias_norm, nreg, alias_raw, kind, is_primary, confidence, source)
SELECT npa.norm_number(translate(nreg, 'вргкансмтоеіп', 'bpgkahcmtoein')), nreg, nreg,
       'homoglyph', false, 0.95, 'derived:visual'
FROM npa.act WHERE nreg ~ '^[0-9]+[а-яіїєґ]?/[0-9]{2,4}-(вр|рп|рб)$'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 10. Bare number cores for laws: «Закон № 2262» with no convocation.
--     Massively ambiguous on purpose -- of 5 745 law-shaped cores only 855 are
--     unique and 1 016 recur across six convocations -- so confidence is
--     1/n and the caller is expected to disambiguate by date.
INSERT INTO npa.act_number (alias_norm, nreg, alias_raw, kind, is_primary, confidence, source)
SELECT npa.norm_number(core), nreg, core, 'core_only', false,
       GREATEST(1.0 / cnt, 0.01), 'derived:law-core'
FROM (
  SELECT nreg, split_part(nreg, '-', 1) AS core,
         count(*) OVER (PARTITION BY split_part(nreg, '-', 1)) AS cnt
  FROM npa.act
  WHERE nreg ~ '^[0-9]+[а-яіїєґ]?-(0[1-9]|1[0-2]|1[4-9]|20)$'
    -- same exclusion as step 2: «80731»/«80732» are not numbers anyone cites
    AND nreg NOT IN ('80731-10', '80732-10')
) s
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 11. КУпАП: Rada split the code across three registry ids, and the official
--     number of all three is 8073-X -- note 80731-10 is NOT «80731-X», the
--     trailing digit is Rada's part index, not part of the number.
INSERT INTO npa.act_number (alias_norm, nreg, alias_raw, kind, is_primary, confidence, source)
SELECT npa.norm_number('8073-X'), nreg, '8073-X', 'official', true, 1.0, 'manual:kupap-split'
FROM npa.act WHERE nreg IN ('80731-10', '80732-10')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 11b. core_only confidence, computed once over the finished table.
--
--      Doing this inline was wrong: the КМУ step partitioned by (core, -п/-р)
--      while the alias it stores is the core ALONE, so a number issued once as
--      a постанова and once as a розпорядження scored 1.0 twice even though
--      the alias resolves to both. Confidence is a property of the alias, so
--      it is derived from the alias.
UPDATE npa.act_number n
   SET confidence = GREATEST(1.0 / c.cnt, 0.01)
  FROM (SELECT alias_norm, count(*) AS cnt
          FROM npa.act_number WHERE kind = 'core_only' GROUP BY 1) c
 WHERE n.kind = 'core_only' AND n.alias_norm = c.alias_norm;

-- ---------------------------------------------------------------------------
-- 12. Residue: any act that got nothing but its own nreg row and is not one of
--     the classes that legitimately has no official number. Recorded rather
--     than dropped -- a silently empty residue reads as full coverage.
--     A КМУ постанова legitimately has no standalone official number (it is
--     cited as number + date), so it is NOT residue; it is recorded here only
--     if it got neither an identifying row nor a core_only row.
INSERT INTO npa.act_number_residual (nreg, reason)
SELECT a.nreg, 'no numbering class matched'
FROM npa.act a
WHERE NOT EXISTS (
        SELECT 1 FROM npa.act_number n
        WHERE n.nreg = a.nreg
          AND n.kind IN ('official','official_alt','reg_mojust','treaty','core_only'))
ON CONFLICT DO NOTHING;

COMMIT;

VACUUM (ANALYZE) npa.act_number;

-- ===========================================================================
-- GATES. Every one lists rows, never just a count: this project has been
-- burned by audits that passed on aggregates while the data was wrong.
-- ===========================================================================

\echo ''
\echo '=== GATE 1: convocation code vs adoption date, INDEPENDENT (cc >= 12) ==='
\echo '=== boundaries here are documented historical dates, not fitted; expect bad = 0 ==='
WITH t AS (
  SELECT nreg, first_ed,
         substring(nreg from '-(\d\d)$')::int AS cc,
         npa.convocation_of(first_ed) AS derived
  FROM npa.act
  WHERE nreg ~ '^[0-9]+[а-яіїєґ]?-(1[2469]|1[578]|20)$'
    AND first_ed IS NOT NULL
)
SELECT count(*) AS total,
       count(*) FILTER (WHERE cc = derived) AS agree,
       count(*) FILTER (WHERE derived IS NULL OR cc <> derived) AS bad
FROM t;

\echo ''
\echo '=== GATE 1a: the disagreements, by name ==='
SELECT nreg, first_ed, npa.convocation_of(first_ed) AS derived, left(title, 60) AS title
FROM npa.act
WHERE nreg ~ '^[0-9]+[а-яіїєґ]?-(1[2469]|1[578]|20)$'
  AND first_ed IS NOT NULL
  AND npa.convocation_of(first_ed) IS DISTINCT FROM substring(nreg from '-(\d\d)$')::int
ORDER BY first_ed LIMIT 50;

\echo ''
\echo '=== GATE 1b: STRUCTURAL, all eras -- consecutive codes must occupy ==='
\echo '=== disjoint, increasing date ranges. Expect 0 overlapping pairs.    ==='
--
-- This is the non-circular half of gate 1. The УРСР-era boundaries inside
-- convocation_of() were read off this same corpus, so comparing against them
-- would only prove arithmetic. What cannot be manufactured by any choice of
-- boundary is the ordering itself: if the two-digit code were a year, a
-- checksum, or anything other than a convocation index, these ranges would
-- interleave. They must not.
WITH r AS (
  SELECT substring(nreg from '-(\d\d)$')::int AS cc,
         min(first_ed) AS lo, max(first_ed) AS hi
  FROM npa.act
  WHERE nreg ~ '^[0-9]+[а-яіїєґ]?-(0[1-9]|1[0-2]|1[4-9]|20)$' AND first_ed IS NOT NULL
  GROUP BY 1
)
SELECT count(*) AS overlapping_pairs FROM (
  SELECT cc, hi, lead(lo) OVER (ORDER BY cc) AS next_lo FROM r
) x WHERE next_lo IS NOT NULL AND hi >= next_lo;

\echo ''
\echo '=== GATE 1c: the code -> date-range table, for the record ==='
SELECT substring(nreg from '-(\d\d)$')::int AS cc, count(*) AS acts,
       min(first_ed) AS first_act, max(first_ed) AS last_act
FROM npa.act
WHERE nreg ~ '^[0-9]+[а-яіїєґ]?-(0[1-9]|1[0-2]|1[4-9]|20)$' AND first_ed IS NOT NULL
GROUP BY 1 ORDER BY 1;

\echo ''
\echo '=== GATE 1d: law-shaped acts with no adoption date (excluded above) ==='
SELECT count(*) AS law_shaped_without_first_ed
FROM npa.act
WHERE nreg ~ '^[0-9]+[а-яіїєґ]?-(0[1-9]|1[0-2]|1[4-9]|20)$' AND first_ed IS NULL;

\echo ''
\echo '=== GATE 2: derived number vs Rada own string in rada.legislation.title ==='
\echo '=== (independent source; expect >= 4407 of 4421) ==='
WITH src AS (
  SELECT law_number AS nreg, (regexp_match(title, '№ ([0-9]+-[IVXІХ]+)'))[1] AS off_num
  FROM rada.legislation
  WHERE law_number ~ '^[0-9]+-[0-9]{2}$' AND title ~ '№ [0-9]+-[IVXІХ]+'
)
SELECT count(*) AS checked,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM npa.act_number n
         WHERE n.nreg = src.nreg
           AND n.kind IN ('official','official_alt')
           AND n.alias_norm = npa.norm_number(src.off_num))) AS matched
FROM src;

\echo ''
\echo '=== GATE 2b: Rada strings we do NOT reproduce, by name ==='
WITH src AS (
  SELECT law_number AS nreg, (regexp_match(title, '№ ([0-9]+-[IVXІХ]+)'))[1] AS off_num
  FROM rada.legislation
  WHERE law_number ~ '^[0-9]+-[0-9]{2}$' AND title ~ '№ [0-9]+-[IVXІХ]+'
)
SELECT src.nreg, src.off_num,
       (SELECT string_agg(n.alias_raw, ', ') FROM npa.act_number n
        WHERE n.nreg = src.nreg AND n.kind IN ('official','official_alt')) AS ours
FROM src
WHERE NOT EXISTS (
  SELECT 1 FROM npa.act_number n
  WHERE n.nreg = src.nreg AND n.kind IN ('official','official_alt')
    AND n.alias_norm = npa.norm_number(src.off_num))
ORDER BY 1 LIMIT 50;

\echo ''
\echo '=== GATE 3: year embedded in nreg vs adoption year (expect 0 rows) ==='
SELECT nreg, first_ed FROM npa.act
WHERE nreg ~ '^[0-9]+-(19|20)[0-9]{2}-[пр]$'
  AND abs(extract(year FROM first_ed)::int
          - substring(nreg from '-((?:19|20)[0-9]{2})-')::int) > 1
LIMIT 50;

\echo ''
\echo '=== GATE 4: landmarks, by name (read the values, do not trust a count) ==='
SELECT c.nreg, c.official_number, c.official_number_alt, c.act_date, left(c.title, 42) AS title
FROM npa.act_canon c
WHERE c.nreg IN ('1798-12','2262-12','435-15','2768-14','996-14','2947-14','2755-17',
                 '4651-17','5073-17','4173-20','322-08','8073-10','80731-10',
                 '254к/96-вр','12-92','2389-19','995_004','1402-19')
ORDER BY c.nreg;

\echo ''
\echo '=== GATE 5: ambiguous official numbers, classified ==='
\echo '=== expect: kupap_split=3 acts, cross_era=~69 pairs, UNEXPLAINED=0 ==='
--
-- Two ambiguity sources are inherent to Ukrainian act numbering, not defects:
--   * КУпАП: Rada split one code over three registry ids sharing «8073-X».
--   * cross-era Roman collision: the ВР УРСР convocations V..XI and the
--     independent-Ukraine convocations V..IX render to the same Roman string
--     (cc 05 and cc 16 are both «V»), so «117-VIII» is genuinely two acts,
--     one from 1971-75 and one from 2014-19. The resolver must return both
--     and let the citation's date decide; collapsing them would be wrong.
-- Anything outside those two classes is a real defect and must be zero.
WITH amb AS (
  SELECT alias_norm, count(*) AS n, string_agg(nreg, ', ' ORDER BY nreg) AS acts,
         array_agg(substring(nreg from '-(\d\d)$')::int ORDER BY nreg) AS ccs
  FROM npa.act_number
  WHERE kind IN ('official', 'official_alt')
  GROUP BY 1 HAVING count(*) > 1
), cls AS (
  SELECT *, CASE
      WHEN alias_norm = '8073-x' THEN 'kupap_split'
      WHEN n = 2 AND ccs[2] - ccs[1] = 11 AND ccs[1] BETWEEN 3 AND 9 THEN 'cross_era'
      ELSE 'UNEXPLAINED'
    END AS klass
  FROM amb
)
SELECT klass, count(*) AS alias_count FROM cls GROUP BY 1 ORDER BY 1;

\echo ''
\echo '=== GATE 5b: the UNEXPLAINED ones, by name (expect 0 rows) ==='
WITH amb AS (
  SELECT alias_norm, count(*) AS n, string_agg(nreg, ', ' ORDER BY nreg) AS acts,
         array_agg(substring(nreg from '-(\d\d)$')::int ORDER BY nreg) AS ccs
  FROM npa.act_number
  WHERE kind IN ('official', 'official_alt')
  GROUP BY 1 HAVING count(*) > 1
)
SELECT alias_norm, n, acts FROM amb
WHERE alias_norm <> '8073-x'
  AND NOT (n = 2 AND ccs[2] - ccs[1] = 11 AND ccs[1] BETWEEN 3 AND 9)
ORDER BY 1 LIMIT 40;

\echo ''
\echo '=== GATE 6: round trip -- every act reachable by its own nreg (expect 0) ==='
SELECT a.nreg FROM npa.act a
LEFT JOIN npa.act_number n ON n.nreg = a.nreg AND n.alias_norm = npa.norm_number(a.nreg)
WHERE n.nreg IS NULL LIMIT 20;

\echo ''
\echo '=== COVERAGE: rows by kind, and the residue ==='
SELECT kind, count(*) FROM npa.act_number GROUP BY 1 ORDER BY 2 DESC;
SELECT count(*) AS acts_without_official_number FROM npa.act_number_residual;
SELECT left(nreg, 1) AS residual_prefix, count(*) FROM npa.act_number_residual GROUP BY 1 ORDER BY 2 DESC LIMIT 12;
