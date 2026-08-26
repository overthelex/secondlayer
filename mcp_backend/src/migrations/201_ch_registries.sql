-- mcp_backend/src/migrations/201_ch_registries.sql
-- Swiss registries: Zefix municipality/progress tracking and SHAB gazette
-- detail-fetch fields, extending migration 129's ch_zefix_companies and
-- ch_shab_publications.
--
-- SET lock_timeout = '3s' is the first statement, same reasoning as
-- migration 199: the ALTER TABLE statements below take an ACCESS EXCLUSIVE
-- lock on ch_zefix_companies and ch_shab_publications, and the migration
-- runner applies this whole file as one implicit transaction, so that lock
-- is held until the file's last statement commits -- through the index
-- builds that follow. If either table is busy, this must fail fast and be
-- retried rather than queue up behind (and block) other writers.
--
-- idx_ch_shab_name_trgm needs the pg_trgm extension, which is not
-- guaranteed to be installed (it requires superuser to CREATE EXTENSION and
-- isn't every deployment's default). Guarded with a DO block that checks
-- pg_extension first, same pattern as migration 199's use of DO $$ ...
-- EXCEPTION WHEN for constraints on a pre-existing table: skip the whole
-- statement rather than fail the migration when the extension is absent.

SET lock_timeout = '3s';

ALTER TABLE ch_zefix_companies ADD COLUMN IF NOT EXISTS municipality_id integer;
ALTER TABLE ch_zefix_companies ADD COLUMN IF NOT EXISTS legal_form_code text;
ALTER TABLE ch_zefix_companies ADD COLUMN IF NOT EXISTS seen_at timestamptz;
ALTER TABLE ch_zefix_companies ADD COLUMN IF NOT EXISTS source_iri text;

-- `name` is nullable, and that is a measurement rather than a preference.
-- Probed live on 2026-08-26: Zefix organisations reference 2,111 distinct
-- municipality IRIs, but only 2,110 of them are a schema.ld:Municipality
-- contained in a canton and therefore carry schema:name at all. The odd one
-- out is <https://ld.admin.ch/municipality/700>, with 5 organisations. It
-- has to be recorded (the zefix stage walks the municipalities the
-- organisations actually reference, or those 5 companies are silently lost),
-- and NOT NULL would leave only two ways to record it: refuse the row, or
-- invent a name for a municipality LINDAS does not name. The ALTER below
-- carries a database where this migration already ran under the old shape.
CREATE TABLE IF NOT EXISTS ch_zefix_municipality (
    id      integer PRIMARY KEY,
    name    text,
    canton  text,
    iri     text NOT NULL
);
ALTER TABLE ch_zefix_municipality ALTER COLUMN name DROP NOT NULL;

CREATE TABLE IF NOT EXISTS ch_zefix_progress (
    run_date        date NOT NULL,
    municipality_id integer NOT NULL,
    companies       integer NOT NULL DEFAULT 0,
    done_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_date, municipality_id)
);

ALTER TABLE ch_shab_publications ADD COLUMN IF NOT EXISTS language text;
ALTER TABLE ch_shab_publications ADD COLUMN IF NOT EXISTS publication_number text;
ALTER TABLE ch_shab_publications ADD COLUMN IF NOT EXISTS title text;             -- title in the publication language
ALTER TABLE ch_shab_publications ADD COLUMN IF NOT EXISTS registration_office text;
ALTER TABLE ch_shab_publications ADD COLUMN IF NOT EXISTS legal_form text;
ALTER TABLE ch_shab_publications ADD COLUMN IF NOT EXISTS seat text;
ALTER TABLE ch_shab_publications ADD COLUMN IF NOT EXISTS detail_fetched_at timestamptz;
ALTER TABLE ch_shab_publications ADD COLUMN IF NOT EXISTS detail_attempts smallint NOT NULL DEFAULT 0;
ALTER TABLE ch_shab_publications ADD COLUMN IF NOT EXISTS detail_error text;

-- idx_ch_shab_uid and idx_ch_shab_date already exist on any database that ran migration 129
-- (there without the partial predicate); IF NOT EXISTS matches by name, so on prod these two are
-- no-ops and the 129 definitions stay. They are here for databases created from this file alone.
CREATE INDEX IF NOT EXISTS idx_ch_shab_uid ON ch_shab_publications (company_uid) WHERE company_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ch_shab_date ON ch_shab_publications (publication_date);
-- The shab-detail queue index. Both columns DESC, in that order, because the
-- stage claims `ORDER BY rubric DESC, publication_date DESC` -- 'KK' > 'HR'
-- lexicographically, so bankruptcies come first -- and a partial index is only
-- worth having if the claim reads it in order. The earlier definition
-- (rubric ASC, publication_date DESC) could not serve that ORDER BY at all:
-- measured on 1M unfetched rows the claim sorted the whole set on every call,
-- 867 ms with a disk spill, for 500 rows.
--
-- IF NOT EXISTS matches by NAME, so a database that already ran the older
-- version of this migration would keep the useless index forever. Dropped
-- first, and only when it is the old shape, so re-running this file on a
-- corrected database is still a no-op.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_indexes
                WHERE indexname = 'idx_ch_shab_detail_queue'
                  AND indexdef NOT LIKE '%rubric DESC%') THEN
        DROP INDEX IF EXISTS idx_ch_shab_detail_queue;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_ch_shab_detail_queue ON ch_shab_publications (rubric DESC, publication_date DESC) WHERE detail_fetched_at IS NULL;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
        CREATE INDEX IF NOT EXISTS idx_ch_shab_name_trgm ON ch_shab_publications USING gin (company_name gin_trgm_ops);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS ch_shab_progress (
    rubric  text NOT NULL,
    month   date NOT NULL,
    total   integer,
    fetched integer,
    done_at timestamptz,
    PRIMARY KEY (rubric, month)
);
