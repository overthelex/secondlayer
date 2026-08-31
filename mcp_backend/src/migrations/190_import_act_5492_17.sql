-- 190_import_act_5492_17.sql
--
-- Imports «Про Єдиний державний демографічний реєстр…» (nreg 5492-17) from the
-- npa corpus into public.legislation, with its editions and articles.
--
-- WHY THIS ONE ACT. legislation_citation_links.legislation_id references
-- public.legislation, which holds 651 curated acts against the corpus's
-- 293 049, so a citation naming any other act has no id to point at. That cap
-- looked like it needed a schema change — an nreg column on an 87 GB table.
-- Measuring it said otherwise:
--
--   423 478 citations name an act that is not in public.legislation
--     13 083 of them (3.09%) carry any article text at all, and resolved is
--            defined as (article_id IS NOT NULL), so only those can ever move
--     12 322 of those 13 083 (94.2%) name THIS ONE ACT
--
-- Verified directly against the citation rows rather than trusting the ratio:
-- of the 14 179 unresolved citations naming 5492, 12 299 cite an article that
-- exists in the current edition, 1 847 cite no article at all, and 33 cite one
-- that does not exist. So this single import is worth ~12 299 newly resolved
-- citations — about 95% of everything in the unresolvable set that is capable
-- of resolving at all. The schema change would have added at most 12 936.
--
-- The bindings materialise on the next run of
-- scripts/citation-graph/build-legislation-citation-links.sql, not here.
--
-- Idempotent: re-running inserts nothing new.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The act itself. Shape and conventions copied from the existing rows
--    (type 'law', the /print URL form, status from npa.act.status_code).
INSERT INTO public.legislation
  (rada_id, type, title, full_url, status, adoption_date, last_amended_date,
   total_articles, total_editions, created_at, updated_at)
SELECT a.nreg,
       'law',
       a.title,
       'https://zakon.rada.gov.ua/laws/show/' || a.nreg || '/print',
       -- npa status_code 1 and 9 are the repealed codes (NPA_REPEALED_CODES).
       CASE WHEN a.status_code IN (1, 9) THEN 'repealed' ELSE 'active' END,
       a.first_ed,
       a.last_ed,
       (SELECT count(DISTINCT art.art_no) FROM npa.article art
         WHERE art.nreg = a.nreg AND art.ed_date = (
           SELECT e.ed_date FROM npa.edition e
            WHERE e.nreg = a.nreg AND e.is_current AND e.http_status = 200 LIMIT 1)),
       a.editions_cnt,
       now(), now()
FROM npa.act a
WHERE a.nreg = '5492-17'
  AND NOT EXISTS (SELECT 1 FROM public.legislation l WHERE lower(l.rada_id) = a.nreg);

-- ---------------------------------------------------------------------------
-- 2. Editions. Only those that actually have text — an edition row with no
--    articles behind it would advertise a version the tools cannot serve.
INSERT INTO public.legislation_editions (legislation_id, edition_date, edition_key, article_count)
SELECT l.id, e.ed_date, to_char(e.ed_date, 'YYYYMMDD'),
       (SELECT count(*) FROM npa.article art WHERE art.nreg = e.nreg AND art.ed_date = e.ed_date)
FROM npa.edition e
JOIN public.legislation l ON lower(l.rada_id) = e.nreg
WHERE e.nreg = '5492-17'
  AND e.http_status = 200
  AND EXISTS (SELECT 1 FROM npa.article art WHERE art.nreg = e.nreg AND art.ed_date = e.ed_date)
ON CONFLICT (legislation_id, edition_date) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Articles, every edition. npa.article is keyed (nreg, ed_date, art_no) and
--    legislation_articles is UNIQUE (legislation_id, article_number,
--    version_date), so ed_date maps straight onto version_date.
--
--    is_current is taken from the edition rather than assumed: best_art in the
--    citation builder orders by is_current DESC, so getting this wrong would
--    point every citation at a historical version of the article.
INSERT INTO public.legislation_articles
  (legislation_id, article_number, title, full_text, version_date, is_current,
   byte_size, created_at, updated_at)
SELECT l.id,
       art.art_no,
       NULLIF(btrim(split_part(art.title || '', E'\n', 1)), ''),
       art.body || '',
       art.ed_date,
       e.is_current,
       -- octet_length, not length: the column stores BYTES, and every one of
       -- the 25 213 existing rows sampled matches octet_length while ZERO match
       -- the character count. Cyrillic is 2 bytes per character, so length()
       -- would have halved it and made this act the only inconsistent one.
       octet_length(art.body),
       now(), now()
FROM npa.article art
JOIN npa.edition e ON e.nreg = art.nreg AND e.ed_date = art.ed_date
JOIN public.legislation l ON lower(l.rada_id) = art.nreg
WHERE art.nreg = '5492-17'
ON CONFLICT (legislation_id, article_number, version_date) DO NOTHING;

COMMIT;

ANALYZE public.legislation_articles;
