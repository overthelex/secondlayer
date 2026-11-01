-- 239_edrsr_parties_extractor.sql
-- LEXAI-1760: the extractor that fills edrsr_parties (schema from 167_edrsr_parties.sql).
--
-- 167 created the table, two partitions (2023 + default) and the coverage meta, and pointed
-- at a backfill procedure that was never committed. This migration adds:
--
--   1. edrsr_party_norm / edrsr_party_core / edrsr_extract_parties — a pure SQL/PL/pgSQL
--      parser of the claim caption ("за позовом X до Y, третя особа Z, про …") with a
--      header-label fallback ("Позивач: X … Відповідач: Y"). Anonymised persons (ОСОБА_N,
--      ІНФОРМАЦІЯ_N) are skipped. Multi-party captions are split on «, »/«та»/«і» only where
--      the next word starts a new name, with quoted names masked so «Ремонт та Сервіс» stays
--      one party.
--   2. name_core column: the innermost quoted name («Нова Пошта» → "нова пошта"), btree
--      indexed. It is what the read path matches a party_name against, mirroring the old
--      claim-clause regex, which also required the name to be followed by a closing quote —
--      «Нова Пошта Інтернешнл» is a different company and must not be counted.
--   3. One partition per adjudication year 2005..2030 (the default catches the rest).
--   4. edrsr_parties_progress + edrsr_backfill_parties_range(): a resumable backfill that
--      walks one edrsr_fulltext partition in PHYSICAL (heap block / ctid) order, chunk by
--      chunk, committing and checkpointing after each chunk. Measured on prod (01.11.2026):
--      ctid order reads the HDD-backed TOAST sequentially (~200 MB/s, ~10-14k docs/s cold);
--      doc_id order is random I/O (~0.8-2k docs/s). A chunk that raises (corrupt pglz,
--      missing TOAST chunk, bad bytes) is retried row by row; rows that still fail go to
--      edrsr_parties_failed and the chunk is still checkpointed.
--   5. A statement-level trigger on edrsr_fulltext so newly harvested decisions (INSERT) and
--      refetched texts (UPDATE of full_text) get their parties without a separate job. It
--      can never fail the harvest: any error is downgraded to a WARNING.
--
-- Nothing here reads the 1.5 TB of full texts: the migration is DDL only and runs in
-- milliseconds. The backfill is started by hand (scripts/edrsr/backfill-edrsr-parties.sh).
--
-- Scope (phase 1): justice_kind 1 (civil), 3 (commercial), 4 (administrative); roles
-- 1 = позивач, 2 = відповідач, 3 = третя особа. Applicant/debtor of court orders (заявник,
-- стягувач, боржник), criminal roles and EDRPOU matching against the registry stay deferred;
-- an EDRPOU printed in the caption ("(код ЄДРПОУ 12345678)") is captured into edrpou.
--
-- All DDL is idempotent.

SET lock_timeout = '30s';

-- ---------------------------------------------------------------------------------------
-- 1. Normalisation helpers
-- ---------------------------------------------------------------------------------------

-- Lower-case, unify apostrophes, drop quotes and punctuation (keep letters, digits, ' and -),
-- collapse whitespace. The TypeScript read path (EdsrFtsService.partyNameKeys) mirrors this.
CREATE OR REPLACE FUNCTION edrsr_party_norm(p text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$fn$
  SELECT nullif(btrim(regexp_replace(
           regexp_replace(lower(translate(p, '’`ʼ‘', '''''''''')), '[^[:alnum:]''-]+', ' ', 'g'),
           '\s+', ' ', 'g')), '')
$fn$;

-- The innermost quoted name: the last non-blank segment that sits BETWEEN two quote marks.
--   ТОВ «Нова Пошта»                                   → нова пошта
--   АТ «Комерційний банк «ПриватБанк»»                 → приватбанк
--   ТОВ "Компанія "Х""  (ASCII quotes, ambiguous)      → х
-- NULL when the name carries no quoted part (state bodies, unquoted names).
CREATE OR REPLACE FUNCTION edrsr_party_core(p text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS
$fn$
DECLARE
  parts text[];
  i int;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  parts := regexp_split_to_array(p, '[«»"“”„‟]');
  IF array_length(parts, 1) < 3 THEN RETURN NULL; END IF;
  FOR i IN REVERSE array_length(parts, 1) - 1 .. 2 LOOP
    IF btrim(parts[i]) <> '' THEN
      RETURN edrsr_party_norm(parts[i]);
    END IF;
  END LOOP;
  RETURN NULL;
END
$fn$;

-- ---------------------------------------------------------------------------------------
-- 2. The caption parser
-- ---------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION edrsr_extract_parties(p_text text)
RETURNS TABLE(role smallint, ord smallint, name_raw text, name_norm text, name_core text, edrpou text)
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS
$fn$
DECLARE
  -- Private-use code points as mask delimiters: never present in decision texts.
  q0 constant text := chr(57344);   -- start of a masked quoted-segment token
  q1 constant text := chr(57345);   -- end of it
  c0 constant text := chr(57346);   -- an EDRPOU lifted out of a parenthetical
  c1 constant text := chr(57347);
  -- The claim caption: "за позовом X до Y …", "за адміністративним позовом", "за позовною
  -- заявою". Case-sensitive so the lookahead can reject a lower-case continuation while still
  -- accepting a name glued to the keyword ("за позовомТовариства").
  claim_re constant text :=
    '(?:[Зз]а|ЗА)\s+(?:адміністративн[[:alpha:]]*\s+|цивільн[[:alpha:]]*\s+|господарськ[[:alpha:]]*\s+|первісн[[:alpha:]]*\s+)?'
    '(?:позовом|позовною\s+заявою|позовною|позовними\s+заявами)(?![а-яіїєґ''])\s*:?\s*';
  -- Second form, only when there is no claim clause: "розглянувши позовну заяву X до Y".
  claim2_re constant text :=
    '(?:розглянув|розглядаюч|вивчив|ознайомив|перевірив|одержав|отримав)[[:alpha:]]*(?:\s+[^\s.]+){0,10}\s+'
    '(?:позовн(?:у|ої|ою)\s+заяв(?:у|и|ою)|позов\s*:)\s*:?\s*'
    '(?=[А-ЯІЇЄҐA-Z«"“„]|гр\.|громадян|товариств|підприємств|управлінн|відділ|комунальн|державн|приватн|публічн|акціонерн|фізичн)';
  -- Where a caption ends: the subject ("про …", "щодо …" but not "щодо предмета спору"), the
  -- reasoning ("ВСТАНОВИВ"), an appeal clause, "за участю" (attendance list), "у справі №".
  term_re constant text :=
    '\s(?:про|Про)\s|\sщодо\s(?!предмет)|\s(?:про|щодо):|\sпро(?=визнан|стягнен|скасуван|зобов|відшкод|розірван|поновлен|встановлен|звернен|забезпеч|видач)'
    '|[\s,;.]*(?:ВСТАНОВИ|УСТАНОВИ|В\s+С\s+Т\s+А\s+Н|В\s+С\s+ТА\s+Н|встановив|встановила|встановил|установив|у\s+с\s+т\s+а\s+н|в\s+с\s+т\s+а\s+н'
    '|[Зз]а\s+участю|за\s+апеляційн|за\s+касаційн|за\s+зустрічн|у\s+справі\s+№|у\s+порядку\s+|в\s+порядку\s+|без\s+виклику'
    '|(?:Ціна|ціна)\s+позову|предмет\s+позову)';
  -- Third-party introducer with its optional legal boilerplate, in any order.
  tp_start_re constant text :=
    '[\s,;(]*(?:трет(?:я|і|ьої|іх|ій|ьою)(?:\s*-?\s*\d)?\s+особ[[:alpha:]]*|заінтересован[[:alpha:]]*\s+особ[[:alpha:]]*)';
  tp_intro_re constant text :=
    '[\s,;(]*(?:трет(?:я|і|ьої|іх|ій|ьою)(?:\s*-?\s*\d)?\s+особ[[:alpha:]]*(?:\s*-?\s*\d)?|заінтересован[[:alpha:]]*\s+особ[[:alpha:]]*)'
    '(?:\s*,?\s*(?:як(?:а|і)\s+(?:не\s+)?заявля[[:alpha:]]*\s+самостійн[[:alpha:]]*\s+вимог[[:alpha:]]*(?:\s+(?:щодо|на|відносно)\s+предмет[[:alpha:]]*\s+спору)?'
    '|на\s+стороні\s+[[:alpha:]]+))*\s*[:-]?\s*';
  -- Lower-case words that open an organisation name (old texts write "до управління …").
  org_head constant text :=
    '(?:виконавч|управлінн|відділ|товариств|підприємств|комунальн|державн|приватн|публічн|акціонерн|кооператив|головн'
    '|міськ|сільськ|селищн|районн|обласн|фонд|банк|компані|служб|інспекц|департамент|міністерств|адміністрац|заклад'
    '|установ|об.єднанн|спілк|фермерськ|національн|військов|прокурат|прокурор|територіальн|концерн|корпораці'
    '|асоціаці|громадськ|навчальн|центр|комітет|рад[аиі]\M|філі|представництв|університет|інститут|лікарн|дирекці'
    '|агентств|казначейств|відкрит|закрит|дочірн|колективн)';
  t text;
  w text;
  cap text;
  hdr text;
  pl text;
  df text;
  tp text;
  s int;
  e int;
  k int;
  rnd int;
  quoted text[];
  m text[];
  spans text[];
  seg text;
  segs text[];
  split_re text;
  code text;
  nm text;
  nn text;
  seen text[] := '{}';
  cnt int[] := '{0,0,0}';
  i int;
  j int;
  si int;
BEGIN
  IF p_text IS NULL OR p_text = '' THEN RETURN; END IF;

  -- A new party starts at a separator followed by an optional "до"/enumerator and then a
  -- capital letter, an opening quote, a masked quote token, or (after a comma only) a
  -- lower-case organisation head word.
  split_re :=
    '\s*[,;]\s*(?:-\s*)?(?:(?:та|і|й)\s+)?(?:до\s+)?(?:\d{1,2}\s*[.)]\s*)?(?=[А-ЯІЇЄҐA-Z«"“„' || q0 || ']|' || org_head || ')'
    '|(?:\s+|(?<=\d))(?:та|і|й)\s+(?:до\s+)?(?:\d{1,2}\s*[.)]\s*)?(?=[А-ЯІЇЄҐA-Z«"“„' || q0 || '])'
    '|\s+(?:до\s+)?\d{1,2}\s*[.)]\s+(?=[А-ЯІЇЄҐA-Z«"“„' || q0 || '])';

  -- Whitespace: NBSP/thin spaces, RTF "\~" artefacts, underscore rulers → single spaces.
  t := regexp_replace(left(p_text, 6000), '\\~|_{3,}|[\s\u00a0\u2000-\u200b\u202f]+', ' ', 'g');
  t := translate(t, '–—', '--');
  t := regexp_replace(t, '(?<=[[:alpha:]])"(?=[яюєїЯЮЄЇ])', '''', 'g');

  ---------------------------------------------------------------------------- claim clause
  -- The earlier of the two caption forms (a later "за позовом" is usually body prose).
  s := regexp_instr(t, claim_re, 1, 1, 1, '');
  k := regexp_instr(t, claim2_re, 1, 1, 1, '');
  IF k > 0 AND (s = 0 OR k < s) THEN
    s := k;
  END IF;
  IF s > 0 THEN
    w := substr(t, s, 1200);
    e := regexp_instr(w, term_re, 1, 1, 0, '');
    IF e > 1 THEN
      cap := left(w, e - 1);
      -- Plaintiff | defendant split on the first "до"/"проти" (also glued: "ОСОБА_1до ОСОБА_2").
      k := regexp_instr(cap, '(?:\s|(?<=[\d»"”)]))(?:(?:до|проти|До)(?:\s*:)?\s+|до(?=[А-ЯІЇЄҐ«"“„]))', 1, 1, 0, '');
      IF k > 0 THEN
        pl := left(cap, k - 1);
        df := substr(cap, regexp_instr(cap, '(?:\s|(?<=[\d»"”)]))(?:(?:до|проти|До)(?:\s*:)?\s+|до(?=[А-ЯІЇЄҐ«"“„]))', 1, 1, 1, ''));
      END IF;
    END IF;
  END IF;

  ------------------------------------------------------------------ header-label fallback
  -- "Позивач: X … Відповідач: Y", "учасники справи: позивач Товариство … відповідач …".
  -- Only in the header (before the reasoning starts): in the body «позивач» is prose.
  IF pl IS NULL THEN
    e := regexp_instr(t, 'ВСТАНОВИ|УСТАНОВИ|В\s+С\s+Т\s+А\s+Н|встановив|встановила|установив', 1, 1, 0, '');
    hdr := CASE WHEN e > 0 THEN left(t, e - 1) ELSE left(t, 3000) END;
    s := regexp_instr(hdr, '(?:^|[\s,;.(])(?<!від\s)(?:[Пп]озивач|ПОЗИВАЧ)(?:і|ка|ів|а)?(?:\s*[:-]\s*|\s+(?=[А-ЯІЇЄҐA-Z«"“„]))', 1, 1, 1, '');
    k := regexp_instr(hdr, '(?:^|[\s,;.(])(?<!від\s)(?:[Вв]ідповідач|ВІДПОВІДАЧ)(?:і|ка|ів|а)?(?:\s*[:-]\s*|\s+(?=[А-ЯІЇЄҐA-Z«"“„]))', 1, 1, 1, '');
    IF s > 0 AND k > 0 THEN
      -- each label's value runs to the next label / attendance marker
      pl := substr(hdr, s, 600);
      e := regexp_instr(pl, '[\s,;.]*(?:[Вв]ідповідач|ВІДПОВІДАЧ|[Тт]рет[яі]\s+особ|ТРЕТ|[Пп]редставник|[Сс]екретар|[Сс]уддя|за\s+участю|розглянув|[Пп]озивач|[Пп]редмет)', 1, 1, 0, '');
      pl := CASE WHEN e > 1 THEN left(pl, e - 1) END;
      df := substr(hdr, k, 600);
      e := regexp_instr(df, '[\s,;.]*(?:[Пп]озивач|ПОЗИВАЧ|[Пп]редставник|[Сс]екретар|[Сс]уддя|за\s+участю|розглянув|[Вв]ідповідач|[Пп]редмет|про\s|щодо\s)', 1, 1, 0, '');
      df := CASE WHEN e > 1 THEN left(df, e - 1) END;
    END IF;
  END IF;

  IF pl IS NULL AND df IS NULL THEN RETURN; END IF;

  -- Third parties named inside a span: "до Y, третя особа: Z", "до Y, треті особи, які не
  -- заявляють самостійних вимог …, на стороні відповідача - Z" (rarely in the plaintiff span).
  IF df IS NOT NULL THEN
    k := regexp_instr(df, tp_start_re, 1, 1, 0, 'i');
    IF k > 0 THEN
      tp := substr(df, k);
      df := left(df, k - 1);
    END IF;
  END IF;
  IF pl IS NOT NULL THEN
    k := regexp_instr(pl, tp_start_re, 1, 1, 0, 'i');
    IF k > 0 THEN
      tp := concat_ws(', ', substr(pl, k), tp);
      pl := left(pl, k - 1);
    END IF;
  END IF;
  IF tp IS NOT NULL THEN
    tp := regexp_replace(tp, tp_intro_re, ', ', 'gi');
  END IF;

  spans := ARRAY[pl, df, tp];

  FOR i IN 1 .. 3 LOOP
    w := spans[i];
    CONTINUE WHEN w IS NULL OR btrim(w) = '';

    -- "Прокурора … в інтересах держави в особі Х" → prosecutor and the represented body are
    -- separate plaintiffs.
    -- Numbered role labels: "до відповідача-1: X, до відповідача -2 : Y" → separators.
    w := regexp_replace(w, '(?:^|[\s,;]+)(?:до\s+)?(?:позивач|відповідач)[[:alpha:]]*\s*-?\s*\d+\s*:\s*', ', ', 'gi');
    w := regexp_replace(w, '\s+(?:в|у)\s+інтересах\s+(?:держави\s+)?(?:(?:в|у)\s+особі\s*:?\s+)?(?:позивача\s+)?', ', ', 'gi');

    -- Mask quoted segments (innermost first) so separators inside names do not split them.
    quoted := '{}';
    rnd := 0;
    LOOP
      m := regexp_match(w, '«[^«»]*»|“[^“”„]*”|„[^“”„]*[”“]|"[^"]*"');
      EXIT WHEN m IS NULL OR rnd > 20;
      rnd := rnd + 1;
      quoted := quoted || m[1];
      w := overlay(w placing q0 || array_length(quoted, 1)::text || q1
                   from strpos(w, m[1]) for length(m[1]));
    END LOOP;

    -- Parentheticals (addresses, aliases, codes) go; a code inside one survives as a marker.
    rnd := 0;
    LOOP
      m := regexp_match(w, '\([^()]*\)');
      EXIT WHEN m IS NULL OR rnd > 20;
      rnd := rnd + 1;
      code := substring(m[1] from '(?:ЄДРПОУ|ЕДРПОУ|[Кк]од)[^0-9]{0,30}(\d{8})(?!\d)');
      w := overlay(w placing CASE WHEN code IS NOT NULL THEN ' ' || c0 || code || c1 || ' ' ELSE ' ' END
                   from strpos(w, m[1]) for length(m[1]));
    END LOOP;

    segs := regexp_split_to_array(w, split_re, '');

    si := 0;
    FOREACH seg IN ARRAY segs LOOP
      si := si + 1;
      -- EDRPOU: from a lifted parenthetical marker or an inline ", код ЄДРПОУ 12345678".
      code := coalesce(substring(seg from c0 || '(\d{8})' || c1),
                       substring(seg from '(?:ЄДРПОУ|ЕДРПОУ|[Кк]од)[^0-9]{0,30}(\d{8})(?!\d)'));
      seg := regexp_replace(seg, c0 || '\d{8}' || c1, ' ', 'g');
      -- Everything after the first comma is an address / code / location tail.
      seg := split_part(seg, ',', 1);
      seg := regexp_replace(seg, '\s+(?:в|у)\s+особі\s.*$', '');
      seg := regexp_replace(seg, '\s+(?:код\M|ЄДРПОУ|ЕДРПОУ|ідентифікаційн|РНОКПП|місцезнаходж|місце\s+знаходж|адреса\M|юридична\s+адреса|зареєстрован|який\s|яка\s|які\s|представник).*$', '', 'i');
      -- Leading role nouns / enumerators / stray "до", trailing punctuation.
      seg := regexp_replace(seg, '^[\s:;.-]*(?:за\s+позовом\s*:?\s*)?(?:(?:до|проти)\s+)?(?:(?:позивач|відповідач)[[:alpha:]]*\s*[:-]?\s*)?(?:\d{1,2}\s*[.)]\s*)?', '', 'i');
      seg := regexp_replace(seg, '[\s:;.,-]+$', '');
      -- Unmask quotes, newest (outermost) token first.
      IF array_length(quoted, 1) IS NOT NULL THEN
        FOR j IN REVERSE array_length(quoted, 1) .. 1 LOOP
          seg := replace(seg, q0 || j::text || q1, quoted[j]);
        END LOOP;
      END IF;
      nm := btrim(regexp_replace(seg, '\s+', ' ', 'g'));
      -- Over-anonymisation in the source: "ОСОБА_1 акціонерного товариства «Укртрансгаз»"
      -- (the anonymiser took "Публічного" for a surname) — keep the organisation.
      nm := regexp_replace(nm, '^ОСОБА_\d+\s+(?=(?:акціонерн|з\s+обмежен|товариств|підприємств|компані)[[:alpha:]]*)', '');

      -- Skip anonymised persons, locations and junk.
      CONTINUE WHEN nm IS NULL OR length(nm) < 3 OR length(nm) > 300;
      CONTINUE WHEN replace(nm, ' ', '') ~ '(?:ОСОБ|ІНФОРМАЦІ|НОМЕР|АДРЕСА|ПІБ)[[:alpha:]]*_\d';
      CONTINUE WHEN nm !~ '[[:alpha:]]{3}';
      CONTINUE WHEN nm ~* '^(?:не\s+з.явив|відсутн|без\s+участі|представник|особа|сторін|громадян|гр\.|трет[[:alpha:]]*\s+особ|та|і|до|про)(?:[\s.]|$)';
      CONTINUE WHEN nm ~* '^(?:товариств|підприємств|банк|компані|позивач|відповідач)[[:alpha:]]*$';
      CONTINUE WHEN nm ~* '^(?:м|с|смт|сел|вул|пров|просп|бул|пр|обл)\.' OR nm ~* '^(?:місто|село|селище)\s';
      CONTINUE WHEN nm ~* '^(?:[[:alpha:]''-]*(?:ськ|цьк|зьк)[[:alpha:]]*\s+){1,2}(?:область|обл\.?|району?|р-н|районі|області|областях|областей|республіка)$';
      -- A lone capitalised unquoted word after a comma is a town ("…, Маріуполь"), not a party.
      CONTINUE WHEN si > 1 AND nm ~ '^[А-ЯІЇЄҐ][а-яіїєґ''-]+$';
      nn := edrsr_party_norm(nm);
      CONTINUE WHEN nn IS NULL OR (i::text || ':' || nn) = ANY (seen);
      seen := seen || (i::text || ':' || nn);
      cnt[i] := cnt[i] + 1;

      role := i::smallint;
      ord := cnt[i]::smallint;
      name_raw := left(nm, 500);
      name_norm := left(nn, 500);
      name_core := left(edrsr_party_core(nm), 300);
      edrpou := code;
      RETURN NEXT;
    END LOOP;
  END LOOP;
END
$fn$;

COMMENT ON FUNCTION edrsr_extract_parties(text) IS
  'LEXAI-1760: plaintiff(1)/defendant(2)/third-party(3) names from an EDRSR decision caption (pass substr(full_text,1,3000)). Anonymised persons skipped.';

-- ---------------------------------------------------------------------------------------
-- 3. name_core + per-year partitions
-- ---------------------------------------------------------------------------------------

ALTER TABLE edrsr_parties ADD COLUMN IF NOT EXISTS name_core TEXT;   -- innermost quoted name, normalised (NULL if unquoted)
CREATE INDEX IF NOT EXISTS idx_edrsr_parties_core
  ON edrsr_parties (name_core, role) WHERE name_core IS NOT NULL;

DO $mig$
DECLARE
  y int;
BEGIN
  FOR y IN 2005 .. 2030 LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'edrsr_parties_p_' || y) THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF edrsr_parties FOR VALUES FROM (%s) TO (%s)',
                     'edrsr_parties_p_' || y, y, y + 1);
    END IF;
  END LOOP;
END
$mig$;

-- ---------------------------------------------------------------------------------------
-- 4. Resumable backfill
-- ---------------------------------------------------------------------------------------

-- Checkpoint per (year, worker window): next_block is the first heap block NOT yet done.
CREATE TABLE IF NOT EXISTS edrsr_parties_progress (
  adj_year    SMALLINT NOT NULL,
  blk_lo      BIGINT   NOT NULL,           -- window start (heap block of edrsr_fulltext_p_<year>)
  blk_hi      BIGINT   NOT NULL,           -- window end (exclusive)
  next_block  BIGINT   NOT NULL,
  docs        BIGINT   NOT NULL DEFAULT 0, -- edrsr_fulltext rows scanned in finished chunks
  parties     BIGINT   NOT NULL DEFAULT 0, -- party rows inserted
  failed      BIGINT   NOT NULL DEFAULT 0, -- rows that raised even one by one
  started_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  done_at     TIMESTAMPTZ,
  PRIMARY KEY (adj_year, blk_lo)
);

CREATE TABLE IF NOT EXISTS edrsr_parties_failed (
  doc_id     BIGINT NOT NULL,
  adj_year   SMALLINT,
  error      TEXT,
  failed_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (doc_id)
);

-- Insert the parties of every edrsr_fulltext row of one partition whose heap block lies in
-- [p_blk_lo, p_blk_hi). Shared by the backfill (per chunk) and nothing else; returns the
-- number of (docs scanned, parties inserted).
CREATE OR REPLACE FUNCTION edrsr_parties_extract_blocks(p_year int, p_blk_lo bigint, p_blk_hi bigint, p_prefix int DEFAULT 3000)
RETURNS TABLE(docs bigint, parties bigint)
LANGUAGE plpgsql AS
$fn$
DECLARE
  part   text := 'edrsr_fulltext_p_' || p_year;
  y_lo   timestamptz := make_timestamptz(p_year, 1, 1, 0, 0, 0, 'Europe/Kyiv');
  y_hi   timestamptz := make_timestamptz(p_year + 1, 1, 1, 0, 0, 0, 'Europe/Kyiv');
BEGIN
  -- The ctid range is a TID Range Scan: the heap and, through it, the TOAST relation are read
  -- in physical order. edrsr_documents (NVMe) is probed by doc_id for justice_kind/court/date.
  RETURN QUERY EXECUTE format($q$
    WITH src AS MATERIALIZED (
      SELECT f.doc_id, substr(f.full_text, 1, $5) AS head
        FROM %I f
       WHERE f.ctid >= format('(%%s,0)', $1)::tid AND f.ctid < format('(%%s,0)', $2)::tid
    ), ins AS (
      INSERT INTO edrsr_parties AS p
             (doc_id, role, ord, name_raw, name_norm, name_core, edrpou,
              court_code, justice_kind, adjudication_date, adj_year)
      SELECT s.doc_id, x.role, x.ord, x.name_raw, x.name_norm, x.name_core, x.edrpou,
             d.court_code, d.justice_kind, d.adjudication_date, $6
        FROM src s
        JOIN edrsr_documents d
          ON d.doc_id = s.doc_id AND d.adjudication_date >= $3 AND d.adjudication_date < $4
         AND d.justice_kind IN (1, 3, 4)
       CROSS JOIN LATERAL edrsr_extract_parties(s.head) x
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM src), (SELECT count(*) FROM ins)
  $q$, part)
  USING p_blk_lo, p_blk_hi, y_lo, y_hi, p_prefix, p_year::smallint;
END
$fn$;

-- Same for a single row, used when a whole chunk raised. Errors propagate to the caller.
CREATE OR REPLACE FUNCTION edrsr_parties_extract_doc(p_year int, p_doc_id bigint, p_prefix int DEFAULT 3000)
RETURNS bigint
LANGUAGE plpgsql AS
$fn$
DECLARE
  n bigint;
BEGIN
  INSERT INTO edrsr_parties AS p
         (doc_id, role, ord, name_raw, name_norm, name_core, edrpou,
          court_code, justice_kind, adjudication_date, adj_year)
  SELECT f.doc_id, x.role, x.ord, x.name_raw, x.name_norm, x.name_core, x.edrpou,
         d.court_code, d.justice_kind, d.adjudication_date, p_year
    FROM edrsr_fulltext f
    JOIN edrsr_documents d
      ON d.doc_id = f.doc_id
     AND d.adjudication_date >= make_timestamptz(p_year, 1, 1, 0, 0, 0, 'Europe/Kyiv')
     AND d.adjudication_date <  make_timestamptz(p_year + 1, 1, 1, 0, 0, 0, 'Europe/Kyiv')
     AND d.justice_kind IN (1, 3, 4)
   CROSS JOIN LATERAL edrsr_extract_parties(substr(f.full_text, 1, p_prefix)) x
   WHERE f.adj_year = p_year AND f.doc_id = p_doc_id
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;

-- CALL edrsr_backfill_parties_range(2023, 0, 496441, 2000);
-- Walks heap blocks [p_blk_lo, p_blk_hi) of edrsr_fulltext_p_<year> in chunks of
-- p_chunk_blocks, COMMITs after each chunk and records the next block in
-- edrsr_parties_progress, so a killed run resumes where it stopped (re-CALL with the same
-- window). Must be CALLed outside an explicit transaction (psql -c is fine).
CREATE OR REPLACE PROCEDURE edrsr_backfill_parties_range(
  p_year int, p_blk_lo bigint, p_blk_hi bigint, p_chunk_blocks int DEFAULT 2000)
LANGUAGE plpgsql AS
$fn$
DECLARE
  nxt   bigint;
  hi    bigint;
  r     record;
  d     bigint;
  pn    bigint;
  fl    bigint;
  t0    timestamptz;
  part  text := 'edrsr_fulltext_p_' || p_year;
BEGIN
  IF to_regclass(part) IS NULL THEN
    RAISE EXCEPTION 'no partition % for year %', part, p_year;
  END IF;
  INSERT INTO edrsr_parties_progress (adj_year, blk_lo, blk_hi, next_block)
  VALUES (p_year, p_blk_lo, p_blk_hi, p_blk_lo)
  ON CONFLICT (adj_year, blk_lo) DO UPDATE
    SET blk_hi = EXCLUDED.blk_hi,
        done_at = CASE WHEN edrsr_parties_progress.next_block >= EXCLUDED.blk_hi
                       THEN coalesce(edrsr_parties_progress.done_at, now()) END;
  SELECT next_block INTO nxt FROM edrsr_parties_progress WHERE adj_year = p_year AND blk_lo = p_blk_lo;
  COMMIT;

  WHILE nxt < p_blk_hi LOOP
    hi := least(nxt + p_chunk_blocks, p_blk_hi);
    t0 := clock_timestamp();
    fl := 0;
    BEGIN
      SELECT x.docs, x.parties INTO d, pn FROM edrsr_parties_extract_blocks(p_year, nxt, hi) x;
    EXCEPTION WHEN others THEN
      -- A bad row (corrupt TOAST, invalid bytes) aborted the chunk: redo it row by row.
      RAISE WARNING 'edrsr parties % blocks [%,%) failed as a chunk (%), retrying per row', p_year, nxt, hi, SQLERRM;
      d := 0; pn := 0;
      FOR r IN EXECUTE format(
        'SELECT doc_id FROM %I WHERE ctid >= format(''(%%s,0)'', $1)::tid AND ctid < format(''(%%s,0)'', $2)::tid',
        part) USING nxt, hi
      LOOP
        d := d + 1;
        BEGIN
          pn := pn + edrsr_parties_extract_doc(p_year, r.doc_id);
        EXCEPTION WHEN others THEN
          fl := fl + 1;
          INSERT INTO edrsr_parties_failed (doc_id, adj_year, error)
          VALUES (r.doc_id, p_year, left(SQLERRM, 500))
          ON CONFLICT (doc_id) DO UPDATE SET error = EXCLUDED.error, failed_at = now();
        END;
      END LOOP;
    END;

    UPDATE edrsr_parties_progress
       SET next_block = hi, docs = docs + d, parties = parties + pn, failed = failed + fl,
           updated_at = now(), done_at = CASE WHEN hi >= p_blk_hi THEN now() END
     WHERE adj_year = p_year AND blk_lo = p_blk_lo;
    COMMIT;
    RAISE NOTICE 'edrsr parties % [%,%) docs=% parties=% failed=% %ms', p_year, nxt, hi, d, pn, fl,
      round(extract(epoch FROM clock_timestamp() - t0) * 1000);
    nxt := hi;
  END LOOP;
END
$fn$;

-- Mark a year as served by the parties table once every window of it is done. Refuses while
-- a window is unfinished, so the read path never switches to a half-built year.
CREATE OR REPLACE FUNCTION edrsr_parties_mark_covered(p_year int)
RETURNS edrsr_parties_coverage
LANGUAGE plpgsql AS
$fn$
DECLARE
  blocks bigint;
  res edrsr_parties_coverage;
BEGIN
  blocks := pg_relation_size(('edrsr_fulltext_p_' || p_year)::regclass) / current_setting('block_size')::int;
  IF NOT EXISTS (SELECT 1 FROM edrsr_parties_progress WHERE adj_year = p_year) THEN
    RAISE EXCEPTION 'year % has no backfill windows', p_year;
  END IF;
  IF EXISTS (SELECT 1 FROM edrsr_parties_progress WHERE adj_year = p_year AND done_at IS NULL) THEN
    RAISE EXCEPTION 'year % still has unfinished windows', p_year;
  END IF;
  -- The windows must tile [0, blocks) without gaps.
  IF (SELECT min(blk_lo) FROM edrsr_parties_progress WHERE adj_year = p_year) <> 0
     OR (SELECT max(blk_hi) FROM edrsr_parties_progress WHERE adj_year = p_year) < blocks
     OR EXISTS (SELECT 1 FROM (
          SELECT blk_lo, lag(blk_hi) OVER (ORDER BY blk_lo) AS prev_hi
            FROM edrsr_parties_progress WHERE adj_year = p_year) g
         WHERE prev_hi IS NOT NULL AND prev_hi < blk_lo) THEN
    RAISE EXCEPTION 'year % windows do not cover heap blocks [0,%)', p_year, blocks;
  END IF;

  INSERT INTO edrsr_parties_coverage (adj_year, doc_count, party_count, built_at)
  SELECT p_year,
         (SELECT sum(docs) FROM edrsr_parties_progress WHERE adj_year = p_year),
         (SELECT count(*) FROM edrsr_parties WHERE adj_year = p_year),
         now()
  ON CONFLICT (adj_year) DO UPDATE
    SET doc_count = EXCLUDED.doc_count, party_count = EXCLUDED.party_count, built_at = now()
  RETURNING * INTO res;
  RETURN res;
END
$fn$;

-- ---------------------------------------------------------------------------------------
-- 5. Incremental: new and refetched decisions
-- ---------------------------------------------------------------------------------------

-- Statement-level with transition tables: one INSERT per harvest batch, not per row (the same
-- reason 216 moved the stats trigger off FOR EACH ROW). An error never fails the harvest: the
-- batch is retried row by row and a row that still raises is logged to edrsr_parties_failed.
CREATE OR REPLACE FUNCTION trg_edrsr_parties_from_fulltext()
RETURNS trigger
LANGUAGE plpgsql AS
$fn$
DECLARE
  r record;
BEGIN
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      -- Only rows whose caption actually changed (refetch of a damaged text); a tsv-only
      -- UPDATE leaves the head identical and costs two prefix reads per row, no writes.
      CREATE TEMP TABLE IF NOT EXISTS _edrsr_parties_changed (doc_id bigint, adj_year smallint) ON COMMIT DROP;
      INSERT INTO _edrsr_parties_changed
      SELECT n.doc_id, n.adj_year
        FROM new_rows n JOIN old_rows o ON o.doc_id = n.doc_id
       WHERE substr(n.full_text, 1, 3000) IS DISTINCT FROM substr(o.full_text, 1, 3000);
      DELETE FROM edrsr_parties p USING _edrsr_parties_changed c
       WHERE p.doc_id = c.doc_id AND p.adj_year = c.adj_year;
      INSERT INTO edrsr_parties
             (doc_id, role, ord, name_raw, name_norm, name_core, edrpou,
              court_code, justice_kind, adjudication_date, adj_year)
      SELECT n.doc_id, x.role, x.ord, x.name_raw, x.name_norm, x.name_core, x.edrpou,
             d.court_code, d.justice_kind, d.adjudication_date, n.adj_year
        FROM new_rows n
        JOIN _edrsr_parties_changed c ON c.doc_id = n.doc_id
        JOIN edrsr_documents d ON d.doc_id = n.doc_id AND d.justice_kind IN (1, 3, 4)
       CROSS JOIN LATERAL edrsr_extract_parties(substr(n.full_text, 1, 3000)) x
       WHERE n.adj_year IS NOT NULL
      ON CONFLICT DO NOTHING;
      TRUNCATE _edrsr_parties_changed;
    ELSE
      INSERT INTO edrsr_parties
             (doc_id, role, ord, name_raw, name_norm, name_core, edrpou,
              court_code, justice_kind, adjudication_date, adj_year)
      SELECT n.doc_id, x.role, x.ord, x.name_raw, x.name_norm, x.name_core, x.edrpou,
             d.court_code, d.justice_kind, d.adjudication_date, n.adj_year
        FROM new_rows n
        JOIN edrsr_documents d ON d.doc_id = n.doc_id AND d.justice_kind IN (1, 3, 4)
       CROSS JOIN LATERAL edrsr_extract_parties(substr(n.full_text, 1, 3000)) x
       WHERE n.adj_year IS NOT NULL
      ON CONFLICT DO NOTHING;
    END IF;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'edrsr_parties trigger: batch failed (%), retrying per row', SQLERRM;
    FOR r IN SELECT n.doc_id, n.adj_year FROM new_rows n WHERE n.adj_year IS NOT NULL LOOP
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          DELETE FROM edrsr_parties WHERE doc_id = r.doc_id AND adj_year = r.adj_year;
        END IF;
        PERFORM edrsr_parties_extract_doc(r.adj_year, r.doc_id);
      EXCEPTION WHEN others THEN
        INSERT INTO edrsr_parties_failed (doc_id, adj_year, error)
        VALUES (r.doc_id, r.adj_year, left(SQLERRM, 500))
        ON CONFLICT (doc_id) DO UPDATE SET error = EXCLUDED.error, failed_at = now();
      END;
    END LOOP;
  END;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS trg_edrsr_parties_ins ON edrsr_fulltext;
CREATE TRIGGER trg_edrsr_parties_ins
  AFTER INSERT ON edrsr_fulltext
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION trg_edrsr_parties_from_fulltext();

DROP TRIGGER IF EXISTS trg_edrsr_parties_upd ON edrsr_fulltext;
CREATE TRIGGER trg_edrsr_parties_upd
  AFTER UPDATE ON edrsr_fulltext
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION trg_edrsr_parties_from_fulltext();

COMMENT ON TABLE edrsr_parties IS
  'LEXAI-1760: plaintiff/defendant/third-party names extracted from the EDRSR claim caption (edrsr_extract_parties). role 1=позивач, 2=відповідач, 3=третя особа. Backfilled per year by edrsr_backfill_parties_range (scripts/edrsr/backfill-edrsr-parties.sh); new texts via trg_edrsr_parties_ins/upd. A year is served by the read path only once listed in edrsr_parties_coverage.';
