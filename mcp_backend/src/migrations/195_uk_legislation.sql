-- Migration 195: UK legislation, its point-in-time versions, and the amendments
--
-- Measured on prod 2026-08-22: there is no UK legislation of any kind. A search of
-- information_schema.tables across all four databases and every schema for
-- uk_|_uk$|^gb|engl|wales|scot|northern|bailii|ukpga|uksi|britain returned exactly
-- one row, uk_court_decisions. Probing every existing legislation corpus for
-- '%.gov.uk%' in its URL/ELI columns returned zero. So UK case law cites statutes
-- that do not exist as nodes anywhere in the warehouse.
--
-- Source: https://www.legislation.gov.uk, OGL v3.0 (commercial use permitted with
-- attribution). Unlike Find Case Law, it needs no separate licence for
-- computational analysis. Fair use is 3,000 requests / 5 minutes per IP and a
-- User-Agent header is mandatory.
--
-- Shape follows nl_laws / nl_law_editions / nl_law_articles (migrations 181-182)
-- because legislation.gov.uk, like KOOP, publishes a point-in-time URI per
-- provision and a validity interval per version, so versions come from metadata
-- and never from diffing. Three things are borrowed from npa.* instead
-- (scripts/legislation/full-corpus/npa_schema.sql):
--   * http_status with verdict codes above the HTTP range, so a document that came
--     back as an error page with status 200 is excluded by the same filter as a 404;
--   * text_hash, to collapse byte-identical consecutive versions before embedding;
--   * an explicit is_current flag rather than max(valid_from), because prospective
--     commencements mean the latest version is deliberately not the one in force.

-- ---------------------------------------------------------------- register ----
-- One row per item of legislation. id is the natural legislation.gov.uk key,
-- e.g. 'ukpga/2006/46' (Companies Act 2006) or 'uksi/1998/1833'.
CREATE TABLE IF NOT EXISTS uk_legislation (
    id                  TEXT PRIMARY KEY,
    leg_type            TEXT NOT NULL,          -- ukpga | uksi | apgb | aep | ukppa | ukcm | ukla
    year                INTEGER,
    number              TEXT,                   -- TEXT: some items carry non-numeric numbers
    title               TEXT,
    long_title          TEXT,
    -- ukm:DocumentStatus. 'revised' means TNA maintains point-in-time text for it;
    -- 'final' means enacted text only and uk_legislation_versions will be empty.
    document_status     TEXT,
    extent              TEXT,                   -- E+W+S+N.I. etc
    enactment_date      DATE,
    made_date           DATE,                   -- SIs
    coming_into_force   DATE,
    valid_date          DATE,                   -- dct:valid on the document
    restrict_start_date DATE,
    version_count       INTEGER NOT NULL DEFAULT 0,
    first_version       DATE,
    last_version        DATE,
    unapplied_effects   INTEGER NOT NULL DEFAULT 0,
    source_url          TEXT,
    imported_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_uk_leg_type_year   ON uk_legislation (leg_type, year);
CREATE INDEX IF NOT EXISTS idx_uk_leg_title       ON uk_legislation (title);
CREATE INDEX IF NOT EXISTS idx_uk_leg_title_trgm  ON uk_legislation USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_uk_leg_status      ON uk_legislation (document_status);

-- ---------------------------------------------------------------- versions ----
-- One row per point-in-time version. Discovered from the item's own metadata: each
-- /data.xml carries one <atom:link rel="http://purl.org/dc/terms/hasVersion"> per
-- available version, so nothing has to be inferred. Note /revision does not exist
-- on legislation.gov.uk (404); the forms are /enacted (or /made), the bare current
-- URI, a dated URI, and /prospective.
CREATE TABLE IF NOT EXISTS uk_legislation_versions (
    leg_id       TEXT NOT NULL REFERENCES uk_legislation(id) ON DELETE CASCADE,
    valid_from   DATE NOT NULL,
    valid_to     DATE,
    version_label TEXT,                     -- 'enacted' | 'made' | 'prospective' | ISO date
    version_uri  TEXT,
    xml_url      TEXT,
    is_current   BOOLEAN NOT NULL DEFAULT false,
    -- HTTP status, or a verdict above the HTTP range:
    --   900 = fetched but empty, 901 = error page served with status 200
    http_status  INTEGER,
    char_len     INTEGER,
    text_hash    TEXT,                      -- sha256, to collapse identical versions
    provision_count INTEGER,
    fetched_at   TIMESTAMPTZ,
    PRIMARY KEY (leg_id, valid_from)
);

CREATE INDEX IF NOT EXISTS idx_uk_ver_period  ON uk_legislation_versions (leg_id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_uk_ver_from    ON uk_legislation_versions (valid_from);
CREATE INDEX IF NOT EXISTS idx_uk_ver_current ON uk_legislation_versions (leg_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS idx_uk_ver_bad     ON uk_legislation_versions (http_status)
    WHERE http_status IS NOT NULL AND http_status <> 200;

-- -------------------------------------------------------------- provisions ----
-- Keyed on (leg_id, valid_from, ord), NOT on the label. Labels repeat: Schedules
-- restart numbering, so an Act routinely has two "paragraph 1". Keying on the label
-- rejects the whole insert batch. This is the same lesson recorded for NL in
-- migration 182 (nl_law_articles, lines 26-31), learned there on the Awb.
CREATE TABLE IF NOT EXISTS uk_legislation_provisions (
    leg_id          TEXT NOT NULL,
    valid_from      DATE NOT NULL,
    ord             INTEGER NOT NULL,       -- document order
    provision_label TEXT NOT NULL,          -- '172', '3(1)', 'Sch 1 para 4' - as practice cites it
    provision_type  TEXT,                   -- section | regulation | article | rule | paragraph | schedule
    provision_uri   TEXT,
    part            TEXT,
    chapter         TEXT,
    schedule_no     TEXT,
    title           TEXT,
    text            TEXT NOT NULL,
    n_chars         INTEGER,
    PRIMARY KEY (leg_id, valid_from, ord)
);

CREATE INDEX IF NOT EXISTS idx_uk_prov_lookup  ON uk_legislation_provisions (leg_id, provision_label, valid_from);
CREATE INDEX IF NOT EXISTS idx_uk_prov_version ON uk_legislation_provisions (leg_id, valid_from);
CREATE INDEX IF NOT EXISTS idx_uk_prov_fts     ON uk_legislation_provisions
    USING GIN (to_tsvector('english', text));

-- ---------------------------------------------------------------- effects -----
-- Amendments. Ingested, never diffed: legislation.gov.uk publishes the Changes to
-- Legislation dataset explicitly, both as <ukm:UnappliedEffects> inside each item
-- and as /changes/affected/{type}/{year}/data.csv feeds. This mirrors how UAE
-- amendments work (scripts/uae/sql/07_create_amendments.sql), where the portal also
-- states the change rather than leaving it to be inferred.
--
-- Coverage of the source: changes made by legislation enacted from 2002 onward
-- affecting primary legislation, plus changes to secondary from 1971 onward.
CREATE TABLE IF NOT EXISTS uk_legislation_effects (
    effect_id            TEXT PRIMARY KEY,   -- ukm:EffectId, or the /id/effect/key-... URI
    affected_uri         TEXT,
    affected_id          TEXT,               -- resolved into uk_legislation.id where possible
    affected_class       TEXT,
    affected_year        INTEGER,
    affected_number      TEXT,
    affected_title       TEXT,
    affected_provisions  TEXT,
    affected_extent      TEXT,
    affecting_uri        TEXT,
    affecting_id         TEXT,
    affecting_class      TEXT,
    affecting_year       INTEGER,
    affecting_number     TEXT,
    affecting_title      TEXT,
    affecting_provisions TEXT,
    effect_type          TEXT,               -- inserted | words substituted | repealed | coming into force ...
    requires_applied     BOOLEAN,
    applied              BOOLEAN,            -- false = outstanding effect, the editorial backlog
    in_force_date        DATE,
    royal_assent_date    DATE,
    commencement_authority TEXT,
    notes                TEXT,
    -- 'unapplied' = read from ukm:UnappliedEffects on the item;
    -- 'changes-feed' = read from the /changes CSV.
    origin               TEXT NOT NULL,
    modified             TIMESTAMPTZ,        -- ukm:Effect/@Modified, the incremental key
    imported_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_uk_eff_affected  ON uk_legislation_effects (affected_id, in_force_date);
CREATE INDEX IF NOT EXISTS idx_uk_eff_affecting ON uk_legislation_effects (affecting_id);
CREATE INDEX IF NOT EXISTS idx_uk_eff_modified  ON uk_legislation_effects (modified DESC);
CREATE INDEX IF NOT EXISTS idx_uk_eff_pending   ON uk_legislation_effects (affected_id)
    WHERE applied IS NOT TRUE;

-- One row per amendment as a reader would ask for it: what changed in this act, when.
CREATE OR REPLACE VIEW uk_legislation_amendment_history AS
SELECT e.affected_id      AS leg_id,
       l.title            AS act_title,
       e.affected_provisions,
       e.effect_type,
       e.in_force_date,
       e.applied,
       e.affecting_id,
       e.affecting_title,
       e.affecting_provisions,
       e.notes
  FROM uk_legislation_effects e
  LEFT JOIN uk_legislation l ON l.id = e.affected_id
 WHERE e.affected_id IS NOT NULL;
