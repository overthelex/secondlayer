-- LEXAI-1957: in-force articles whose number carries an index were unreachable.
--
-- get_legislation_section with an explicit number goes to PG, and the adapter
-- filters `la.is_current = true`. Measured on prod 2026-08-18, counting only
-- articles present in the CURRENT edition per npa.article (max ed_date), for
-- acts in public.legislation:
--
--   indexed («350-1»): 1 707 in force, 541 reachable — 1 166 missing (68.3%)
--   plain   («350»)  : 15 982 in force, 15 472 reachable — 510 missing (3.2%)
--
-- Of the 1 166, only 148 had a row that merely lacked the flag; 1 018 had no row
-- at all. So this is not a flag backfill — the rows were never written.
--
-- Root cause: Rada writes the index with spaces around the hyphen — the stored
-- ЦПК heading is «Стаття 350 - 1 .». import-historical-editions.ts matched
-- `(\d+(?:-\d+)?)`, which allows none, so it captured «350», collided with the
-- real article 350 and lost the row to ON CONFLICT DO NOTHING. That is why every
-- ЦПК edition from 2004 to 2028 held exactly 500 articles and not one indexed,
-- against 525 in npa.article. The importer now builds its regexes from
-- ARTICLE_NUMBER_PATTERN, so new imports keep the index.
--
-- This migration repairs what is already stored. npa.article is the source of
-- truth: 2 208 156 rows, verified against the raw text one for one. Missing
-- articles are attached to each act's OWN current snapshot date, so an act keeps
-- exactly one current edition rather than gaining a second.
--
-- Idempotent: the NOT EXISTS guard and ON CONFLICT DO NOTHING make a re-run a
-- no-op. Skips cleanly where the npa schema is absent (local without the corpus).

DO $$
DECLARE
  inserted_count INTEGER;
BEGIN
  IF to_regclass('npa.article') IS NULL THEN
    RAISE NOTICE 'LEXAI-1957: npa.article absent, skipping';
    RETURN;
  END IF;

  WITH snap AS (        -- each act's own current snapshot date
    SELECT l.id AS legislation_id, lower(l.rada_id) AS nreg, max(la.version_date) AS vd
    FROM legislation l
    JOIN legislation_articles la ON la.legislation_id = l.id AND la.is_current
    GROUP BY 1, 2
  ), ed AS (            -- the in-force edition in the clean corpus
    SELECT nreg, max(ed_date) AS ed FROM npa.article GROUP BY 1
  ), plan AS (
    SELECT s.legislation_id, s.vd, a.art_no, a.title, a.body
    FROM snap s
    JOIN ed e ON e.nreg = s.nreg
    JOIN npa.article a ON a.nreg = s.nreg AND a.ed_date = e.ed
    WHERE NOT EXISTS (
      SELECT 1 FROM legislation_articles x
      WHERE x.legislation_id = s.legislation_id
        AND x.article_number = a.art_no
        AND x.is_current
    )
  )
  INSERT INTO legislation_articles
    (legislation_id, article_number, title, full_text, byte_size, is_current, version_date, metadata)
  SELECT legislation_id, art_no, nullif(btrim(coalesce(title, '')), ''), body,
         octet_length(body), true, vd,
         jsonb_build_object('source', 'npa.article', 'task', 'LEXAI-1957')
  FROM plan
  ON CONFLICT (legislation_id, article_number, version_date) DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RAISE NOTICE 'LEXAI-1957: inserted % in-force articles', inserted_count;

  -- Match the table's own convention: existing rows do not repeat the heading in
  -- full_text (only 3.9% do), and title is a short line, not a paragraph. Taking
  -- npa's body verbatim left «Стаття 350 - 1 .» in the text and a 284-character
  -- "title", which surfaced in the MCP payload as a truncated sentence.
  UPDATE legislation_articles la
  SET full_text  = s.stripped,
      byte_size  = octet_length(s.stripped),
      title      = nullif(btrim(s.first_line), ''),
      updated_at = now()
  FROM (
    SELECT id,
           regexp_replace(full_text, '^\s*Стаття\s+[0-9]+(\s*[-–—]\s*[0-9]+)?\s*\.?\s*', '') AS stripped,
           CASE
             WHEN length(split_part(regexp_replace(full_text, '^\s*Стаття\s+[0-9]+(\s*[-–—]\s*[0-9]+)?\s*\.?\s*', ''), chr(10), 1)) <= 200
             THEN split_part(regexp_replace(full_text, '^\s*Стаття\s+[0-9]+(\s*[-–—]\s*[0-9]+)?\s*\.?\s*', ''), chr(10), 1)
           END AS first_line
    FROM legislation_articles
    WHERE metadata->>'task' = 'LEXAI-1957'
      AND full_text ~ '^\s*Стаття\s'
  ) s
  WHERE la.id = s.id;
END $$;
