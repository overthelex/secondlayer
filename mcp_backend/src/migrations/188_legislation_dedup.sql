-- 188_legislation_dedup.sql
--
-- public.legislation held the same act twice: once under its Rada registry id
-- and once under its OFFICIAL number, which does not belong in that column.
-- The duplicates could not join to npa.act at all, and one of each pair was
-- the Constitution and the Criminal Procedure Code.
--
-- This is a MERGE, not an UPDATE. legislation_rada_id_key is unique but
-- CASE-SENSITIVE, which is exactly how «254к/96-ВР» and «254к/96-вр» both got
-- in, so rewriting the id in place would collide. Every dependent table also
-- cascades on delete, so anything unique to the losing row has to be carried
-- across BEFORE the delete.
--
-- Measured before writing this (see the PR for the queries):
--   legislation_citation_links points ONLY at the winners -- 44 294 721 rows
--   at 654 (КПК), 5 763 527 at 660 (Конституція), 777 at 285 -- and never at
--   a duplicate. So the citation graph already uses the surviving ids.
--
--   pair                     winner  loser   what is unique to the loser
--   254к/96-ВР / 254к/96-вр  660     809     15 «п.N» перехідні положення
--   4651-vi    / 4651-17     654     294     2 editions + their 1 230 articles
--   5073-VI    / 5073-17     285     286     nothing
--   4173-IX    / 4173-20     687     678     2 chunk texts, 100 vector ids
--   2389-VIII                636     --      no twin; wrong id, rewrite only

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Adopt legislation_article_amendments into the tracked schema.
--
--    It was created only by scripts/rada/*amend-metric.py, so a database built
--    from migrations alone never had it -- while getArticleAmendments queries
--    it unconditionally. That is a live gap, not something this migration
--    introduces, and guarding around it would only hide it.
--
--    The shape here matches PROD, not the script. The script declares a plain
--    UNIQUE (legislation_id, article_number, change_type, basis_act,
--    note_text); prod instead carries the expression index below, which hashes
--    note_text (a TEXT column that will not fit a btree key) and folds NULL
--    onto ''. All IF NOT EXISTS, so prod is untouched.
CREATE TABLE IF NOT EXISTS public.legislation_article_amendments (
  id             SERIAL PRIMARY KEY,
  legislation_id INTEGER NOT NULL REFERENCES public.legislation(id) ON DELETE CASCADE,
  rada_id        VARCHAR(100) NOT NULL,
  article_number VARCHAR(50)  NOT NULL,
  change_type    VARCHAR(20)  NOT NULL CHECK (change_type IN ('added','modified','removed')),
  basis_act      VARCHAR(50),
  act_date       DATE,
  note_text      TEXT,
  source_edition DATE,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_law_art_amend
  ON public.legislation_article_amendments (legislation_id, article_number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_law_art_amend
  ON public.legislation_article_amendments
     (legislation_id, article_number, change_type, basis_act, md5(coalesce(note_text, '')));

-- ---------------------------------------------------------------------------
-- 1. Конституція: 809 -> 660.
--
-- 660 carries the real 9-edition history (1996-06-28 … 2019-02-21) and all
-- 5.7M citations. 809 is a single low-quality snapshot stamped
-- 2000-01-01 02:00 and flagged is_current, so porting it wholesale would
-- inject a bogus "current" edition of the Constitution. Only its 15 «п.N»
-- перехідні положення are genuinely absent from 660, and they belong to the
-- text in force, so they attach to 660's current edition instead of to that
-- placeholder date.
INSERT INTO public.legislation_articles
  (legislation_id, article_number, section_number, chapter_number, title,
   full_text, full_text_html, part_number, paragraph_number, notes,
   version_date, byte_size, is_current, metadata, created_at, updated_at,
   section_title, chapter_title)
SELECT 660, a.article_number, a.section_number, a.chapter_number, a.title,
       a.full_text, a.full_text_html, a.part_number, a.paragraph_number, a.notes,
       TIMESTAMP '2019-02-21 00:00:00', a.byte_size, true, a.metadata,
       now(), now(), a.section_title, a.chapter_title
FROM public.legislation_articles a
WHERE a.legislation_id = 809
  AND a.article_number LIKE 'п.%'
ON CONFLICT (legislation_id, article_number, version_date) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. КПК: 294 -> 654.
--
-- 294's article NUMBERS are a strict subset of 654's, which is why an
-- earlier reading called it redundant -- but at (number, version_date) it
-- holds 1 230 rows for two editions, 2015-06-04 and 2016-05-12, that 654 has
-- nothing for. Both slot into 654's existing date sequence and are historical
-- (is_current = false). Deleting 294 as "a subset" would have dropped them.
INSERT INTO public.legislation_editions (legislation_id, edition_date, edition_key, article_count, metadata)
SELECT 654, e.edition_date, e.edition_key, e.article_count, e.metadata
FROM public.legislation_editions e
WHERE e.legislation_id = 294
  AND e.edition_date IN (DATE '2015-06-04', DATE '2016-05-12')
ON CONFLICT (legislation_id, edition_date) DO NOTHING;

INSERT INTO public.legislation_articles
  (legislation_id, article_number, section_number, chapter_number, title,
   full_text, full_text_html, part_number, paragraph_number, notes,
   version_date, byte_size, is_current, metadata, created_at, updated_at,
   section_title, chapter_title)
SELECT 654, a.article_number, a.section_number, a.chapter_number, a.title,
       a.full_text, a.full_text_html, a.part_number, a.paragraph_number, a.notes,
       a.version_date, a.byte_size, false, a.metadata, now(), now(),
       a.section_title, a.chapter_title
FROM public.legislation_articles a
WHERE a.legislation_id = 294
  AND a.version_date::date IN (DATE '2015-06-04', DATE '2016-05-12')
ON CONFLICT (legislation_id, article_number, version_date) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Amendments unique to a loser (2 for the Constitution pair, 0 for КПК).
--
--    Deduplicated with a NULL-safe NOT EXISTS whose key matches the real
--    unique index, uq_law_art_amend on (legislation_id, article_number,
--    change_type, basis_act, md5(coalesce(note_text,''))). Two notes, both
--    learned the hard way here:
--
--    * The key must match that index EXACTLY. Adding act_date and
--      source_edition looks safer and is not -- it lets through rows the index
--      still rejects, and the insert aborts the whole migration.
--    * note_text is compared with coalesce, not IS NOT DISTINCT FROM, because
--      the index hashes coalesce(note_text,'') and so treats NULL and '' as
--      the SAME row. IS NOT DISTINCT FROM treats them as different, which
--      would let such a pair past the check and straight into a unique
--      violation. The other columns keep IS NOT DISTINCT FROM: there it is
--      STRICTER than the index (which counts NULLs as distinct), and erring
--      strict can only skip a row, never abort the run.
--    * ON CONFLICT is not used: it would take the index's NULL semantics
--      wholesale and silently loosen dedup for rows with a NULL basis_act.
INSERT INTO public.legislation_article_amendments
    (legislation_id, rada_id, article_number, change_type, basis_act, act_date,
     note_text, source_edition, created_at)
  SELECT w.win, wl.rada_id, l.article_number, l.change_type, l.basis_act, l.act_date,
         l.note_text, l.source_edition, now()
  FROM public.legislation_article_amendments l
  JOIN (VALUES (809, 660), (294, 654), (286, 285), (678, 687)) AS w(lose, win)
    ON w.lose = l.legislation_id
  JOIN public.legislation wl ON wl.id = w.win
  WHERE NOT EXISTS (
    SELECT 1 FROM public.legislation_article_amendments k
     WHERE k.legislation_id = w.win
       AND k.article_number IS NOT DISTINCT FROM l.article_number
       AND k.change_type    IS NOT DISTINCT FROM l.change_type
       AND k.basis_act      IS NOT DISTINCT FROM l.basis_act
       AND coalesce(k.note_text, '') = coalesce(l.note_text, '')
);

-- ---------------------------------------------------------------------------
-- 4. Chunks are a write-only mirror of the vector store, one row per Qdrant
--    point. The 4173 pair has DISJOINT vector ids (0 shared of 100 each), so
--    letting them cascade away would leave 100 points in Qdrant with no row
--    describing them.
--
--    Repointing legislation_id alone is NOT enough, and quietly does nothing:
--    legislation_chunks.article_id references legislation_articles(id) ON
--    DELETE CASCADE, and all 100 chunks hang off the loser's 15 article rows.
--    Deleting the loser cascades those articles, which cascades the chunks --
--    after the repoint had already "moved" them. Measured: 687 ended at 100
--    rows instead of 200 while every statement reported success.
--
--    Carrying them over is impossible, though: legislation_chunks is UNIQUE on
--    (article_id, chunk_index), and the two rows are parallel chunkings of the
--    SAME 15 articles, so every (article, index) slot in the winner is already
--    taken. 98 of the 100 texts are byte-identical to the winner's anyway.
--
--    So the mirror rows go, and the vector ids are recorded rather than
--    leaked: the points stay in Qdrant until something deletes them, and an
--    undocumented orphan is how a "successful" migration quietly degrades
--    search -- those points duplicate the winner's own chunks in every result.
CREATE TABLE IF NOT EXISTS public.legislation_orphaned_vectors (
  vector_id      text PRIMARY KEY,
  legislation_id integer NOT NULL,
  rada_id        text,
  reason         text    NOT NULL,
  noted_at       timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.legislation_orphaned_vectors (vector_id, legislation_id, rada_id, reason)
SELECT c.vector_id, c.legislation_id, l.rada_id,
       'duplicate legislation row merged by migration 188; delete from Qdrant'
FROM public.legislation_chunks c
JOIN public.legislation l ON l.id = c.legislation_id
WHERE c.legislation_id IN (809, 294, 286, 678)
  AND c.vector_id IS NOT NULL
ON CONFLICT (vector_id) DO NOTHING;

UPDATE public.legislation_changes c
   SET legislation_id = w.win,
       rada_id        = wl.rada_id
  FROM (VALUES (809, 660), (294, 654), (286, 285), (678, 687)) AS w(lose, win)
  JOIN public.legislation wl ON wl.id = w.win
 WHERE c.legislation_id = w.lose;

-- A user subscribed to BOTH rows of a pair would break the repoint:
-- legislation_subscriptions is UNIQUE(user_id, legislation_id), so moving the
-- loser onto the winner would raise and abort the whole migration. Drop the
-- redundant loser subscription first. (Zero rows today on every id involved;
-- kept so the migration is safe against a different snapshot.)
DELETE FROM public.legislation_subscriptions s
 USING (VALUES (809, 660), (294, 654), (286, 285), (678, 687)) AS w(lose, win)
 WHERE s.legislation_id = w.lose
   AND EXISTS (SELECT 1 FROM public.legislation_subscriptions k
                WHERE k.user_id = s.user_id AND k.legislation_id = w.win);

UPDATE public.legislation_subscriptions s
   SET legislation_id = w.win
  FROM (VALUES (809, 660), (294, 654), (286, 285), (678, 687)) AS w(lose, win)
 WHERE s.legislation_id = w.lose;

-- legislation_citation_links has no foreign key, so nothing would have
-- stopped it dangling. Measured as already pointing only at winners; this
-- repoint is a no-op that keeps the migration correct if that ever changes.
UPDATE public.legislation_citation_links c
   SET legislation_id = w.win
  FROM (VALUES (809, 660), (294, 654), (286, 285), (678, 687)) AS w(lose, win)
 WHERE c.legislation_id = w.lose;

-- ---------------------------------------------------------------------------
-- 5. Drop the losers. The remaining dependents cascade.
DELETE FROM public.legislation WHERE id IN (809, 294, 286, 678);

-- ---------------------------------------------------------------------------
-- 6. Put the surviving rows on their canonical registry id.
--    636 «2389-VIII» has no twin and no dependents: per npa.act it is a
--    Постанова ВР (types_raw = 2), not a law, and its nreg is 2389-19.
UPDATE public.legislation SET rada_id = '254к/96-вр', updated_at = now() WHERE id = 660;
UPDATE public.legislation SET rada_id = '2389-19',    updated_at = now() WHERE id = 636;

-- Child tables denormalize rada_id, so the two renames above leave stale
-- copies behind -- and getChangesForLegislation filters on that column, so a
-- stale value silently hides those rows from a canonical-id request.
UPDATE public.legislation_article_amendments a
   SET rada_id = l.rada_id
  FROM public.legislation l
 WHERE a.legislation_id = l.id AND a.legislation_id IN (660, 636)
   AND a.rada_id IS DISTINCT FROM l.rada_id;

UPDATE public.legislation_changes c
   SET rada_id = l.rada_id
  FROM public.legislation l
 WHERE c.legislation_id = l.id AND c.legislation_id IN (660, 636)
   AND c.rada_id IS DISTINCT FROM l.rada_id;

-- ---------------------------------------------------------------------------
-- 7. Make the defect unrepeatable.
--    The existing unique key is case-sensitive, which is how the pairs formed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_legislation_rada_id_lower
  ON public.legislation (lower(rada_id));

-- An official number must never be stored here again. Registry ids are
-- lower-case and never end in a Roman numeral; «4651-vi» and «5073-VI» did.
ALTER TABLE public.legislation DROP CONSTRAINT IF EXISTS legislation_rada_id_is_registry_id;
ALTER TABLE public.legislation ADD CONSTRAINT legislation_rada_id_is_registry_id
  CHECK (rada_id = lower(rada_id)
         AND rada_id !~ '^[0-9]+[а-яіїєґ]?-[ivxlcdm]+$');

-- ---------------------------------------------------------------------------
-- 8. Backfill from the corpus. adoption_date was NULL in all 655 rows and
--    effective_date in all 655; npa.act.first_ed is the adoption date
--    (verified against known dates for 16 landmark acts).
--    995_* placeholders are excluded by value: three acts carry 1990-01-01
--    rather than a real date.
UPDATE public.legislation l
   SET adoption_date     = COALESCE(l.adoption_date,
                             CASE WHEN a.first_ed = DATE '1990-01-01' THEN NULL ELSE a.first_ed END),
       last_amended_date = COALESCE(l.last_amended_date, a.last_ed),
       total_editions    = GREATEST(COALESCE(l.total_editions, 0), a.editions_cnt),
       title             = CASE WHEN COALESCE(btrim(l.title), '') IN ('', 'КАБІНЕТ МІНІСТРІВ УКРАЇНИ')
                                THEN a.title ELSE l.title END,
       updated_at        = now()
  FROM npa.act a
 WHERE lower(l.rada_id) = a.nreg;

COMMIT;
