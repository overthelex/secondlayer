-- Migration 285 (LEXAI-2297): debtors of banks liquidated by the Deposit Guarantee Fund (ФГВФО).
--
-- scripts/fgvfo/load_fgvfo.py loads two families of XLSX files from fg.gov.ua (opendata-sync runs it
-- weekly; the Fund updates them quarterly):
--   debtors  https://www.fg.gov.ua/borzhniki — one file per bank and list: borrowers that have not
--            repaid a debt set by a court decision whose claim the bank has not yet sold, split into
--            borrowers who are not bank managers / former shareholders and those who are (the second
--            list is «Відсутні» for every bank as of 01.10.2026). Case number, debtor name, debt as
--            the court stated it and its UAH amount.                      -> fgvfo_debtors
--   related  …/informatsiya-pro-kolishnikh-vlasnikiv-neplatospromozhnikh-bankiv-ta-povyazankh-iz-nimi-osib
--            — the Fund's damage claims against former owners and related persons of failed banks:
--            bank, case, proceeding type, amount claimed, number of defendants; defendants' names and
--            the amount awarded once a court has ruled.       -> fgvfo_related_claims / _defendants
--
-- The files carry names only. Persons are stored as name + match key (uaMatchKey of
-- mcp_openreyestr/src/services/edr-history/norm.ts); digits are removed from persons' names, so no
-- ID number or birth date is kept. A company gets debtor_edrpou only when an 8-digit code is written
-- in its name. Any link to ЄДР built from these names is a candidate, never a confirmed match.
--
-- Every file is one snapshot (fgvfo_snapshots); rows are never updated in place, so earlier quarters
-- stay queryable. The *_current views return the latest snapshot of each list.

CREATE TABLE IF NOT EXISTS fgvfo_snapshots (
    id             BIGSERIAL PRIMARY KEY,
    dataset        TEXT NOT NULL CHECK (dataset IN ('debtors', 'related')),
    list_key       TEXT NOT NULL,          -- debtors: '<file slug>:<borrowers|insiders>'; related: 'related'
    bank_name      TEXT,                   -- debtors: bank as the page names it
    file_sha256    TEXT NOT NULL,
    snapshot_date  DATE NOT NULL,          -- «станом на» date stated in the file
    source_url     TEXT,
    file_size      BIGINT,
    rows_parsed    INTEGER NOT NULL,
    rows_skipped   INTEGER NOT NULL DEFAULT 0,
    loaded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (dataset, file_sha256)
);
CREATE INDEX IF NOT EXISTS idx_fgvfo_snapshots_list
    ON fgvfo_snapshots(dataset, list_key, snapshot_date DESC, loaded_at DESC);

-- One row per debtor. A cell naming joint debtors ('А, Б (солідарний боржник)') becomes several rows
-- with the same row_no and the same debt: count debts by (snapshot_id, row_no), not by row.
CREATE TABLE IF NOT EXISTS fgvfo_debtors (
    id              BIGSERIAL PRIMARY KEY,
    snapshot_id     BIGINT NOT NULL REFERENCES fgvfo_snapshots(id) ON DELETE CASCADE,
    bank_name       TEXT,
    list_kind       TEXT NOT NULL CHECK (list_kind IN ('borrowers', 'insiders')),
    row_no          INTEGER NOT NULL,      -- № in the file
    debtor_ord      INTEGER NOT NULL DEFAULT 1,
    case_number     TEXT,                  -- as written (ЄУН such as 910/11783/16, or an old local number)
    debtor_name     TEXT NOT NULL,
    debtor_kind     TEXT NOT NULL CHECK (debtor_kind IN ('company', 'person', 'fop')),
    debtor_note     TEXT,                  -- role written next to the name, e.g. 'солідарний боржник'
    debtor_edrpou   CHAR(8),               -- only when written in the company name
    name_match_key  TEXT,
    debt_text       TEXT,                  -- debt as the court decision states it (currency, court fee, …)
    debt_uah        NUMERIC(18, 2),        -- UAH amount or UAH equivalent from the file
    UNIQUE (snapshot_id, row_no, debtor_ord)
);
CREATE INDEX IF NOT EXISTS idx_fgvfo_debtors_match_key ON fgvfo_debtors(name_match_key);
CREATE INDEX IF NOT EXISTS idx_fgvfo_debtors_edrpou ON fgvfo_debtors(debtor_edrpou) WHERE debtor_edrpou IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fgvfo_debtors_case ON fgvfo_debtors(case_number);

CREATE TABLE IF NOT EXISTS fgvfo_related_claims (
    id                BIGSERIAL PRIMARY KEY,
    snapshot_id       BIGINT NOT NULL REFERENCES fgvfo_snapshots(id) ON DELETE CASCADE,
    row_no            INTEGER NOT NULL,
    bank_name         TEXT NOT NULL,
    case_number       TEXT NOT NULL,
    proceeding_type   TEXT,                -- Господарське | Цивільне в кримінальному провадженні | …
    claim_uah         NUMERIC(18, 2),      -- amount the Fund claims
    defendants_count  INTEGER,
    awarded_text      TEXT,                -- amount awarded by the court, as written
    awarded_uah       NUMERIC(18, 2),
    UNIQUE (snapshot_id, row_no)
);
CREATE INDEX IF NOT EXISTS idx_fgvfo_related_claims_case ON fgvfo_related_claims(case_number);

-- Named only once a court has awarded damages; the awarded amount is joint for all defendants of a claim.
CREATE TABLE IF NOT EXISTS fgvfo_related_defendants (
    id                BIGSERIAL PRIMARY KEY,
    claim_id          BIGINT NOT NULL REFERENCES fgvfo_related_claims(id) ON DELETE CASCADE,
    ord               INTEGER NOT NULL,
    defendant_name    TEXT NOT NULL,
    defendant_kind    TEXT NOT NULL CHECK (defendant_kind IN ('company', 'person', 'fop')),
    defendant_edrpou  CHAR(8),
    name_match_key    TEXT,
    UNIQUE (claim_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_fgvfo_related_defendants_match_key ON fgvfo_related_defendants(name_match_key);

-- Latest snapshot of each list. A bank that drops off the debtors page keeps its last snapshot here:
-- is_latest_publication tells whether that snapshot has the newest «станом на» date of its dataset.
CREATE OR REPLACE VIEW fgvfo_latest_snapshots AS
SELECT DISTINCT ON (s.dataset, s.list_key)
       s.*,
       s.snapshot_date = MAX(s.snapshot_date) OVER (PARTITION BY s.dataset) AS is_latest_publication
  FROM fgvfo_snapshots s
 ORDER BY s.dataset, s.list_key, s.snapshot_date DESC, s.loaded_at DESC;

CREATE OR REPLACE VIEW fgvfo_debtors_current AS
SELECT d.*, s.snapshot_date, s.source_url, s.is_latest_publication
  FROM fgvfo_debtors d
  JOIN fgvfo_latest_snapshots s ON s.id = d.snapshot_id;

CREATE OR REPLACE VIEW fgvfo_related_current AS
SELECT c.id AS claim_id, c.bank_name, c.case_number, c.proceeding_type, c.claim_uah, c.defendants_count,
       c.awarded_text, c.awarded_uah, d.ord, d.defendant_name, d.defendant_kind, d.defendant_edrpou,
       d.name_match_key, s.snapshot_date, s.source_url
  FROM fgvfo_related_claims c
  JOIN fgvfo_latest_snapshots s ON s.id = c.snapshot_id
  LEFT JOIN fgvfo_related_defendants d ON d.claim_id = c.id;

COMMENT ON TABLE fgvfo_debtors IS
  'ФГВФО: боржники банків, що ліквідуються, за рішеннями суду (fg.gov.ua/borzhniki), знімок на файл. LEXAI-2297';
COMMENT ON TABLE fgvfo_related_claims IS
  'ФГВФО: позови до колишніх власників і пов''язаних із банком осіб, суми відшкодування. LEXAI-2297';
