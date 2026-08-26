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

CREATE TABLE IF NOT EXISTS ch_zefix_municipality (
    id      integer PRIMARY KEY,
    name    text NOT NULL,
    canton  text,
    iri     text NOT NULL
);

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

CREATE INDEX IF NOT EXISTS idx_ch_shab_uid ON ch_shab_publications (company_uid) WHERE company_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ch_shab_date ON ch_shab_publications (publication_date);
CREATE INDEX IF NOT EXISTS idx_ch_shab_detail_queue ON ch_shab_publications (rubric, publication_date DESC) WHERE detail_fetched_at IS NULL;

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
