-- Migration 284 (LEXAI-2296): НБУ — register of non-bank financial institutions and the ownership
-- of banks and non-bank institutions, for the company-relationship graph (owners of financial
-- companies).
--
-- nbu_banks (60 banks, NBU_BankInfo API) has no owners. After 01.07.2020 the State Register of
-- Financial Institutions passed from Нацкомфінпослуг to the NBU, which publishes it and the
-- qualifying-holding lists as xlsx files. scripts/nbu-fin/load_nbu_fin.py loads them
-- (opendata-sync runs it weekly):
--
--   list                 source (bank.gov.ua)                                              table
--   ree_fu               /files/N_bank/r_drfu/ree_fu.xlsx  sheet ree_fu                     nbu_fin_institutions
--                        same file, sheet lic                                              nbu_fin_licenses
--   nonbank_approved     /files/N_bank/p_vlasnykiv_pohodzheni/pv_pohodjen.xlsx             nbu_fin_ownership
--   nonbank_no_voting    /files/N_bank/p_vlasnykiv_bez_prava_holosu/pv_bpg.xlsx            nbu_fin_ownership
--   bank_decisions       /files/SP/subpar.xlsx (decisions under art. 34-1 Law on Banks)    nbu_fin_ownership
--   bank_ownership_docs  /ua/supervision/registration/shareholders/<МФО> (PDF index)       nbu_bank_ownership_documents
--
-- The yearly bank ownership structures («Відомості про власників істотної участі»,
-- «остаточні ключові учасники», scheme) exist only as PDFs (text layer, free-form tables): only
-- their index (bank, as-of date, URL) is loaded here, not their contents.

-- ─── Load journal ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nbu_fin_snapshots (
    list_name      TEXT NOT NULL,          -- ree_fu | nonbank_approved | nonbank_no_voting | bank_decisions | bank_ownership_docs
    file_sha256    TEXT NOT NULL,
    snapshot_date  DATE,                   -- «Станом на» / «Дата останніх змін» stated in the file
    source_url     TEXT,
    file_size      BIGINT,
    rows_parsed    INTEGER,
    rows_upserted  INTEGER,
    rows_removed   INTEGER,
    loaded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (list_name, file_sha256)
);
CREATE INDEX IF NOT EXISTS idx_nbu_fin_snapshots_loaded
    ON nbu_fin_snapshots(list_name, loaded_at DESC);

-- ─── Financial institutions (Державний реєстр фінансових установ + реєстр осіб, які не є
--     фінансовими установами, але мають право надавати окремі фінансові послуги) ────────────
-- An institution that drops out of the register is kept with in_register = false.
CREATE TABLE IF NOT EXISTS nbu_fin_institutions (
    edrpou               TEXT PRIMARY KEY CHECK (edrpou ~ '^[0-9]{8}$'),
    name                 TEXT NOT NULL,
    institution_type     TEXT,             -- Фінансова компанія | Кредитна спілка | Ломбард | Страхова компанія | ...
    register_name        TEXT,             -- which of the two registers
    address              TEXT,
    head_name            TEXT,
    registered_date      DATE,             -- «Дата внесення до відповідного реєстру»
    in_register          BOOLEAN NOT NULL DEFAULT TRUE,
    first_seen_snapshot  DATE,
    last_seen_snapshot   DATE,
    removed_detected     DATE,             -- first snapshot without the institution
    snapshot_date        DATE,
    source_url           TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nbu_fin_institutions_type ON nbu_fin_institutions(institution_type);
CREATE INDEX IF NOT EXISTS idx_nbu_fin_institutions_name ON nbu_fin_institutions(lower(name));

-- Licences / services / insurance classes: one row per line of sheet «lic», replaced per snapshot.
CREATE TABLE IF NOT EXISTS nbu_fin_licenses (
    id                  BIGSERIAL PRIMARY KEY,
    edrpou              TEXT NOT NULL CHECK (edrpou ~ '^[0-9]{8}$'),
    institution_name    TEXT,
    institution_type    TEXT,
    license_status      TEXT,              -- Діюча | Зупинена | ...
    license_name        TEXT,
    service             TEXT,              -- послуга / клас страхування / ризик
    insurance_type      TEXT,              -- обов'язкове | добровільне | '-'
    issued_date         DATE,
    service_start_date  DATE,
    validity            TEXT,              -- «необмежений» or a date as published
    snapshot_date       DATE,
    source_url          TEXT,
    loaded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nbu_fin_licenses_edrpou ON nbu_fin_licenses(edrpou);

-- ─── Ownership edges: institution -> owner ─────────────────────────────────
-- Replaced per source_list on every snapshot. institution_edrpou is NULL for a bank decision
-- whose bank could not be matched to a current bank (liquidated banks).
CREATE TABLE IF NOT EXISTS nbu_fin_ownership (
    id                    BIGSERIAL PRIMARY KEY,
    source_list           TEXT NOT NULL,   -- nonbank_approved | nonbank_no_voting | bank_decisions
    institution_kind      TEXT NOT NULL,   -- bank | nonbank
    institution_edrpou    TEXT CHECK (institution_edrpou ~ '^[0-9]{8}$'),
    institution_name      TEXT NOT NULL,
    owner_name            TEXT NOT NULL,
    owner_kind            TEXT,            -- person | legal_entity | joint (heuristic on the name)
    owner_code            TEXT,            -- ЄДРПОУ (8 digits) or a foreign registration number
    owner_code_kind       TEXT,            -- edrpou | foreign_registration
    owner_country         TEXT,
    share_direct          NUMERIC(12,6),   -- %
    share_indirect        NUMERIC(12,6),
    share_total           NUMERIC(12,6),
    is_direct             BOOLEAN,
    is_indirect           BOOLEAN,
    participation         TEXT,            -- participation type as published
    action                TEXT,            -- Набуття | Збільшення
    decision              TEXT,            -- Погоджено | Заборонено (bank decisions); NULL = approved list
    decision_date         DATE,
    decision_number       TEXT,
    publication_date      DATE,
    relation_description  TEXT,
    restriction_basis     TEXT,            -- nonbank_no_voting: why voting rights are barred
    trustee_name          TEXT,            -- nonbank_no_voting: appointed trustee
    trustee_appointed     DATE,
    note                  TEXT,
    as_of_date            DATE,            -- date the stated share refers to (decision / listing date)
    snapshot_date         DATE,
    source_url            TEXT,
    loaded_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nbu_fin_ownership_institution ON nbu_fin_ownership(institution_edrpou);
CREATE INDEX IF NOT EXISTS idx_nbu_fin_ownership_owner_code ON nbu_fin_ownership(owner_code)
    WHERE owner_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nbu_fin_ownership_owner_name ON nbu_fin_ownership(lower(owner_name));
CREATE INDEX IF NOT EXISTS idx_nbu_fin_ownership_source ON nbu_fin_ownership(source_list);

-- ─── Index of the bank ownership-structure PDFs ────────────────────────────
-- One row per published PDF (bank, as-of date). Kept when it disappears from the page.
CREATE TABLE IF NOT EXISTS nbu_bank_ownership_documents (
    pdf_url        TEXT PRIMARY KEY,
    bank_mfo       TEXT NOT NULL,
    bank_name      TEXT NOT NULL,          -- page title
    bank_label     TEXT,                   -- link text on the index page
    bank_edrpou    TEXT CHECK (bank_edrpou ~ '^[0-9]{8}$'),
    bank_group     TEXT,                   -- index section: operating, reorganised, in liquidation, ...
    name_history   TEXT,                   -- «Перелік усіх назв, які мав банк»
    as_of_date     DATE,
    first_seen     DATE NOT NULL DEFAULT CURRENT_DATE,
    last_seen      DATE NOT NULL DEFAULT CURRENT_DATE
);
CREATE INDEX IF NOT EXISTS idx_nbu_bank_ownership_documents_mfo
    ON nbu_bank_ownership_documents(bank_mfo, as_of_date DESC);
CREATE INDEX IF NOT EXISTS idx_nbu_bank_ownership_documents_edrpou
    ON nbu_bank_ownership_documents(bank_edrpou) WHERE bank_edrpou IS NOT NULL;
