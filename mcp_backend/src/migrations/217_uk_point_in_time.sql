-- 217: UK point-in-time legislation — provision text as it stood on any date.
--
-- The research.legislation.gov.uk `revised-all-versions` archive holds every
-- revised version of every act: 280,720 XML files, 186.1 GB uncompressed,
-- covering 62,866 acts. It is that large because each version repeats the whole
-- act — the Town and Country Planning Act 1990 appears 401 times and the
-- Companies Act 2006 200 times — so storing a snapshot per version would cost
-- roughly 110 GB for text that barely changes.
--
-- Measured on four acts before this was written (naive rows are what a snapshot
-- table would hold, dedup is unique provision content):
--
--     ukpga/1990/8   401 versions  287,274 -> 16,456 rows (5.7%)  431 MB -> 4.7 MB
--     ukpga/2006/46  200 versions  384,888 -> 28,594 rows (7.4%)  378 MB -> 4.1 MB
--     uksi/2010/2955  57 versions   46,048 -> 15,431 rows (33.5%)  38 MB -> 1.9 MB
--     ukpga/1998/42   29 versions    1,627 ->    137 rows (8.4%)
--
-- So the shape here is intervals, not snapshots: one row per provision per span
-- during which its text did not change, and the text itself stored once per
-- distinct content. A section untouched across 401 versions is a single row.
--
-- This does NOT replace uk_legislation_provisions, which holds the current text
-- and its English FTS index and is what ordinary search reads. This pair answers
-- the narrower question "what did section N say on date D".

-- The text, once per distinct content. sha1 of the UTF-8 bytes, as bytea rather
-- than hex: 20 bytes against 40, over millions of rows and repeated in every
-- version row that points at it.
CREATE TABLE IF NOT EXISTS uk_provision_text (
    text_hash bytea   PRIMARY KEY,
    text      text    NOT NULL,
    n_chars   integer NOT NULL
);

-- One row per provision per unchanged span. Intervals are half-open:
-- [valid_from, valid_to), and valid_to IS NULL means the provision still stood
-- in the last version the archive carries for that act — which is not the same
-- as "in force today", because the archive lags the live site and an act may
-- have been repealed wholesale without a further revised version.
--
-- provision_key is the item's own IdURI with the host and the trailing version
-- date stripped: `ukpga/1990/8/section/55`. It is the only identifier stable
-- across versions — `ord` is positional and shifts the moment a section is
-- inserted, which is exactly what amendments do.
--
-- The label, title and structural facets are recorded as they stood at the
-- START of the interval. Only the text participates in the hash, so a version
-- that renames a heading without touching the body does not open a new row.
CREATE TABLE IF NOT EXISTS uk_provision_version (
    leg_id          text    NOT NULL,
    provision_key   text    NOT NULL,
    valid_from      date    NOT NULL,
    valid_to        date,
    ord             integer NOT NULL,
    provision_label text    NOT NULL,
    provision_type  text,
    part            text,
    chapter         text,
    schedule_no     text,
    title           text,
    text_hash       bytea   NOT NULL REFERENCES uk_provision_text(text_hash),
    PRIMARY KEY (leg_id, provision_key, valid_from)
);

-- The as-at lookup: given an act and a date, the rows whose interval covers it.
CREATE INDEX IF NOT EXISTS idx_uk_pv_asat
    ON uk_provision_version (leg_id, valid_from DESC, valid_to);

-- "how did section 55 change over time" needs no index of its own: the primary key is
-- already (leg_id, provision_key, valid_from), which serves that lookup exactly. An
-- index on the same three columns was here briefly and was pure cost — dropped rather
-- than left, since it had already been created on lawrider_prod by hand.
DROP INDEX IF EXISTS idx_uk_pv_key;

CREATE INDEX IF NOT EXISTS idx_uk_pv_label
    ON uk_provision_version (leg_id, provision_label);

-- No FTS index over uk_provision_text here on purpose. A GIN maintained during
-- a multi-million-row bulk insert costs more than building it once at the end,
-- and it belongs in its own migration run with CONCURRENTLY once the load has
-- settled. See scripts/uk/06_load_point_in_time.py.

-- Per-act checkpoint, so a 9-hour load resumes instead of restarting. Also the
-- honest record of what was actually covered: an act absent from this table was
-- never loaded, which is a different statement from "this act never changed".
CREATE TABLE IF NOT EXISTS uk_pit_load_state (
    leg_id         text PRIMARY KEY,
    versions       integer     NOT NULL,
    versions_empty integer     NOT NULL DEFAULT 0,
    rows_written   integer     NOT NULL,
    first_version  date,
    last_version   date,
    source         text        NOT NULL,
    loaded_at      timestamptz NOT NULL DEFAULT now()
);

-- Convenience for the tool layer and for checking the load by hand. Returns the
-- act as it stood on p_date, in document order.
CREATE OR REPLACE FUNCTION uk_act_as_at(p_leg_id text, p_date date)
RETURNS TABLE (
    provision_key   text,
    provision_label text,
    provision_type  text,
    ord             integer,
    part            text,
    chapter         text,
    schedule_no     text,
    title           text,
    valid_from      date,
    valid_to        date,
    text            text
)
LANGUAGE sql STABLE AS $$
    SELECT v.provision_key, v.provision_label, v.provision_type, v.ord,
           v.part, v.chapter, v.schedule_no, v.title,
           v.valid_from, v.valid_to, t.text
      FROM uk_provision_version v
      JOIN uk_provision_text t ON t.text_hash = v.text_hash
     WHERE v.leg_id = p_leg_id
       AND v.valid_from <= p_date
       AND (v.valid_to IS NULL OR v.valid_to > p_date)
     ORDER BY v.ord
$$;
