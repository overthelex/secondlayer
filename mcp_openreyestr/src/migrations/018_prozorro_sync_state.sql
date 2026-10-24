-- 018: ProZorro incremental import cursor (LEXAI-2089)
--
-- import-prozorro.js walks the public tenders feed by dateModified and commits
-- the feed's next_page.offset here in the same transaction as each page of
-- upserts, so an interrupted run resumes after the last committed page.
-- The importer also runs these statements itself (migrations are not applied
-- on container start).

CREATE TABLE IF NOT EXISTS prozorro_sync_state (
    feed TEXT PRIMARY KEY,
    next_offset TEXT NOT NULL,
    last_date_modified TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The historical rows were loaded with explicit ids and the id sequence was
-- left at 1, so the first new INSERT would hit prozorro_tenders_pkey.
-- Only ever moves the sequence forward.
SELECT setval(pg_get_serial_sequence('prozorro_tenders', 'id'),
              GREATEST((SELECT COALESCE(max(id), 1) FROM prozorro_tenders),
                       (SELECT last_value FROM prozorro_tenders_id_seq)));
