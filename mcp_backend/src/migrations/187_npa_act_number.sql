-- 187_npa_act_number.sql
--
-- Canonical act-number layer for the НПА corpus (LEXAI, 2026-08-13).
--
-- Problem: npa.act is keyed only by the Rada registry id (nreg, e.g. "2755-17",
-- "254к/96-вр").  The OFFICIAL number a court, a lawyer or a citation actually
-- uses -- «Закон України № 2755-VI» -- is stored nowhere and resolves nowhere.
--
-- This migration ships DDL and functions only.  The ~700K derived rows are
-- loaded by scripts/legislation/full-corpus/backfill_act_numbers.sql, run
-- explicitly with a statement_timeout, so migrate.ts never holds a long lock.

-- ---------------------------------------------------------------------------
-- npa.norm_number(text) -- the lookup key.
--
-- A pure STRING normalizer, deliberately NOT a semantic one: it does not map
-- Roman numerals to convocation codes.  That mapping is ambiguous (Roman III
-- is convocation 03 for the УРСР era and 14 for independent Ukraine) so it
-- lives in npa.act_number as DATA, where one number can legitimately produce
-- several rows.  Keeping this function purely lexical is also what lets it be
-- IMMUTABLE, which the expression index at the bottom of this file requires.
--
-- Steps:
--   1. strip № BEFORE normalize() -- NFKC rewrites «№» to the two letters "No",
--      which would otherwise end up inside the key.
--   2. NFKC, then drop all whitespace (incl. NBSP, which NFKC maps to a space).
--   3. lower() -- verified to fold Cyrillic on this cluster's collation.
--   4. Fold Cyrillic to Latin by TRANSLITERATION, not by visual lookalike.
--      Visual folding would send both п (постанова) and р (розпорядження) to
--      "p" and collide 154-2022-п with 154-2022-р, which are different acts.
--      Transliteration keeps them apart (p / r) and still folds the Roman
--      lookalikes correctly, because х→x, і→i and в→v agree with both readings:
--      «2262-ХІІ» (Cyrillic) and «2262-XII» (Latin) both yield 2262-xii.
--      The visual variants LLMs emit (254k/96-bp for 254к/96-вр) are handled
--      as explicit kind='homoglyph' alias rows instead.
--   5. Strip leading zeros ONLY from an all-digit token, so «007» finds «7» in
--      opendata_edrnpa_cards.  Applying it more widely would collide
--      n0001001-01 with n1001-01 across 47 997 ministry acts.
CREATE OR REPLACE FUNCTION npa.norm_number(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
AS $fn$
  SELECT CASE
           WHEN v ~ '^[0-9]+$' THEN COALESCE(NULLIF(ltrim(v, '0'), ''), '0')
           ELSE v
         END
  FROM (
    -- The multi-character replacements come FIRST and exist to keep the fold
    -- INJECTIVE, which is the whole point: a fold that merges two letters
    -- merges the acts those letters distinguish. A plain 1:1 translate sends
    -- є/е to "e" and й/і/ї to "i", which really did merge 2993е-12 with
    -- 2993є-12 and 2993й-12 with 2993і-12 and 2993ї-12 -- five distinct acts
    -- whose letter index is the only thing telling them apart.
    --
    -- The fold covers exactly the 23 Cyrillic letters that actually occur in
    -- an nreg -- а б в г д е ж з и і ї й к л м н о п р с т у є, plus х and ф
    -- for the Roman numerals -- and every OTHER letter passes through
    -- untouched. Passing through is what keeps the fold safe: an unmapped
    -- letter cannot collide with anything, whereas inventing a token for it
    -- can. An earlier revision mapped ь to "q" and ц to "ts", which collided
    -- with the Latin q that really does occur in 12 nregs (997_q01 …) and
    -- with the sequence т+с respectively.
    --
    -- This is a deliberately many-to-one map -- making «2262-XII» and
    -- «2262-ХІІ» meet is the entire point -- so the guarantee to hold is not
    -- abstract injectivity but that no two DISTINCT STORED aliases collide.
    -- Gate 5 in backfill_act_numbers.sql measures exactly that.
    --
    -- "h" is never emitted by the 1:1 table, so zh/yi/ye cannot be forged by
    -- any pair of mapped letters.
    SELECT translate(
             replace(replace(replace(
               lower(
                 regexp_replace(
                   normalize(regexp_replace(raw, '№', '', 'g'), NFKC),
                   '[[:space:]]', '', 'g'
                 )
               ),
             'ж', 'zh'), 'ї', 'yi'), 'є', 'ye'),
             'абвгдезиійклмнопрстуфх',
             'abvgdezyijklmnoprstufx'
           ) AS v
  ) s;
$fn$;

COMMENT ON FUNCTION npa.norm_number(text) IS
  'Lexical normalizer for act numbers: strip №/whitespace, NFKC, casefold, '
  'transliterate Cyrillic to Latin, strip leading zeros on all-digit tokens. '
  'Roman<->convocation mapping is data in npa.act_number, not logic here.';

-- ---------------------------------------------------------------------------
-- npa.roman(int) -- 1..30 is far more than the 12 convocations ever need.
CREATE OR REPLACE FUNCTION npa.roman(n int)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
AS $fn$
  SELECT CASE WHEN n BETWEEN 1 AND 30 THEN
    (ARRAY['I','II','III','IV','V','VI','VII','VIII','IX','X',
           'XI','XII','XIII','XIV','XV','XVI','XVII','XVIII','XIX','XX',
           'XXI','XXII','XXIII','XXIV','XXV','XXVI','XXVII','XXVIII','XXIX','XXX'])[n]
  END;
$fn$;

-- ---------------------------------------------------------------------------
-- npa.convocation_of(date) -- the convocation of the Verkhovna Rada in force
-- on a given date, expressed in the code Rada uses in nreg.
--
-- This exists to VALIDATE the backfill, not to feed it: it derives the
-- convocation from npa.act.first_ed, a column the number derivation never
-- touches, so a disagreement is real evidence rather than a tautology.
--
-- Note the 1994-05-11..1998-05-11 hole.  That convocation numbered its laws
-- «N/YY-ВР» rather than «N-cc», which is why no act in the corpus carries
-- cc = 13 -- the gap in the distribution is a fact about Rada, not a defect.
CREATE OR REPLACE FUNCTION npa.convocation_of(d date)
RETURNS smallint
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
AS $fn$
  SELECT CASE
    WHEN d >= DATE '2019-08-29' THEN 20   -- IX
    WHEN d >= DATE '2014-11-27' THEN 19   -- VIII
    WHEN d >= DATE '2012-12-12' THEN 18   -- VII
    WHEN d >= DATE '2007-11-23' THEN 17   -- VI
    WHEN d >= DATE '2006-05-25' THEN 16   -- V
    WHEN d >= DATE '2002-05-14' THEN 15   -- IV
    WHEN d >= DATE '1998-05-12' THEN 14   -- III (a.k.a. XIV)
    WHEN d >= DATE '1994-05-11' THEN NULL -- the N/YY-ВР era; no -cc form exists
    WHEN d >= DATE '1990-05-15' THEN 12   -- XII (a.k.a. I)
    -- ВР УРСР: the code IS the convocation, I..XI.
    --
    -- HONESTY NOTE: unlike the boundaries above, which are documented
    -- historical dates, these are the earliest act observed for each code in
    -- the corpus itself. They are therefore a CONSISTENCY aid, not independent
    -- evidence, and gate 1 in backfill_act_numbers.sql deliberately restricts
    -- its independent comparison to cc >= 12. The non-circular check for the
    -- УРСР era is gate 1b, which asserts only that consecutive codes occupy
    -- disjoint, increasing date ranges -- a property no choice of boundary
    -- can manufacture.
    WHEN d >= DATE '1985-03-27' THEN 11
    WHEN d >= DATE '1980-03-26' THEN 10
    WHEN d >= DATE '1975-07-18' THEN 9
    WHEN d >= DATE '1971-08-30' THEN 8
    WHEN d >= DATE '1967-08-26' THEN 7
    WHEN d >= DATE '1962-09-10' THEN 6
    WHEN d >= DATE '1960-12-28' THEN 5
    WHEN d >= DATE '1958-09-24' THEN 4
    WHEN d >= DATE '1954-07-03' THEN 3
    WHEN d >= DATE '1947-06-28' THEN 2
    WHEN d >= DATE '1939-07-28' THEN 1
    ELSE NULL
  END::smallint;
$fn$;

-- ---------------------------------------------------------------------------
-- npa.act_number -- the resolver's lookup table.
--
-- An alias table rather than columns on npa.act, because the mapping is not
-- functional in either direction:
--   * one number -> many acts: «8073-X» is КУпАП, which Rada split across
--     8073-10, 80731-10 and 80732-10;
--   * one act -> many numbers: 996-14 is cited both as «996-XIV» (the УРСР
--     numbering continued) and «996-III» (independent Ukraine's), and both
--     forms appear in real court decisions.
-- A column cannot hold either shape, and the resolver has to be able to return
-- a ranked candidate set instead of silently picking one.
CREATE TABLE IF NOT EXISTS npa.act_number (
  alias_norm  text    NOT NULL,                 -- npa.norm_number() output; the key
  nreg        text    NOT NULL REFERENCES npa.act(nreg) ON DELETE CASCADE,
  alias_raw   text    NOT NULL,                 -- display form / as found in the wild
  kind        text    NOT NULL,
  is_primary  boolean NOT NULL DEFAULT false,   -- the form to DISPLAY for this nreg+kind
  confidence  real    NOT NULL DEFAULT 1.0,
  source      text    NOT NULL,
  -- kind is part of the key on purpose. For most classes the official number
  -- normalizes to the SAME string as the nreg (Декрет «12-92», «254к/96-ВР»
  -- vs «254к/96-вр», z0001-00), so a PK of (alias_norm, nreg) silently kept
  -- only the kind='nreg' row and threw the official form and its display
  -- spelling away -- measured: it lost every class except the two law classes.
  PRIMARY KEY (alias_norm, nreg, kind),
  CONSTRAINT act_number_kind_chk CHECK (kind IN (
    'nreg',            -- the registry id itself; every act gets one
    'official',        -- «2755-VI», «254к/96-ВР», «12-92»
    'official_alt',    -- the second legitimate Roman form: «996-XIV» beside «996-III»
    'official_legacy', -- wrong-case / lowercase-Roman forms found in legacy tables
    'abbrev',          -- ЦК, ГПК, КУпАП ...
    'homoglyph',       -- visual Latin lookalikes: 254k/96-bp
    'reg_mojust',      -- z####-## registration numbers
    'treaty',          -- 995_### and friends
    'core_only'        -- bare «2262»; ambiguous by construction, confidence < 1
  )),
  CONSTRAINT act_number_confidence_chk CHECK (confidence > 0 AND confidence <= 1)
);

CREATE INDEX IF NOT EXISTS idx_act_number_nreg ON npa.act_number (nreg);

-- At most one display form per (act, kind).
CREATE UNIQUE INDEX IF NOT EXISTS uq_act_number_primary
  ON npa.act_number (nreg, kind) WHERE is_primary;

COMMENT ON TABLE npa.act_number IS
  'Alias -> nreg lookup for act numbers. Query with '
  'WHERE alias_norm = npa.norm_number($1) and rank by confidence, is_primary.';

-- Acts whose nreg matched no derivation class. Kept as evidence: a silently
-- empty residue reads as "everything was covered" when it was not.
CREATE TABLE IF NOT EXISTS npa.act_number_residual (
  nreg       text PRIMARY KEY REFERENCES npa.act(nreg) ON DELETE CASCADE,
  reason     text NOT NULL,
  noted_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- npa.act_canon -- read view so callers need not know about the join.
--
-- act_date is npa.act.first_ed, which was verified against known adoption
-- dates (1798-12 -> 1991-11-06, 254к/96-вр -> 1996-06-28, 2755-17 ->
-- 2010-12-02, 322-08 -> 1971-12-10, ...), so no separate column is needed.
-- Three acts carry a 1990-01-01 placeholder instead of a real date (995_004,
-- the ECHR, was signed in 1950) and are excluded by value rather than by
-- class -- the treaty class at large has correct dates, e.g. 995_043 -> 1966.
--
-- doc_kind is deliberately absent: types_raw is decoded by NPA_DOC_TYPE in
-- npa-dicts.ts, and duplicating that dictionary here would create the second
-- source of truth this whole migration exists to remove.
CREATE OR REPLACE VIEW npa.act_canon AS
SELECT
  a.nreg,
  off.alias_raw                                   AS official_number,
  alt.alias_raw                                   AS official_number_alt,
  split_part(a.nreg, '-', 1)                      AS number_core,
  NULLIF(substring(a.nreg from '-(\d\d)$'), '')::smallint AS convocation,
  CASE WHEN a.first_ed = DATE '1990-01-01' THEN NULL ELSE a.first_ed END AS act_date,
  a.types_raw,
  a.status_code,
  a.title,
  a.has_articles,
  a.editions_cnt,
  a.last_ed
FROM npa.act a
LEFT JOIN npa.act_number off
       ON off.nreg = a.nreg AND off.kind = 'official'     AND off.is_primary
LEFT JOIN npa.act_number alt
       ON alt.nreg = a.nreg AND alt.kind = 'official_alt' AND alt.is_primary;

-- ---------------------------------------------------------------------------
-- NOT here: the expression index on public.opendata_edrnpa_cards
-- (npa.norm_number(number)). search_edrnpa still compares c.number by raw
-- equality (opendata-tools.ts), so the index would carry maintenance cost
-- while accelerating nothing. It ships in the same PR that normalizes both
-- sides of that comparison, together with the rest of the resolver wiring.
--
-- npa.norm_number is declared IMMUTABLE precisely so that index is possible
-- when the query is ready for it.
