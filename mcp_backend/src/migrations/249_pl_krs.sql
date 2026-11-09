-- Polish National Court Register (KRS) for lawrider.pl.
--
-- Source: https://api-krs.ms.gov.pl (Ministerstwo Sprawiedliwości), no token,
-- no published limits, CC0 on dane.gov.pl dataset 27606. Natural persons'
-- PESEL arrives already masked by the source ("8**********").
--
-- There is no dump, so the register is enumerated by number. Every number is
-- in exactly one register, P (przedsiębiorcy) or S (stowarzyszenia), and the
-- API answers 200 (current extract), 204 (in P but no current extract: the
-- entity was struck off; OdpisPelny still has its history) or 404 (not in
-- that register).
--
-- pl_krs_scan is the worklist: one row per probed number, hit or miss, so
-- "never asked" and "asked, nothing there" are different states. The daily
-- bulletin (/api/Krs/Biuletyn/{date}) lists numbers changed that day; the
-- harvester deletes their scan rows, which puts them back on the worklist.
--
-- Idempotent: scripts/pl/harvest_krs.py applies this file itself before it
-- starts, so the load does not wait for a deploy.

CREATE TABLE IF NOT EXISTS pl_krs_scan (
    krs         integer PRIMARY KEY,
    rejestr     char(1),            -- P | S | NULL when in neither
    http_p      smallint,
    http_s      smallint,
    scanned_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pl_krs_entities (
    krs              char(10) PRIMARY KEY,   -- zero-padded, as the source prints it
    rejestr          char(1)  NOT NULL,      -- P | S
    status           text     NOT NULL,      -- current | struck_off
    name             text,
    legal_form       text,
    nip              text,
    regon            text,
    voivodeship      text,
    city             text,
    registered_on    date,
    last_entry_on    date,
    last_entry_no    integer,
    struck_off_on    date,
    is_opp           boolean,                -- organizacja pożytku publicznego
    odpis_kind       text     NOT NULL,      -- aktualny | pelny
    odpis            jsonb    NOT NULL,
    source_url       text     NOT NULL,
    fetched_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pl_krs_nip   ON pl_krs_entities (nip)   WHERE nip IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pl_krs_regon ON pl_krs_entities (regon) WHERE regon IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pl_krs_name_fts
    ON pl_krs_entities USING gin (to_tsvector('simple', coalesce(name, '')));

CREATE TABLE IF NOT EXISTS pl_krs_bulletin (
    day         date PRIMARY KEY,
    entries     integer NOT NULL,
    distinct_krs integer NOT NULL,
    fetched_at  timestamptz NOT NULL DEFAULT now()
);
