-- ⚠ THIS SCRIPT REBUILDS THE 87 GB CITATION GRAPH. Read the safety notes.
--
-- It used to DROP the live table and then run a ~57-minute INSERT with
-- statement_timeout='1800s' and NO ON_ERROR_STOP. Measured: the unpatched
-- SELECT alone scales to ~3 400 s, i.e. it was ALREADY past the timeout. When
-- the INSERT died, psql did not stop — it went on to CREATE INDEX four times
-- on an empty table and print a COVERAGE report of zero. A routine rerun could
-- therefore destroy 331 M rows and report success.
--
-- Now: fail fast, build beside the live table, and swap only once the new one
-- is complete. A failure at any point leaves the serving table untouched.
\set ON_ERROR_STOP on
-- 8h, not 4h. Measured on prod by EXPLAIN (ANALYZE) over a contiguous 10M-row
-- slice and scaled by 33.36x: the SELECT alone is ~57 minutes, and the run then
-- has to write 87 GB of heap and build four indexes on top — call it 2.5 to 4
-- hours end to end. A 4h ceiling was close enough to that to lose an entire
-- run to the clock. Hitting the timeout is no longer destructive (the build
-- happens beside the live table and the swap is the last thing that runs), but
-- it still throws away hours of work.
SET statement_timeout='8h';

-- Only one rebuild at a time. This script drops and replaces the serving
-- table, so two overlapping runs would each validate their own staging table
-- and then race to drop whatever is live at that moment. A SESSION-level
-- advisory lock spans the whole script and is released when psql disconnects,
-- including on a crash. try_ rather than plain lock: waiting hours behind
-- another rebuild is not useful, and failing loudly says what happened.
DO $lock$
BEGIN
  IF NOT pg_try_advisory_lock(hashtext('build-legislation-citation-links')) THEN
    RAISE EXCEPTION
      'another rebuild already holds the advisory lock; refusing to run concurrently';
  END IF;
END
$lock$;

-- Best-effort only, and deliberately so. A session advisory lock does not
-- survive a transaction-pooled connection, so it cannot be what makes the
-- swap safe — that job belongs to the ACCESS EXCLUSIVE lock inside the swap
-- transaction at the end of this file. All this buys is stopping a second run
-- from burning 90 minutes before discovering it was redundant.
-- Run DIRECTLY against Postgres (port 5432), never through pgbouncer.

-- to_date does not merely reject impossible field values, it VALIDATES the day
-- against the month, so it THROWS on «19.19.2010» AND on «29.02.1991». Both are
-- in the corpus, and each one aborted a 14-minute pass while the repair was
-- being written. No regex covers the calendar; only an exception handler does.
-- Defined here so the builder does not depend on repair-lcl-by-number.sql
-- having been run against this database first.
CREATE OR REPLACE FUNCTION public.try_to_date(t text, fmt text)
RETURNS date LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
  RETURN to_date(t, fmt);
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$fn$;

-- The staging table is named per run. A fixed name is a SHARED resource: two
-- overlapping runs would each DROP and re-CREATE the same table and write into
-- each other's rows long before either reached the swap. The advisory lock
-- cannot be relied on to prevent that (it is session-scoped, see above), so
-- the shared resource is removed instead of defended.
SELECT 'lcl_stg_' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '_' || pg_backend_pid() AS stg \gset
-- Also stash it server-side. psql does NOT interpolate :'stg' inside a
-- dollar-quoted body, so the DO block that guards the swap cannot read the
-- client variable — it reaches the server as a literal colon and raises
-- "syntax error at or near :". That happened on the first real run: the build
-- completed, all four indexes were created, and only then did the swap die,
-- leaving 331 385 209 finished rows stranded in staging.
SELECT set_config('lcl.stg', :'stg', false);

-- One definition of the article key. It was written out twice — once in
-- best_art, once in the withart join — and the two have to agree exactly or
-- the join silently stops matching. That is the same drift this whole effort
-- has been removing elsewhere, so it gets a single home. An IMMUTABLE SQL
-- function with a one-expression body is inlined by the planner, so this costs
-- nothing at runtime.
CREATE OR REPLACE FUNCTION public.lcl_art_key(t text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS
$fn$ SELECT regexp_replace(btrim(t), '^п\.', '') $fn$;

-- Title fold for the fallback title leg. Court texts spell the apostrophe several
-- ways — «загальнообов`язкове» with a backtick, «обов'язкове» straight, plus the
-- two curly forms — and the exact-title join treats each spelling as a different
-- act. Measured on prod: 2 208 distinct law_number values covering 755 300 rows
-- name an act we DO curate and miss it on nothing but punctuation. «Про
-- соціальний захист дітей війни» alone appears under three spellings.
CREATE OR REPLACE FUNCTION public.lcl_title_key(t text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS
$fn$ SELECT lower(btrim(regexp_replace(translate(t, '`´''’‘', '     '), '\s+', ' ', 'g'))) $fn$;

DROP TABLE IF EXISTS public.:"stg";
CREATE TABLE public.:"stg" (
  id bigserial PRIMARY KEY, doc_id bigint NOT NULL, legislation_id integer, article_id integer,
  article_number varchar, law_number_raw text NOT NULL, law_article_raw text, citation_type text,
  citation_context text, match_method text NOT NULL, resolved boolean NOT NULL DEFAULT false,
  unresolved_reason text, src_citation_id bigint, created_at timestamptz DEFAULT now());
INSERT INTO public.:"stg"
  (doc_id, legislation_id, article_id, article_number, law_number_raw, law_article_raw,
   citation_type, citation_context, match_method, resolved, unresolved_reason, src_citation_id)
WITH
name_alias(name, legislation_id) AS (VALUES
  ('Про приватизацію державного житлового фонду', 24),
  ('Про загальнообов''язкове державне соціальне страхування від нещасних випадків на виробництві та професійних захворювань', 76),
  ('Про загальнообов''язкове державне соціальне страхування від нещасного випадку на виробництві...', 76),
  ('Про державну реєстрацію юридичних осіб  та фізичних осіб – підприємців', 631),
  ('Про державну реєстрацію юридичних осіб та  фізичних осіб - підприємців', 631),
  ('Про державну реєстрацію юридичних осіб та фізичних осіб', 631),
  ('Про державну реєстрацію юридичних осіб та фізичних осіб - під-приємців', 631),
  ('Про державну реєстрацію юридичних осіб та фізичних осіб - підприємців', 631),
  ('Про державну реєстрацію юридичних осіб та фізичних осіб -підприємців', 631),
  ('Про державну реєстрацію юридичних осіб та фізичних осіб підприємців', 631),
  ('Про державну реєстрацію юридичних осіб та фізичних осіб – підприємців', 631),
  ('Про державну реєстрацію юридичних осіб та фізичних осіб –підприємців', 631),
  ('Про державну реєстрацію юридичних осіб та фізичних осіб —підприємців', 631),
  ('Про державну реєстрацію юридичних осіб та фізичних осіб-підприємців', 631),
  ('Про державну реєстрацію юридичних осіб та фізичних осіб–підприємців', 631),
  ('Про державну реєстрацію юридичних осіб та фізичних осіб—підприємців', 631),
  ('Про державну реєстрацію юридичних осіб та  фізичних осіб - підприємців', 631),
  ('Про державну реєстрацію юридичних осіб і фізичних осіб - підприємців', 631),
  ('Про державну реєстрацію юридичних осіб і фізичних осіб-підприємців', 631),
  ('Про державну реєстрацію юридичних та фізичних осіб - підприємців', 631),
  ('Про державну реєстрацію юридичних чи фізичних осіб- підприємців', 631),
  ('Про державну реєстрацію юридичних і фізичних осіб - підприємців', 631),
  ('Про основи соціальної захищеності інвалідів', 671),
  ('Про основи соціальної захищеності інвалідів Україні', 671),
  ('Про основи соціальної захищеності інвалідів в Україні', 671),
  ('Про загальнообов''язкове державне пенсійне страхування.', 693),
  ('Про загальнообов''язкове  державне пенсійне страхування', 693),
  ('Про загальнообовязкове державне пенсійне страхування', 693),
  ('Про загальнообов‘язкове державне пенсійне страхування', 693),
  ('Про загальнообов’язкове  державне пенсійне страхування', 693),
  ('Про загальнообов’язкове державне пенсійне страхування', 693),
  ('Житловий кодекс України', 756),
  ('Про  відновлення платоспроможності боржника або визнання його банкрутом', 757),
  ('Про банкрутство', 757),
  ('Про відновлення   2 платоспроможності боржника або визнання його банкрутом''', 757),
  ('Про відновлення платоспроможності  боржника   або визнання   його банкрутом', 757),
  ('Про відновлення платоспроможності  боржника або визнання його банкрутом', 757),
  ('Про відновлення платоспроможності або визнання його банкрутом', 757),
  ('Про відновлення платоспроможності божника або визнання його банкрутом', 757),
  ('Про відновлення платоспроможності боржника  або  визнання його  банкрутом', 757),
  ('Про відновлення платоспроможності боржника  або визнання його  банкрутом', 757),
  ('Про відновлення платоспроможності боржника  або визнання його банкрутом', 757),
  ('Про відновлення платоспроможності боржника або визнання  його  банкрутом', 757),
  ('Про відновлення платоспроможності боржника або визнання  його банкрутом', 757),
  ('Про відновлення платоспроможності боржника або визнання боржника банкрутом', 757),
  ('Про відновлення платоспроможності боржника або визнання його  банкрутом', 757),
  ('Про відновлення платоспроможності боржника або визнання йото банкрутом', 757),
  ('Про відновлення платоспроможності боржника або визнаня його банкрутом', 757),
  ('Про відновлення платоспроможності боржника або про визнання його банкрутом', 757),
  ('Про відновлення платоспроможності боржника та визнання його банкрутом', 757),
  ('Про відновлення платоспроможності боржника, або визнання його  банкрутом', 757),
  ('Про відновлення платоспроможності боржника, або визнання його банкрутом', 757),
  ('Про відновлення платоспроможності боржника  або визнання його банкрутом', 757),
  ('Про відновлення платоспроможності боржника  або визнання  його банкрутом', 757),
  ('Про відновлення платоспроможності боржникаабо визнання його банкрутом', 757),
  ('Про відновлення платоспроможності  боржника  або визнання його банкрутом', 757),
  ('Про відновлення платоспроможності   боржника або визнання його банкрутом', 757),
  ('Про відновлення платоспроможності               боржника або визнання його банкрутом', 757),
  ('Про  відновлення платоспроможності боржника або визнання його банкрутом', 757),
  ('Про систему оподатковування', 758),
  ('Про Державну податкову службу в Україні', 762),
  ('Про державну податкову службу', 762),
  ('Про державну податкову службу України', 762),
  ('Про державну податкову службу в України', 762),
  ('Про порядок погашення зобов', 763),
  ('Про порядок погашення зобов''язань  платників податків перед бюджетами та державними цільовими фондами', 763),
  ('Про порядок погашення зобов''язань  платників податків перед бюджетами і державними цільовими фондами', 763),
  ('Про порядок погашення зобов''язань платниками податків перед бюджетами та державними цільовими фондами', 763),
  ('Про порядок погашення зобов''язань платників  податків  перед  бюджетами  та   державними   цільовими фондами', 763),
  ('Про порядок погашення зобов''язань платників перед  бюджетами та державними цільовими фондами', 763),
  ('Про порядок погашення зобов''язань платників податків перед бюджетами', 763),
  ('Про порядок погашення зобов''язань платників податків перед бюджетами и державними цільовими фондами', 763),
  ('Про порядок погашення зобов''язань платників податків перед бюджетами та державним цільовими фондами', 763),
  ('Про порядок погашення зобов''язань платників податків перед бюджетами та державними цільовими, фондами', 763),
  ('Про порядок погашення зобов''язань платників податків перед бюджетами та держаними цільовими фондами', 763),
  ('Про порядок погашення зобов''язань платників податків перед бюджетами та цільовими фондами', 763),
  ('Про порядок погашення зобов''язань платників податків перед бюджетами і державними цільовими фондами', 763),
  ('Про порядок погашення зобов''язань платників податків перед бюджетами, та державними цільовими фондами', 763),
  ('Про порядок погашення зобов''язань платників податків перед бюджетними та державними цільовими фондами', 763),
  ('Про порядок погашення зобов''язань платників податків перед бюджетом та державними цільовими фондами', 763),
  ('Про порядок погашення зобов''язань платників податків перед бюджетом та цільовими фондами', 763),
  ('Про порядок погашення зобов''язань платників податків  перед бюджетами й державними цільовими фондами', 763),
  ('Про порядок погашення зобов''язань платників податків  перед бюджетами та державними цільовими фондами', 763),
  ('Про порядок погашення зобов''язань  платників податків перед бюджетами та державними цільовими фондами', 763),
  ('Про порядок погашення зобов''язань  платників податків перед бюджетами і державними цільовими фондами', 763),
  ('Про порядок погашення зобов’язань  платників податків  перед бюджетами та державними цільовими фондами', 763),
  ('Про порядок погашення зобов’язань платників податків перед бюджетами та державними  цільовими фондами', 763),
  ('Про порядок погашення зобов’язань платників податків перед бюджетами та державними цільовими фондами', 763),
  ('Про порядок погашення зобов’язань платників податків перед бюджетами та цільовими фондами', 763),
  ('Про порядок погашення зобов’язань платників податків перед бюджетом та державними цільовими фондами', 763),
  ('Про ПДВ', 765),
  ('Про податок на додану вартість № НОМЕР_23р. із змінами та доповненнями), Порядку заповнення податкової накладної ВАТ', 765),
  ('Про оподаткування прибутку підприємства', 766),
  ('Про місцеве самоврядування', 767),
  ('Про місцеве самоврядування в України', 767),
  ('Про місцеве самоврядування вУкраїні', 767),
  ('Про застосування РРО в свері торгівлі громадського харчування та послуг', 769),
  ('Про застосування РРО в сфері торгівлі, громадського харчування та послуг', 769),
  ('Про застосування РРО у сфері торгівлі,', 769),
  ('Про застосування РРО у сфері торгівлі, громадського харчування та послуг', 769),
  ('Про застосування реєстраторів розрахункових   операцій у сфері торгівлі, громадського харчування та послуг', 769),
  ('Про застосування реєстраторів розрахункових операцій в сфері торгівлі, громадського харчування та послуг', 769),
  ('Про застосування реєстраторів розрахункових операцій у сфері торгівлі громадського харчування та послуг', 769),
  ('Про застосування реєстраторів розрахункових операцій у сфері торгівлі, громадського харчування й послуг', 769),
  ('Про застосування реєстраторів розрахункових операцій у сфері торгівлі, суспільного харчування та послуг', 769),
  ('Про застосування реєстраторів розрахункових операцій у сфері торгівлі,    громадського харчування та послуг', 769),
  ('Про застосування реєстраторів розрахункових операцій у сфері торгівлі,громадського харчування та послуг', 769),
  ('Про застосування реєстраторів розрахункових операцій і сфері торгівлі, громадського харчування та послуг', 769),
  ('Про застосування реєстраторів розрахункових операції у сфері торгівлі, громадського харчування та послуг', 769),
  ('Про застосування реєстраторів розрахункових         операцій у сфері торгівлі, громадського харчування та послуг', 769),
  ('Про житлово - комунальні послуги', 772),
  ('Про житлово-комунальні послуги від 24.06.2004 p., п.23', 772),
  ('Про автомобільний транспорт.', 773)
),
lawmap AS (
  SELECT 'КУПАП'::text v, 653 legislation_id, 'alias'::text method
  UNION ALL SELECT 'КУПАП',22,'alias'
  UNION ALL SELECT 'КУпАП',653,'alias'
  UNION ALL SELECT 'КУпАП',22,'alias'
  UNION ALL SELECT 'КЗПП',643,'alias'
  UNION ALL SELECT 'КЗпП',643,'alias'
  UNION ALL SELECT name, legislation_id, 'name_alias' FROM name_alias),
la_cur AS (SELECT legislation_id, count(*) c FROM legislation_articles WHERE is_current GROUP BY 1),
la_any AS (SELECT legislation_id, count(*) a FROM legislation_articles GROUP BY 1),
canon AS (
  SELECT DISTINCT ON (l.title) l.title, l.id AS legislation_id
  FROM legislation l LEFT JOIN la_cur cu ON cu.legislation_id=l.id LEFT JOIN la_any an ON an.legislation_id=l.id
  ORDER BY l.title, COALESCE(cu.c,0) DESC, COALESCE(an.a,0) DESC, l.id),
canon_fold AS (
  -- The same acts keyed on the folded title, used only where the exact join
  -- missed. Ambiguity is REFUSED, not settled by preference: 13 folded keys
  -- cover 34 acts, and «про виконавче провадження» is two genuinely different
  -- laws (1999 and 2016). Binding either would be a guess dressed as a match.
  SELECT k, min(legislation_id) AS legislation_id
  FROM (SELECT public.lcl_title_key(l.title) AS k, l.id AS legislation_id
        FROM legislation l WHERE l.title IS NOT NULL AND btrim(l.title) <> '') f
  GROUP BY k HAVING count(DISTINCT legislation_id) = 1),
best_art AS (
  -- Keyed on the article number with any «п.» prefix stripped, so the join in
  -- withart stays a plain equality and therefore a Hash Left Join. Matching
  -- both spellings with IN instead costs a Materialize and a nested loop:
  -- measured, planner cost 7.0e9 against 3.7e8, nineteen times worse.
  --
  -- 780 acts hold BOTH «X» and «п.X»; the ordering prefers the bare form, so
  -- the collision is resolved once here rather than per citation.
  SELECT DISTINCT ON (legislation_id, art_key)
         legislation_id, article_number, id AS article_id, art_key
  FROM (SELECT legislation_id, article_number, id, is_current, version_date,
               public.lcl_art_key(article_number) AS art_key
          FROM legislation_articles) x
  ORDER BY legislation_id, art_key, (btrim(article_number) NOT LIKE 'п.%') DESC,
           is_current DESC, version_date DESC NULLS LAST),
-- ---------------------------------------------------------------------------
-- The NUMBER leg. Native port of scripts/citation-graph/repair-lcl-by-number.sql
-- (PR #2275), which bound 604 379 citations that name a law only by number.
-- Without it every rebuild silently destroys all of them.
--
-- Resolved per DISTINCT value, then hash-joined back. law_number is a small
-- vocabulary — a 0.05% sample holds 163 861 rows but only 1 362 distinct values
-- — so the expensive part runs once per distinct string, not once per row.
--
-- It deliberately does NOT reference best_art. Doing so would make best_art a
-- twice-referenced CTE, which PG 15 then materialises instead of inlining,
-- flipping the largest join from Hash Left Join to Merge Right Join: measured
-- 1.56x slower with double the temp spill. Article binding is left to the
-- existing withart join, which already covers rows the number leg supplies.
numparse AS (
  SELECT DISTINCT
         btrim(regexp_replace(law_number,'\s+',' ','g')) AS v,
         (regexp_match(law_number,
            '^\s*№?\s*([0-9]{1,5})-?\s*(?:від\s+[0-9]{1,2}\.[0-9]{1,2}\.[0-9]{4})?\s*$'))[1] AS core,
         public.try_to_date(
           (regexp_match(law_number, 'від\s+([0-9]{1,2}\.[0-9]{1,2}\.[0-9]{4})'))[1],
           'DD.MM.YYYY') AS dt
  FROM public.law_court_citations
  WHERE law_number ~ '^\s*№?\s*[0-9]{1,5}-?\s*(?:від\s+[0-9]{1,2}\.[0-9]{1,2}\.[0-9]{4})?\s*$'),
-- The OFFICIAL-number leg. After LEXAI-1947 re-extracted 2 011 252 decisions,
-- law_number holds the real number — «2262-XII», «1058-IV», «254к/96-ВР» —
-- instead of the truncated «2262-» the old extractor produced.
--
-- numparse above only understands the DAMAGED shape (digits, optional trailing
-- hyphen), so on corrected data it matches nothing: the first rebuild after the
-- re-extraction dropped the number leg from 28 617 resolved to 3 108 precisely
-- because fixing the data broke a parser written for the breakage.
--
-- npa.act_number already holds these as 'official'/'official_alt' aliases, so
-- the whole value is looked up directly. Measured: 2 688 605 rows now carry a
-- Roman suffix and 2 311 894 of them resolve to exactly one curated act.
numfull AS (
  -- The date suffix is part of how courts write a number: «№2262-ХІІ від
  -- 09.04.1992». Anchoring the pattern at the number's end rejected all of it —
  -- 22 254 distinct values over 3 148 057 rows — even though numparse beside it
  -- has understood the date form all along. The number and the date are captured
  -- separately: the number does the lookup, the date settles the convocation.
  SELECT DISTINCT
         btrim(regexp_replace(law_number, '\s+', ' ', 'g')) AS v,
         (regexp_match(law_number,
            '^\s*№?\s*([0-9]{1,5}[а-яіїєґ]?(?:[-/][0-9A-Za-zА-Яа-яІЇЄҐіїєґ/-]{1,12})?)'))[1] AS num,
         public.try_to_date(
           (regexp_match(law_number, 'від\s+([0-9]{1,2}\.[0-9]{1,2}\.[0-9]{4})'))[1],
           'DD.MM.YYYY') AS dt
  FROM public.law_court_citations
  WHERE law_number ~ '^\s*№?\s*[0-9]{1,5}[а-яіїєґ]?(?:[-/][0-9A-Za-zА-Яа-яІЇЄҐіїєґ/-]{1,12})?\s*(?:від\s+[0-9]{1,2}\.[0-9]{1,2}\.[0-9]{4})?\s*$'),
numfullcand AS (
  -- Ambiguity judged over the WHOLE corpus before the curated set narrows it,
  -- for the same reason as numcand: filtering first makes a number that names
  -- several acts look unambiguous. Where the citation gives a date, only acts
  -- adopted on it stay in the running — that is what takes «2262» from six
  -- convocations down to one.
  SELECT f.v, array_agg(DISTINCT an.nreg) AS nregs
  FROM numfull f
  JOIN npa.act_number an ON an.alias_norm = npa.norm_number(f.num)
                        AND an.kind IN ('official', 'official_alt', 'nreg')
  JOIN npa.act a ON a.nreg = an.nreg AND (f.dt IS NULL OR a.first_ed = f.dt)
  WHERE f.num IS NOT NULL
  GROUP BY f.v),
numfullmap AS (
  SELECT c.v, pl.id AS legislation_id
  FROM numfullcand c
  JOIN public.legislation pl ON lower(pl.rada_id) = c.nregs[1]
  WHERE array_length(c.nregs, 1) = 1),
numcand AS (
  -- Ambiguity is judged over the WHOLE corpus, before anything narrows it.
  -- Joining public.legislation here instead would filter the rival candidates
  -- away BEFORE the count, so a number naming three acts of which only one
  -- happens to be curated would look unambiguous and bind — silently
  -- attributing law to whichever act we happen to hold. That is precisely the
  -- guess this leg exists to refuse.
  SELECT p.v, array_agg(DISTINCT an.nreg) AS nregs
  FROM numparse p
  JOIN npa.act_number an ON an.alias_norm = npa.norm_number(p.core) AND an.kind = 'core_only'
  JOIN npa.act a         ON a.nreg = an.nreg AND (p.dt IS NULL OR a.first_ed = p.dt)
  WHERE p.core IS NOT NULL
  GROUP BY p.v),
numbermap AS (
  -- Exactly one act corpus-wide, and it has to be one we can point at.
  -- legislation_id references public.legislation (651 curated acts), so a
  -- citation naming any of the other ~292 000 stays unresolved however well
  -- its number parses. That cap is structural, and it is applied AFTER the
  -- ambiguity test, never as part of it.
  SELECT c.v, pl.id AS legislation_id
  FROM numcand c
  JOIN public.legislation pl ON lower(pl.rada_id) = c.nregs[1]
  WHERE array_length(c.nregs, 1) = 1),
matched AS (
  SELECT lcc.id cid, lcc.court_case_id doc_id, lcc.law_number, lcc.law_article, lcc.citation_type,
         lcc.citation_context, nrm.v,
         -- Number comes LAST: it can only fill a row the title and alias legs
         -- left NULL. Measured on prod: of 160 708 already-bound rows, ZERO
         -- carry a number-shaped law_number, so the two populations are
         -- disjoint and this can never override a working binding.
         COALESCE(lm.legislation_id, can.legislation_id, cf.legislation_id,
                  nf.legislation_id, nb.legislation_id) lid,
         CASE WHEN lm.v IS NOT NULL THEN lm.method
              WHEN can.title IS NOT NULL AND nrm.v<>lcc.law_number THEN 'normalized'
              WHEN can.title IS NOT NULL THEN 'exact_title'
              WHEN cf.legislation_id IS NOT NULL THEN 'title_fold'
              WHEN COALESCE(nf.legislation_id, nb.legislation_id) IS NOT NULL THEN 'number' END method
  FROM public.law_court_citations lcc
  CROSS JOIN LATERAL (SELECT btrim(regexp_replace(lcc.law_number,'\s+',' ','g')) v) nrm
  LEFT JOIN lawmap lm ON lm.v = nrm.v
  LEFT JOIN canon can ON can.title = nrm.v
  -- Ranked after the exact title so a working binding can never be displaced;
  -- it only fills rows canon left NULL. Its own method name keeps the gain
  -- measurable instead of hiding inside 'normalized'.
  LEFT JOIN canon_fold cf ON cf.k = public.lcl_title_key(nrm.v)
  LEFT JOIN numfullmap nf ON nf.v = nrm.v
  LEFT JOIN numbermap  nb ON nb.v = nrm.v),
withart AS (
  -- Articles match under both the bare number and the «п.» prefix, because
  -- best_art is keyed on the stripped form.
  --
  -- This is the leg that was being applied out of band. On prod today,
  -- match_method='transitional_point' holds 21 169 rows / 21 004 resolved that
  -- nothing in this repository produces — every one a ПКУ transitional
  -- provision where the citation says «69.1» and the article is stored as
  -- «п.69.1». The act already bound by title; only the article was lost.
  -- Reproducing it here means a rebuild stops destroying those rows: measured,
  -- the stripped key reproduces 21 004 of 21 004 with zero lost and binds
  -- 1 103 further rows that are unresolved today, across the 71 acts that keep
  -- п.-prefixed articles.
  -- Stripped on BOTH sides. No citation in the corpus carries the prefix
  -- today — 0 of 168 819 sampled source rows and 0 in the built links — but
  -- normalising only one side would silently miss the day the extractor starts
  -- emitting «п.38.6», and symmetry costs +0.011% of planner cost with the
  -- plan shape unchanged.
  SELECT m.*, ba.article_id, ba.article_number
  FROM matched m
  LEFT JOIN best_art ba ON ba.legislation_id = m.lid
                       AND ba.art_key = public.lcl_art_key(m.law_article)),
pick AS (
  SELECT DISTINCT ON (cid) doc_id, lid, article_id, article_number, law_number, law_article,
         citation_type, citation_context, v, method, cid
  FROM withart ORDER BY cid, (article_id IS NOT NULL) DESC, lid NULLS LAST)
SELECT doc_id, lid, article_id, article_number, law_number, law_article, citation_type, citation_context,
  CASE WHEN v='ВС' THEN 'unresolved' WHEN method IS NULL THEN 'unresolved' ELSE method END,
  (article_id IS NOT NULL),
  CASE WHEN article_id IS NOT NULL THEN NULL WHEN v='ВС' THEN 'not_legislation'
       WHEN lid IS NULL THEN 'law_not_in_registry' ELSE 'article_not_found' END,
  cid
FROM pick;
CREATE INDEX ON public.:"stg"(doc_id);
CREATE INDEX ON public.:"stg"(article_id);
CREATE INDEX ON public.:"stg"(legislation_id, article_number);
CREATE INDEX ON public.:"stg"(resolved);

-- The swap, and the check that gates it, are ONE transaction that first takes
-- an ACCESS EXCLUSIVE lock on the live table.
--
-- That is what actually makes this safe. The advisory lock above is only
-- best-effort: it is session-scoped, and no session-scoped mechanism survives
-- a transaction-pooled connection, so it can do no more than stop a second run
-- wasting 90 minutes. Correctness rests here instead — a transaction-scoped
-- table lock is honoured whatever the connection topology, and it serialises
-- the destructive step against any concurrent rebuild or writer. The row-count
-- comparison happens INSIDE that lock, so nothing can change between the
-- check and the swap.
BEGIN;

DO $swap$
DECLARE old_n bigint; new_n bigint;
BEGIN
  IF to_regclass('public.legislation_citation_links') IS NOT NULL THEN
    EXECUTE 'LOCK TABLE public.legislation_citation_links IN ACCESS EXCLUSIVE MODE';
    EXECUTE 'SELECT count(*) FROM public.legislation_citation_links' INTO old_n;
  ELSE
    old_n := NULL;  -- first build, nothing to compare against
  END IF;

  EXECUTE format('SELECT count(*) FROM public.%I', current_setting('lcl.stg')) INTO new_n;

  IF old_n IS NULL THEN
    RAISE NOTICE 'first build: no live table to compare against, % rows', new_n;
  ELSIF new_n < old_n * 0.9 THEN
    RAISE EXCEPTION 'refusing swap: new table has % rows, live table has % (< 90%%)', new_n, old_n;
  ELSE
    RAISE NOTICE 'swap approved: % rows replacing %', new_n, old_n;
  END IF;
END
$swap$;

DROP TABLE IF EXISTS public.legislation_citation_links;
ALTER TABLE public.:"stg" RENAME TO legislation_citation_links;

-- Indexes, the primary key and the bigserial were all created under the
-- staging name and keep it through a table rename, so they are renamed by
-- catalogue lookup rather than by guessing at names.
DO $rename$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT i.indexrelid::regclass::text AS idxname, a.attname
             FROM pg_index i
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
            WHERE i.indrelid = 'public.legislation_citation_links'::regclass
              AND NOT i.indisprimary
  LOOP
    n := n + 1;
    EXECUTE format('ALTER INDEX %s RENAME TO %I', r.idxname,
                   CASE r.attname WHEN 'doc_id' THEN 'idx_lcl_doc'
                                  WHEN 'article_id' THEN 'idx_lcl_article'
                                  WHEN 'legislation_id' THEN 'idx_lcl_legis'
                                  WHEN 'resolved' THEN 'idx_lcl_resolved'
                                  ELSE 'idx_lcl_' || r.attname END);
  END LOOP;

  EXECUTE format('ALTER INDEX %s RENAME TO legislation_citation_links_pkey',
                 (SELECT i.indexrelid::regclass::text FROM pg_index i
                   WHERE i.indrelid = 'public.legislation_citation_links'::regclass
                     AND i.indisprimary));
  EXECUTE format('ALTER SEQUENCE %s RENAME TO legislation_citation_links_id_seq',
                 pg_get_serial_sequence('public.legislation_citation_links', 'id'));
  RAISE NOTICE 'renamed % indexes plus pkey and sequence', n;
END
$rename$;

COMMIT;

\echo '=== COVERAGE ==='
SELECT count(*) total, count(*) FILTER (WHERE resolved) resolved,
       round(100.0*count(*) FILTER (WHERE resolved)/count(*),1) pct,
       count(DISTINCT doc_id) decisions, count(DISTINCT article_id) FILTER (WHERE resolved) distinct_articles
FROM public.legislation_citation_links;
\echo '=== by match_method ==='
SELECT match_method, count(*) n, count(*) FILTER (WHERE resolved) res FROM public.legislation_citation_links GROUP BY 1 ORDER BY 2 DESC;
\echo '=== number leg (was repair-lcl-by-number.sql) ==='
SELECT count(*) n, count(*) FILTER (WHERE resolved) res, count(DISTINCT legislation_id) acts
FROM public.legislation_citation_links WHERE match_method = 'number';
\echo '=== unresolved by reason ==='
SELECT unresolved_reason, count(*) FROM public.legislation_citation_links WHERE NOT resolved GROUP BY 1 ORDER BY 2 DESC;
