-- Stage 2: derive the snapshot chain from the register. Pure SQL, no network.
--
-- Re-runnable: it rebuilds pl_act_snapshots from pl_acts + pl_act_references
-- every time, so running it again after a details re-fetch simply picks up
-- whatever the register now says.
--
--   psql -f scripts/pl/build_pl_snapshots.sql
--
-- What it derives, and why each rule is what it is, is documented in migration
-- 184 next to the columns. The short version:
--   * a law's identity is the BASE act; an obwieszczenie contributes a dated
--     snapshot under that identity, never a law of its own
--   * exact_on is the one date the text is exactly the law
--   * valid_to is derived from the NEXT snapshot's exact_on, not from the
--     source's expirationDate, which overlaps
--   * drift_from / amendments_after say how far behind the text has fallen

BEGIN;

-- 1. Consolidation links, taken from the reverse edge the obwieszczenie itself
--    carries. Not from the title: 12% of DU obwieszczenia are not
--    consolidations, and title matching would have to survive 1930s orthography.
UPDATE pl_acts a
   SET is_consolidation = false, consolidates_eli = NULL
 WHERE a.is_consolidation OR a.consolidates_eli IS NOT NULL;

UPDATE pl_acts a
   SET is_consolidation = true,
       consolidates_eli = r.dst_eli
  FROM pl_act_references r
 WHERE r.src_eli = a.eli
   AND r.category = 'Tekst jednolity dla aktu';

-- 2. Amendment counters, for display and for the audit.
UPDATE pl_acts a SET amends_count = c.n
  FROM (SELECT src_eli, count(*) n FROM pl_act_references
         WHERE category = 'Akty zmienione' GROUP BY 1) c
 WHERE c.src_eli = a.eli;

UPDATE pl_acts a SET amended_by_count = c.n
  FROM (SELECT src_eli, count(*) n FROM pl_act_references
         WHERE category = 'Akty zmieniające' GROUP BY 1) c
 WHERE c.src_eli = a.eli;

-- 3. The snapshot chain.
DELETE FROM pl_act_snapshots;

WITH raw AS (
    -- The text published on promulgation, under the act's own ELI. Only for
    -- acts that are not themselves consolidations of something else.
    SELECT a.eli                     AS act_eli,
           a.eli                     AS snapshot_eli,
           'ogloszony'               AS snapshot_kind,
           coalesce(a.entry_into_force, a.promulgation, a.announcement_date) AS exact_on,
           CASE WHEN a.entry_into_force IS NOT NULL THEN 'entryIntoForce'
                WHEN a.promulgation     IS NOT NULL THEN 'promulgation'
                WHEN a.announcement_date IS NOT NULL THEN 'announcementDate'
                ELSE 'unknown' END   AS exact_on_src,
           a.expiration_date         AS source_expiration,
           a.text_html               AS has_html,
           a.texts                   AS texts
      FROM pl_acts a
     WHERE NOT a.is_consolidation

    UNION ALL

    -- Each consolidated text, under the BASE act's identity but served from the
    -- obwieszczenie's ELI. legalStatusDate is the "stan prawny na dzien" and is
    -- the whole reason this can be dated honestly; the oldest obwieszczenia
    -- predate the field, hence the fallback.
    SELECT c.consolidates_eli,
           c.eli,
           'jednolity',
           coalesce(c.legal_status_date, c.announcement_date, c.promulgation),
           CASE WHEN c.legal_status_date IS NOT NULL THEN 'legalStatusDate'
                WHEN c.announcement_date IS NOT NULL THEN 'announcementDate'
                WHEN c.promulgation      IS NOT NULL THEN 'promulgation'
                ELSE 'unknown' END,
           c.expiration_date,
           c.text_html,
           c.texts
      FROM pl_acts c
     WHERE c.is_consolidation
       AND c.consolidates_eli IS NOT NULL
       -- A dangling target would otherwise create a snapshot for a law we do
       -- not have, and count(DISTINCT act_eli) would then overstate the corpus.
       AND EXISTS (SELECT 1 FROM pl_acts b WHERE b.eli = c.consolidates_eli)
), ordered AS (
    SELECT raw.*,
           -- Order by exact_on, not by promulgation or by position: KP's
           -- DU/2019/1040 was promulgated 2019-05-16 but is exact on
           -- 2019-05-09, and only the exact_on order is total and gap-free.
           -- NULLs sort last and get no interval, so they can never be picked
           -- as "the text in force on D".
           row_number() OVER (PARTITION BY act_eli
                              ORDER BY exact_on NULLS LAST, snapshot_kind DESC,
                                       snapshot_eli) - 1 AS seq,
           lead(exact_on) OVER (PARTITION BY act_eli
                                ORDER BY exact_on NULLS LAST, snapshot_kind DESC,
                                         snapshot_eli) AS next_exact_on
      FROM raw
)
INSERT INTO pl_act_snapshots
    (act_eli, snapshot_eli, seq, snapshot_kind, exact_on, exact_on_src,
     valid_to, source_expiration, has_html, text_url, pdf_file)
SELECT o.act_eli, o.snapshot_eli, o.seq, o.snapshot_kind, o.exact_on, o.exact_on_src,
       CASE WHEN o.next_exact_on IS NULL THEN NULL
            ELSE o.next_exact_on - 1 END,
       o.source_expiration,
       o.has_html,
       CASE WHEN o.has_html
            THEN 'https://api.sejm.gov.pl/eli/acts/' || o.snapshot_eli || '/text.html'
            END,
       -- The consolidated-text PDF (type U), the fallback when no HTML exists.
       (SELECT t->>'fileName' FROM jsonb_array_elements(o.texts) t
         WHERE t->>'type' IN ('U', 'T') LIMIT 1)
  FROM ordered o
 WHERE o.exact_on IS NOT NULL;

-- 4. The honesty columns. drift_from is the first amendment to land after this
--    text was exact; amendments_after is how many landed before the next
--    published text. A large amendments_after means Poland changed the law
--    repeatedly and published no consolidated text for it - which is exactly
--    what a consumer needs to be told, and exactly what a schema that stored
--    only "current text" would hide.
UPDATE pl_act_snapshots s
   SET drift_from = d.first_after,
       amendments_after = d.n
  FROM (
    SELECT s.act_eli, s.snapshot_eli,
           min(r.effective_date) AS first_after,
           count(r.*)            AS n
      FROM pl_act_snapshots s
      JOIN pl_act_references r
        ON r.src_eli = s.act_eli
       AND r.category = 'Akty zmieniające'
       AND r.effective_date > s.exact_on
       AND r.effective_date <= coalesce(s.valid_to, DATE '9999-12-31')
     GROUP BY 1, 2
  ) d
 WHERE d.act_eli = s.act_eli AND d.snapshot_eli = s.snapshot_eli;

-- 5. Roll-ups on the act.
UPDATE pl_acts a SET snapshot_count = c.n
  FROM (SELECT act_eli, count(*) n FROM pl_act_snapshots GROUP BY 1) c
 WHERE c.act_eli = a.eli;

COMMIT;

ANALYZE pl_acts;
ANALYZE pl_act_references;
ANALYZE pl_act_snapshots;
