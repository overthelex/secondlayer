-- Portal Orzeczen ncourt-api: the national feed of common-court judgments.
-- pl_ncourt_index holds the feed's listing; the judgments themselves go into
-- pl_court_decisions (source = 'ncourt') only when SAOS and the HF import do
-- not already hold them. Applied by scripts/pl/harvest_ncourt.py.
CREATE TABLE IF NOT EXISTS pl_ncourt_index (
    id            text PRIMARY KEY,
    signature     text,
    decided_on    date,
    published_at  timestamptz,
    last_update   timestamptz,
    court_id      text,
    department_id text,
    types         text,
    loaded_update timestamptz,   -- last_update of the version we loaded
    fetch_status  smallint,      -- 200 loaded, else the failing HTTP code
    listed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pl_ncourt_sig ON pl_ncourt_index (signature, decided_on);

CREATE TABLE IF NOT EXISTS pl_ncourt_progress (
    id         int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    listed_to  date NOT NULL,    -- publication dates before this are listed
    updated_at timestamptz NOT NULL DEFAULT now()
);
