-- 027: history of the ЄДР (legal entities and branches of foreign entities) across dated snapshots.
--
-- The weekly import (sync-edrpou.ts) overwrites legal_entities/founders/... with the current dump,
-- so the past is lost. Schema edr_hist keeps every loaded dump as a snapshot with an explicit date
-- (the dump itself carries none) and folds it into per-field runs, so a company can be read as of
-- a date (2016, around 25.10.2021, ...) and a founder or beneficial owner can be found in past
-- snapshots. Loaded by src/scripts/load-edr-snapshot.ts (historical dumps, any order) and, behind
-- EDR_HISTORY_SNAPSHOT=1, by the weekly sync. Existing tables are not touched.
--
-- ФОП (sole traders) are not loaded: private persons, and no history of them is needed.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE SCHEMA IF NOT EXISTS edr_hist;

-- One row per loaded snapshot and kind (uo = legal entities, fsu = branches of foreign entities).
-- fields = the fields this snapshot published for at least one subject (per-field presence): a
-- snapshot counts for a field only if it is listed here, so wartime dumps without addresses do not
-- close the 2016-2021 address runs, and 2016 dumps without founders do not break founder runs.
CREATE TABLE IF NOT EXISTS edr_hist.snapshot (
    kind           text NOT NULL CHECK (kind IN ('uo', 'fsu')),
    snapshot_date  date NOT NULL,
    source         text NOT NULL,          -- where the dump came from (URL / dataset revision / weekly sync)
    file           text,                   -- file name(s) as loaded
    md5            text,                   -- md5 of the loaded file(s), comma-separated
    format         text,                   -- subject (2020-2026) | record (2018-2019) | row (2016-2017)
    subjects       integer NOT NULL DEFAULT 0,
    fields         text[] NOT NULL,
    loaded_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, snapshot_date)
);

-- Latest known state per code: the newest snapshot wins column by column; address and kved keep
-- the newest value that was published (the current dumps leave them out).
CREATE TABLE IF NOT EXISTS edr_hist.company (
    edrpou         text PRIMARY KEY,
    kind           text NOT NULL,
    record_id      text,                   -- RECORD (subject id), 2020+ dumps only
    name           text,
    name_latn      text,                   -- uaMatchKey(name)
    short_name     text,
    legal_form     text,
    status         text,
    address        text,
    kved           text,
    capital        text,
    registered_on  date,
    first_seen     date NOT NULL,
    last_seen      date NOT NULL
);
CREATE INDEX IF NOT EXISTS edr_hist_company_latn_trgm ON edr_hist.company USING gin (name_latn gin_trgm_ops);

-- Value history: one row per run of consecutive loaded snapshots (of this kind, among those that
-- publish the field) in which the company had this value. A value that disappears and comes back
-- has two rows. Snapshots may be loaded in any order. last_snapshot NULL = open run: it lasts
-- through the latest loaded snapshot of this kind that publishes the field, so loading the newest
-- snapshot writes only the values that changed. Read through edr_hist.history_runs.
-- field: name, short_name, legal_form, status, address, kved, capital, head, founder, beneficiary.
CREATE TABLE IF NOT EXISTS edr_hist.history (
    edrpou          text NOT NULL,
    field           text NOT NULL,
    value_hash      text NOT NULL,          -- md5 of the normalised value (format-independent)
    value           text,
    kind            text NOT NULL,
    first_snapshot  date NOT NULL,
    last_snapshot   date,                   -- NULL: open run
    PRIMARY KEY (edrpou, field, value_hash, first_snapshot)
);

-- Founders: one row per distinct entry text per company, first/last snapshot that listed it.
CREATE TABLE IF NOT EXISTS edr_hist.founder (
    edrpou            text NOT NULL,
    entry_hash        text NOT NULL,        -- md5 of the raw entry
    raw               text NOT NULL,        -- the entry as published
    kind              text,                 -- person | organisation (best effort)
    name              text,
    name_latn         text,                 -- uaMatchKey(name): Latin skeleton for cross-script search
    code              text,                 -- ЄДРПОУ of a Ukrainian founder or a foreign registration number
    country           text,                 -- as written
    country_code      text,                 -- ISO 3166 alpha-2 when known
    contribution      text,
    contribution_uah  numeric,
    first_seen        date NOT NULL,
    last_seen         date NOT NULL,
    PRIMARY KEY (edrpou, entry_hash)
);
CREATE INDEX IF NOT EXISTS edr_hist_founder_latn_trgm ON edr_hist.founder USING gin (name_latn gin_trgm_ops);
CREATE INDEX IF NOT EXISTS edr_hist_founder_latn ON edr_hist.founder (name_latn);
CREATE INDEX IF NOT EXISTS edr_hist_founder_code ON edr_hist.founder (code) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS edr_hist_founder_country ON edr_hist.founder (country_code) WHERE country_code <> 'UA';

-- Ultimate beneficial owners, or the stated reason there is none.
CREATE TABLE IF NOT EXISTS edr_hist.beneficiary (
    edrpou        text NOT NULL,
    entry_hash    text NOT NULL,
    raw           text NOT NULL,
    name          text,                     -- NULL when the entry is a reason for absence
    name_latn     text,
    country       text,
    country_code  text,
    influence     text,
    share         text,
    reason        text,
    first_seen    date NOT NULL,
    last_seen     date NOT NULL,
    PRIMARY KEY (edrpou, entry_hash)
);
CREATE INDEX IF NOT EXISTS edr_hist_beneficiary_latn_trgm ON edr_hist.beneficiary USING gin (name_latn gin_trgm_ops);
CREATE INDEX IF NOT EXISTS edr_hist_beneficiary_latn ON edr_hist.beneficiary (name_latn);
CREATE INDEX IF NOT EXISTS edr_hist_beneficiary_country ON edr_hist.beneficiary (country_code) WHERE country_code <> 'UA';

-- Heads and signatories (SIGNERS; BOSS in 2016-2019 dumps) and members of governing bodies.
CREATE TABLE IF NOT EXISTS edr_hist.head (
    edrpou        text NOT NULL,
    entry_hash    text NOT NULL,
    raw           text NOT NULL,
    source        text NOT NULL,            -- signer | member | boss
    name          text,
    name_latn     text,
    role          text,
    role_class    text,                     -- head | representative | member | liquidator | other
    appointed_on  date,
    first_seen    date NOT NULL,
    last_seen     date NOT NULL,
    PRIMARY KEY (edrpou, entry_hash)
);
CREATE INDEX IF NOT EXISTS edr_hist_head_latn ON edr_hist.head (name_latn);

-- History with open runs resolved to the latest loaded snapshot that publishes the field.
CREATE OR REPLACE VIEW edr_hist.history_runs AS
SELECT h.edrpou, h.field, h.value_hash, h.value, h.kind, h.first_snapshot,
       COALESCE(h.last_snapshot, (SELECT max(s.snapshot_date) FROM edr_hist.snapshot s
                                  WHERE s.kind = h.kind AND h.field = ANY (s.fields))) AS last_snapshot
FROM edr_hist.history h;
