-- Polish lawyers: adwokaci (rejestradwokatow.pl) and radcowie prawni (rejestrradcow.pl),
-- contacts enriched from szukajradcy.pl. Filled by the collector (src/collector/).
-- Lives in public next to the pl_* corpus; the CRM tables live in schema attorney_crm_pl.
-- Design: docs/superpowers/specs/2026-11-08-attorney-crm-pl-design.md

CREATE TABLE IF NOT EXISTS public.pl_lawyers (
  lawyer_id          TEXT PRIMARY KEY,            -- 'adw:<id from the profile URL>' | 'radca:<entry number>'
  profession         TEXT NOT NULL CHECK (profession IN ('adwokat', 'radca')),
  surname            TEXT NOT NULL,
  given_names        TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'former')),
  status_raw         TEXT NOT NULL,
  chamber            TEXT,
  city               TEXT,
  postcode           TEXT,
  address            TEXT,
  office_name        TEXT,
  phone              TEXT,
  phone2             TEXT,
  email              TEXT,
  website            TEXT,
  contact_source     TEXT CHECK (contact_source IN ('register', 'szukajradcy', 'chamber', 'ceidg')),
  entry_number       TEXT,
  entry_date         DATE,
  practices          TEXT[] NOT NULL DEFAULT '{}',
  practice_tags_raw  TEXT[] NOT NULL DEFAULT '{}',
  profile_url        TEXT,
  directory_url      TEXT,
  list_seen_at       TIMESTAMPTZ NOT NULL,
  detail_fetched_at  TIMESTAMPTZ,
  raw                JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_pl_lawyers_status_surname ON public.pl_lawyers (status, surname);
CREATE INDEX IF NOT EXISTS idx_pl_lawyers_city ON public.pl_lawyers (city);
CREATE INDEX IF NOT EXISTS idx_pl_lawyers_chamber ON public.pl_lawyers (chamber);
CREATE INDEX IF NOT EXISTS idx_pl_lawyers_entry_number ON public.pl_lawyers (entry_number);
CREATE INDEX IF NOT EXISTS idx_pl_lawyers_practices ON public.pl_lawyers USING GIN (practices);

-- Resume state per collector source ('adwokaci-list', 'adwokaci-details', 'radcowie-list', 'szukajradcy').
CREATE TABLE IF NOT EXISTS public.pl_lawyers_crawl (
  source     TEXT PRIMARY KEY,
  cursor     JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 09.11.2026: two more contact sources, the chamber (OIRP) sites and CEIDG. Re-create the check so an
-- existing table accepts them; the file is re-applied whenever its hash changes.
ALTER TABLE public.pl_lawyers DROP CONSTRAINT IF EXISTS pl_lawyers_contact_source_check;
ALTER TABLE public.pl_lawyers ADD CONSTRAINT pl_lawyers_contact_source_check
  CHECK (contact_source IN ('register', 'szukajradcy', 'chamber', 'ceidg'));
