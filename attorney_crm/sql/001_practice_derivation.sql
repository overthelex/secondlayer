-- attorney_crm: derive each advocate's practice profile from ЄДРСР.
--
-- Court decisions name the advocates who took part («за участю адвоката Макеєва
-- Дмитра Вячеславовича»). This file turns those mentions into one row per
-- (advocate, court case) with the proceeding kind and case category, so the CRM can
-- show «Кримінальне: 120 справ, 2024–2026» next to a name. Everything here is
-- idempotent and lives in the prod database (secondlayer_local on cthulhu).
--
-- The work is done in SQL on purpose: the regex and the stem match were measured
-- here first (0.55 s per 3,000 decisions, 90% unique match), and keeping the logic
-- in one function lets the one-off backfill (scripts/attorney-crm/derive-practices.sh)
-- and the service's daily worker run exactly the same code.
--
-- Design: docs/superpowers/specs/2026-11-07-attorney-crm-design.md

-- ── Fact table: one row per advocate per court case ────────────────────────────
-- A case (cause_num) produces many decisions (ухвали, рішення); the number the
-- manager sees is distinct cases. `decisions` is kept only as evidence.
CREATE TABLE IF NOT EXISTS attorney_crm_practice_cases (
  advocate_source_id TEXT     NOT NULL,
  cause_num          TEXT     NOT NULL,
  justice_kind       SMALLINT,
  category_code      INTEGER,
  decisions          INTEGER  NOT NULL DEFAULT 1,
  first_year         SMALLINT,
  last_year          SMALLINT,
  PRIMARY KEY (advocate_source_id, cause_num)
);
CREATE INDEX IF NOT EXISTS idx_attorney_crm_practice_cases_kind
  ON attorney_crm_practice_cases (justice_kind, advocate_source_id);

-- ── Resumable cursor, one row per ЄДРСР partition year ─────────────────────────
-- walk_mode, fixed when the year's row is created and never changed:
--   'doc_id'   — a closed year (its end is older than the lag): every text that
--                will ever arrive is old enough, so the walk is a plain doc_id scan,
--                which reads edrsr_fulltext in storage order (2.3× faster, measured).
--   'adj_date' — the open year: ordered by (adjudication_date, doc_id). doc_ids are
--                assigned at publication and ЄДРСР publishes late, so a doc_id
--                cursor combined with the lag filter would skip every promptly
--                published decision for good; the date order resumes from
--                last_adj_at up to now − lag on every daily run.
CREATE TABLE IF NOT EXISTS attorney_crm_practice_progress (
  partition_year SMALLINT    PRIMARY KEY,
  walk_mode      TEXT        CHECK (walk_mode IN ('doc_id', 'adj_date')),
  last_adj_at    TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
  last_doc_id    BIGINT      NOT NULL DEFAULT 0,
  docs_scanned   BIGINT      NOT NULL DEFAULT 0,
  docs_with_text BIGINT      NOT NULL DEFAULT 0,
  hits           BIGINT      NOT NULL DEFAULT 0,
  done           BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE attorney_crm_practice_progress ADD COLUMN IF NOT EXISTS last_adj_at TIMESTAMPTZ NOT NULL DEFAULT '-infinity';
ALTER TABLE attorney_crm_practice_progress ADD COLUMN IF NOT EXISTS walk_mode TEXT CHECK (walk_mode IN ('doc_id', 'adj_date'));

-- ── Registry snapshot for matching ─────────────────────────────────────────────
-- Names in decisions are declined («Макеєва Дмитра Вячеславовича»), registry names
-- are nominative. We match by prefix: the registry name must start with the text
-- form minus its ending (surname −2, first name −2, patronymic −3 letters).
-- text_pattern_ops makes those LIKE 'prefix%' lookups index scans.
-- The snapshot is rebuilt at the start of every run so a registry re-import
-- (opendata_advocates is replaced wholesale) can never empty a batch mid-run.
CREATE TABLE IF NOT EXISTS attorney_crm_advocate_stems (
  source_id TEXT PRIMARY KEY,
  fam_l     TEXT NOT NULL,
  name_l    TEXT NOT NULL,
  pat_l     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attorney_crm_stems_fam  ON attorney_crm_advocate_stems (fam_l text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_attorney_crm_stems_name ON attorney_crm_advocate_stems (name_l text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_attorney_crm_stems_pat  ON attorney_crm_advocate_stems (pat_l text_pattern_ops);

CREATE OR REPLACE FUNCTION attorney_crm_refresh_stems() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  TRUNCATE attorney_crm_advocate_stems;
  INSERT INTO attorney_crm_advocate_stems (source_id, fam_l, name_l, pat_l)
  SELECT source_id, lower(trim(family_name)), lower(trim(name)), lower(trim(additional_name))
  FROM opendata_advocates
  WHERE source_id IS NOT NULL AND source_id <> ''
    AND coalesce(family_name,'') <> '' AND coalesce(name,'') <> '' AND coalesce(additional_name,'') <> ''
  ON CONFLICT (source_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  ANALYZE attorney_crm_advocate_stems;
  RETURN n;
END $$;

-- ── One batch of the derivation ────────────────────────────────────────────────
-- Walks edrsr_documents of one partition year in walk_mode order (see above),
-- starting after the stored cursor, at most p_limit documents, stopping p_lag_days
-- short of now (full texts arrive late; see the design). The open year is never
-- marked done: each run resumes from the cursor and scans whatever became old enough. Joins the full text,
-- extracts «адвокат(а|ом|…) Прізвище Ім'я По батькові», keeps only names that match
-- exactly one registry row, and upserts (advocate, cause_num). Cursor advance and
-- upsert are one transaction (the function body), so a restart resumes cleanly.
-- Returns (documents scanned, documents with text, upserted rows, cursor);
-- out_docs = 0 means this year is exhausted. OUT columns carry an out_ prefix so
-- they never shadow the progress table's columns inside plpgsql.
-- OUT column names are part of the signature: renaming one later needs a DROP first
-- (do it by hand, outside a running backfill), CREATE OR REPLACE alone will refuse.
CREATE OR REPLACE FUNCTION attorney_crm_derive_batch(
  p_year     INTEGER,
  p_limit    INTEGER DEFAULT 2000,
  p_lag_days INTEGER DEFAULT 30
) RETURNS TABLE (out_docs INTEGER, out_with_text INTEGER, out_hits INTEGER, out_last_doc_id BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
  v_after    BIGINT;
  v_after_at TIMESTAMPTZ;
  v_mode     TEXT;
  v_year_end TIMESTAMPTZ := make_timestamptz(p_year + 1, 1, 1, 0, 0, 0, 'Europe/Kyiv');
  v_from   TIMESTAMPTZ := make_timestamptz(p_year, 1, 1, 0, 0, 0, 'Europe/Kyiv');
  v_to     TIMESTAMPTZ := LEAST(make_timestamptz(p_year + 1, 1, 1, 0, 0, 0, 'Europe/Kyiv'),
                                NOW() - make_interval(days => p_lag_days));
  v_docs   INTEGER := 0;
  v_text   INTEGER := 0;
  v_hits   INTEGER := 0;
  v_last   BIGINT;
  v_last_at TIMESTAMPTZ;
BEGIN
  INSERT INTO attorney_crm_practice_progress (partition_year) VALUES (p_year)
  ON CONFLICT (partition_year) DO NOTHING;
  SELECT pr.last_doc_id, pr.last_adj_at, pr.walk_mode INTO v_after, v_after_at, v_mode
    FROM attorney_crm_practice_progress pr WHERE pr.partition_year = p_year FOR UPDATE;
  IF v_mode IS NULL THEN
    v_mode := CASE WHEN v_year_end <= NOW() - make_interval(days => p_lag_days) THEN 'doc_id' ELSE 'adj_date' END;
    UPDATE attorney_crm_practice_progress SET walk_mode = v_mode WHERE partition_year = p_year;
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _acrm_batch (
    doc_id BIGINT, justice_kind SMALLINT, category_code INTEGER, cause_num TEXT, yr SMALLINT, adj_at TIMESTAMPTZ
  ) ON COMMIT DROP;
  TRUNCATE _acrm_batch;

  IF v_mode = 'doc_id' THEN
    INSERT INTO _acrm_batch
    SELECT d.doc_id, d.justice_kind, d.category_code, d.cause_num,
           extract(year FROM d.adjudication_date AT TIME ZONE 'Europe/Kyiv')::smallint, d.adjudication_date
    FROM edrsr_documents d
    WHERE d.adjudication_date >= v_from AND d.adjudication_date < v_to
      AND d.doc_id > v_after
    ORDER BY d.doc_id
    LIMIT p_limit;
  ELSE
    INSERT INTO _acrm_batch
    SELECT d.doc_id, d.justice_kind, d.category_code, d.cause_num,
           extract(year FROM d.adjudication_date AT TIME ZONE 'Europe/Kyiv')::smallint, d.adjudication_date
    FROM edrsr_documents d
    WHERE d.adjudication_date >= v_from AND d.adjudication_date < v_to
      AND (d.adjudication_date, d.doc_id) > (v_after_at, v_after)
    ORDER BY d.adjudication_date, d.doc_id
    LIMIT p_limit;
  END IF;

  SELECT count(*) INTO v_docs FROM _acrm_batch;
  IF v_docs = 0 THEN
    -- A closed year is exhausted for good; the open year just has nothing old enough yet.
    UPDATE attorney_crm_practice_progress
       SET done = (v_to < NOW() - make_interval(days => p_lag_days)), updated_at = NOW()
     WHERE partition_year = p_year;
    RETURN QUERY SELECT 0, 0, 0, v_after;
    RETURN;
  END IF;
  IF v_mode = 'doc_id' THEN
    SELECT max(doc_id), max(adj_at) INTO v_last, v_last_at FROM _acrm_batch;
  ELSE
    SELECT adj_at, doc_id INTO v_last_at, v_last FROM _acrm_batch ORDER BY adj_at DESC, doc_id DESC LIMIT 1;
  END IF;

  WITH texts AS (
    SELECT b.doc_id, b.justice_kind, b.category_code, b.cause_num, b.yr, f.full_text
    FROM _acrm_batch b
    JOIN edrsr_fulltext f ON f.doc_id = b.doc_id AND f.adj_year = p_year
    WHERE b.cause_num IS NOT NULL AND b.cause_num <> ''
  ),
  counted AS (SELECT count(*) AS n FROM texts),
  mentions AS (
    SELECT t.doc_id, t.justice_kind, t.category_code, t.cause_num, t.yr,
           lower(g[1]) AS sur, lower(g[2]) AS fn, lower(g[3]) AS pn
    FROM texts t,
         regexp_matches(t.full_text,
           '[Аа]двокат(?:а|ом|у|ові|ів|ка|ки|кою|ці)?\s+([А-ЯІЇЄҐ][а-яіїєґ''’-]+)\s+([А-ЯІЇЄҐ][а-яіїєґ''’-]+)\s+([А-ЯІЇЄҐ][а-яіїєґ''’-]+)',
           'g') AS g
  ),
  matched AS (
    SELECT m.*, s.ids[1] AS source_id
    FROM mentions m
    CROSS JOIN LATERAL (
      SELECT array_agg(source_id) AS ids FROM (
        SELECT source_id FROM attorney_crm_advocate_stems st
        WHERE st.fam_l  LIKE left(m.sur, greatest(length(m.sur) - 2, 3)) || '%'
          AND st.name_l LIKE left(m.fn,  greatest(length(m.fn)  - 2, 3)) || '%'
          AND st.pat_l  LIKE left(m.pn,  greatest(length(m.pn)  - 3, 4)) || '%'
        LIMIT 2
      ) two
    ) s
    WHERE cardinality(s.ids) = 1
  ),
  upserted AS (
    INSERT INTO attorney_crm_practice_cases AS c
      (advocate_source_id, cause_num, justice_kind, category_code, decisions, first_year, last_year)
    SELECT source_id, cause_num, min(justice_kind), min(category_code),
           count(DISTINCT doc_id), min(yr), max(yr)
    FROM matched
    GROUP BY source_id, cause_num
    ON CONFLICT (advocate_source_id, cause_num) DO UPDATE SET
      decisions  = c.decisions + EXCLUDED.decisions,
      first_year = LEAST(c.first_year, EXCLUDED.first_year),
      last_year  = GREATEST(c.last_year, EXCLUDED.last_year),
      justice_kind  = COALESCE(c.justice_kind, EXCLUDED.justice_kind),
      category_code = COALESCE(c.category_code, EXCLUDED.category_code)
    RETURNING 1
  )
  SELECT (SELECT n FROM counted), (SELECT count(*) FROM upserted) INTO v_text, v_hits;

  UPDATE attorney_crm_practice_progress
  SET last_doc_id = v_last, last_adj_at = v_last_at, docs_scanned = docs_scanned + v_docs,
      docs_with_text = docs_with_text + v_text, hits = hits + v_hits,
      updated_at = NOW()
  WHERE partition_year = p_year;

  RETURN QUERY SELECT v_docs, v_text, v_hits, v_last;
END $$;

-- ── What the CRM reads ─────────────────────────────────────────────────────────
-- Distinct cases per advocate per proceeding kind and category, with the years.
-- Created WITH DATA (empty and instant on a fresh database) so queries never hit an
-- unpopulated view; REFRESH ... CONCURRENTLY needs the unique index below.
CREATE MATERIALIZED VIEW IF NOT EXISTS attorney_crm_practice_stats AS
SELECT advocate_source_id, justice_kind, category_code,
       count(*)::integer AS cases,
       min(first_year)   AS first_year,
       max(last_year)    AS last_year
FROM attorney_crm_practice_cases
GROUP BY advocate_source_id, justice_kind, category_code
WITH DATA;
CREATE UNIQUE INDEX IF NOT EXISTS idx_attorney_crm_practice_stats_pk
  ON attorney_crm_practice_stats (advocate_source_id, justice_kind, category_code);
CREATE INDEX IF NOT EXISTS idx_attorney_crm_practice_stats_kind
  ON attorney_crm_practice_stats (justice_kind, cases DESC);
