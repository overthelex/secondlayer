-- 258_import_kupap_8073_10.sql
--
-- КУпАП: load the in-force code (nreg 8073-10) into public.legislation from the
-- npa corpus, with its editions and articles from 07.05.2017 on.
--
-- WHY. public.legislation held КУпАП only as the two documents Rada split it
-- into, 80731-10 (ст. 1–212-21) and 80732-10 (ст. 213–330). On 07.05.2017 Rada
-- froze both halves, retitled them «редакції до 07.05.2017», and has published
-- every edition since under the single nreg 8073-10. Nothing in the public
-- tables followed, and the aliases («КУпАП», the full name) kept pointing at
-- the halves. So on 10.11.2026 get_legislation_section("ст. 283 КУпАП") returned
-- the 2017-05-07 text with act_status «Чинний» and no warning — the last
-- Редакція of the real code is 2025-09-01 (plus a КСУ event on 2025-12-11),
-- 119 editions later. The code side of the fix is in the same change:
-- KUPAP_RADA_ID = '8073-10' in legislation-service.ts.
--
-- WHY FROM 07.05.2017. npa.edition has all 423 editions of 8073-10 back to
-- 1984 (318 484 article rows, 686 MB). Everything before 07.05.2017 is already
-- served by the halves, so only the 119 editions from that date on are copied
-- (82 580 rows). The halves keep their rows and their ids: the citation graph
-- (scripts/citation-graph/*.sql, lawmap 653/22) and explicit rada_id callers
-- still reach them, and an as_of_date before 2017 on a half still resolves.
--
-- Shape copied from 190_import_act_5492_17.sql; the «Стаття N.» prefix is
-- stripped at insert time the way 192 did it afterwards, so full_text and
-- title follow the table's convention (text without the heading, title = the
-- heading's first line).
--
-- Idempotent: the NOT EXISTS guard and ON CONFLICT DO NOTHING make a re-run a
-- no-op. Skips cleanly where the npa schema is absent (local without the corpus).

DO $$
DECLARE
  inserted_count INTEGER;
BEGIN
  IF to_regclass('npa.article') IS NULL THEN
    RAISE NOTICE '258: npa.article absent, skipping КУпАП import';
    RETURN;
  END IF;

  -- 1. The act. type 'code' like the other codes in the table.
  INSERT INTO public.legislation
    (rada_id, type, title, short_title, full_url, status, adoption_date, last_amended_date,
     total_articles, total_editions, created_at, updated_at)
  SELECT a.nreg,
         'code',
         a.title,
         'КУпАП',
         'https://zakon.rada.gov.ua/laws/show/' || a.nreg || '/print',
         CASE WHEN a.status_code IN (1, 9) THEN 'repealed' ELSE 'active' END,
         a.first_ed,
         a.last_ed,
         (SELECT count(DISTINCT art.art_no) FROM npa.article art
           WHERE art.nreg = a.nreg AND art.ed_date = (
             SELECT e.ed_date FROM npa.edition e
              WHERE e.nreg = a.nreg AND e.is_current AND e.http_status = 200 LIMIT 1)),
         (SELECT count(*) FROM npa.edition e
           WHERE e.nreg = a.nreg AND e.http_status = 200 AND e.ed_date >= DATE '2017-05-07'),
         now(), now()
  FROM npa.act a
  WHERE a.nreg = '8073-10'
    AND NOT EXISTS (SELECT 1 FROM public.legislation l WHERE lower(l.rada_id) = a.nreg);

  -- 2. Editions from the split date on, only those with text behind them.
  INSERT INTO public.legislation_editions (legislation_id, edition_date, edition_key, article_count)
  SELECT l.id, e.ed_date, to_char(e.ed_date, 'YYYYMMDD'),
         (SELECT count(*) FROM npa.article art WHERE art.nreg = e.nreg AND art.ed_date = e.ed_date)
  FROM npa.edition e
  JOIN public.legislation l ON lower(l.rada_id) = e.nreg
  WHERE e.nreg = '8073-10'
    AND e.http_status = 200
    AND e.ed_date >= DATE '2017-05-07'
    AND EXISTS (SELECT 1 FROM npa.article art WHERE art.nreg = e.nreg AND art.ed_date = e.ed_date)
  ON CONFLICT (legislation_id, edition_date) DO NOTHING;

  -- 3. Articles of those editions. ed_date maps onto version_date; is_current
  --    comes from the edition so exactly one edition is current.
  WITH src AS (
    SELECT l.id AS legislation_id,
           art.art_no,
           art.ed_date,
           e.is_current,
           regexp_replace(art.body || '', '^\s*Стаття\s+[0-9]+(\s*[-–—]\s*[0-9]+)?\s*\.?\s*', '') AS stripped
    FROM npa.article art
    JOIN npa.edition e ON e.nreg = art.nreg AND e.ed_date = art.ed_date
    JOIN public.legislation l ON lower(l.rada_id) = art.nreg
    WHERE art.nreg = '8073-10'
      AND art.ed_date >= DATE '2017-05-07'
  )
  INSERT INTO public.legislation_articles
    (legislation_id, article_number, title, full_text, version_date, is_current,
     byte_size, metadata, created_at, updated_at)
  SELECT legislation_id,
         art_no,
         CASE WHEN length(split_part(stripped, chr(10), 1)) <= 200
              THEN nullif(btrim(split_part(stripped, chr(10), 1)), '') END,
         stripped,
         ed_date,
         is_current,
         octet_length(stripped),
         jsonb_build_object('source', 'npa.article', 'edition_date', to_char(ed_date, 'YYYYMMDD'),
                            'extraction_method', 'npa_article'),
         now(), now()
  FROM src
  ON CONFLICT (legislation_id, article_number, version_date) DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RAISE NOTICE '258: inserted % КУпАП (8073-10) article rows', inserted_count;
END $$;

ANALYZE public.legislation_articles;
