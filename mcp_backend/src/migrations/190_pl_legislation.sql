-- Migration 190: Polish legislation register and amendment graph (Sejm ELI API)
--
-- Source: https://api.sejm.gov.pl/eli, no auth, JSON. 164,213 acts as of
-- 2026-08-14: Dziennik Ustaw (DU) 97,681 and Monitor Polski (MP) 66,532,
-- enumerated from 197 year listings plus one detail call each.
--
-- Shape follows nl_laws / nl_law_editions (migration 181), which in turn follows
-- the Ukrainian legislation_editions, rather than inventing a third vocabulary
-- for the same idea. The verdict-code idiom on the text side comes from
-- npa.edition. Tables live in public alongside pl_court_decisions (migration
-- 151); the separate `npa` schema exists only because that corpus had to shadow
-- live `legislation*` tables until cutover, and there is no Polish incumbent.
--
-- What Poland does differently, and what this schema is shaped around: there is
-- no point-in-time service. The only texts that exist are the one published on
-- promulgation ("tekst ogloszony", served under the act's own ELI) and one per
-- "obwieszczenie w sprawie ogloszenia jednolitego tekstu" (each served under the
-- OBWIESZCZENIE's ELI, not the base act's). Verified: DU/1974/141/text.html is
-- the 1974 Kodeks pracy, 8 hits for "socjalistyczn"; DU/2020/1320/text.html is
-- the 2020 consolidation, 0 hits for "socjalistyczn" and 12 for "monitoring".
--
-- So this schema stores published snapshots and the full amendment edge set, and
-- refuses to interpolate between them. See pl_act_snapshots.

-- ---------------------------------------------------------------------------
-- One row per ELI address. Includes amending acts and obwieszczenia: they are
-- acts, they have their own Dz.U. position, and excluding them would break the
-- reference graph. is_consolidation / consolidates_eli exist so that "how many
-- Polish laws are there" is not answered by counting a law once per
-- consolidation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pl_acts (
    eli               TEXT PRIMARY KEY,        -- 'DU/1964/93'
    publisher         TEXT NOT NULL,           -- DU | MP
    year              INTEGER NOT NULL,
    pos               INTEGER NOT NULL,
    volume            INTEGER,
    address           TEXT,                    -- 'WDU19640160093'
    display_address   TEXT,                    -- 'Dz.U. 1964 nr 16 poz. 93'
    act_type          TEXT,                    -- Ustawa | Rozporzadzenie | Obwieszczenie ...
    title             TEXT,
    previous_titles   TEXT[],
    status            TEXT,                    -- 'akt posiada tekst jednolity' ...
    in_force          TEXT,                    -- IN_FORCE | NOT_IN_FORCE | NULL
    announcement_date DATE,                    -- data aktu
    promulgation      DATE,                    -- data ogloszenia w dzienniku
    entry_into_force  DATE,
    valid_from        DATE,
    repeal_date       DATE,
    expiration_date   DATE,
    -- "stan prawny na dzien". Set on consolidating obwieszczenia, NULL on base
    -- acts. This is the field that makes the temporal answer computable instead
    -- of guessed; see pl_act_snapshots.exact_on.
    legal_status_date DATE,
    change_date       TIMESTAMPTZ,             -- source-side last modification; drives resync
    text_html         BOOLEAN NOT NULL DEFAULT false,
    text_pdf          BOOLEAN NOT NULL DEFAULT false,
    texts             JSONB,                   -- [{fileName,type}], type H|O|I|U|T
    keywords          TEXT[],
    keywords_names    TEXT[],
    released_by       TEXT[],
    obligated         TEXT[],
    authorized_body   TEXT[],
    directives        JSONB,                   -- EU directives implemented
    prints            JSONB,                   -- Sejm print numbers
    -- Derived by build_pl_snapshots.sql from pl_act_references, NOT from the
    -- title. 12% of DU obwieszczenia are not consolidations at all, and title
    -- matching would additionally have to survive 1930s orthography.
    is_consolidation  BOOLEAN NOT NULL DEFAULT false,   -- has 'Tekst jednolity dla aktu'
    consolidates_eli  TEXT,                             -- the base act it consolidates
    amends_count      INTEGER NOT NULL DEFAULT 0,
    amended_by_count  INTEGER NOT NULL DEFAULT 0,
    snapshot_count    INTEGER NOT NULL DEFAULT 0,       -- meaningful on base acts only
    detail_fetched_at TIMESTAMPTZ,
    imported_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pl_acts_pub_year ON pl_acts (publisher, year, pos);
CREATE INDEX IF NOT EXISTS idx_pl_acts_type     ON pl_acts (act_type);
CREATE INDEX IF NOT EXISTS idx_pl_acts_status   ON pl_acts (status);
CREATE INDEX IF NOT EXISTS idx_pl_acts_keywords ON pl_acts USING GIN (keywords);
CREATE INDEX IF NOT EXISTS idx_pl_acts_consol   ON pl_acts (consolidates_eli)
    WHERE consolidates_eli IS NOT NULL;
-- the resync worklist: acts whose source-side changeDate moved past our fetch
CREATE INDEX IF NOT EXISTS idx_pl_acts_changed  ON pl_acts (change_date DESC);
-- the text-harvest worklist is an anti-join filtered on this
CREATE INDEX IF NOT EXISTS idx_pl_acts_html     ON pl_acts (eli) WHERE text_html;
-- the Stage-1 worklist
CREATE INDEX IF NOT EXISTS idx_pl_acts_nodetail ON pl_acts (eli)
    WHERE detail_fetched_at IS NULL;

-- ---------------------------------------------------------------------------
-- The reference graph, one row per edge, category kept verbatim in Polish.
--
-- Categories observed so far:
--   Akty zmieniajace / Akty zmienione            (amendment, both directions)
--   Akty uchylajace / Akty uchylone / Akty uznane za uchylone
--   Inf. o tekscie jednolitym / Tekst jednolity dla aktu
--   Nowelizacje po tekscie jednolitym
--   Akty wykonawcze / Podstawa prawna / Podstawa prawna z art.
--   Przepisy wprowadzajace / Uchylenia wynikajace z / Odeslania
--   Orzeczenie TK / Orzeczenie TK dla aktu / Sprostowanie
--
-- Storing the label verbatim rather than a normalised enum is deliberate: the
-- source adds categories, and an edge whose category we do not yet understand
-- must survive the load instead of being silently dropped.
--
-- These edges are read from the act detail payload, which inlines them. The
-- separate /references endpoint returns the same set - verified byte-identical
-- on DU/1964/93 across all five categories (223/223, 113/113, 11/11, 25/25,
-- 1/1) - so it is not fetched, saving 164,213 requests.
--
-- effective_date is the API's `date` on an entry. On 'Akty zmieniajace' it is
-- the amendment's entry into force and is what pl_article_as_of() builds its
-- answer from. Populated on 100% of the 455 edges checked across KC/KP/KK/KPA,
-- and it carries future dates (KC has one at 2028-11-01).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pl_act_references (
    src_eli        TEXT NOT NULL,   -- act on whose detail payload the entry appeared
    category       TEXT NOT NULL,
    dst_eli        TEXT NOT NULL,
    effective_date DATE,
    art_ref        TEXT,            -- 'Podstawa prawna z art.' carries a provision string
    imported_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (src_eli, category, dst_eli)
);

CREATE INDEX IF NOT EXISTS idx_pl_refs_dst ON pl_act_references (dst_eli, category);
-- the hot path: "amendments to act X effective in (a, b]"
CREATE INDEX IF NOT EXISTS idx_pl_refs_amend
    ON pl_act_references (src_eli, effective_date)
    WHERE category = 'Akty zmieniające';

-- ---------------------------------------------------------------------------
-- THE TEMPORAL TABLE. One row per published text of one law.
--
--   act_eli       the law's identity: ALWAYS the base act, never the obwieszczenie
--   snapshot_eli  the act that physically published this text
--
-- For the original text the two are equal. For a consolidated text snapshot_eli
-- is the obwieszczenie and act_eli is the target of its 'Tekst jednolity dla
-- aktu' reference. So counting laws is count(DISTINCT act_eli) and counting
-- texts is count(*), and neither can be got wrong by accident.
--
-- exact_on is the ONE date on which this text is exactly the law in force:
--   ogloszony  -> entry_into_force, falling back to promulgation
--   jednolity  -> legal_status_date, falling back to announcement_date
-- The API publishes legal_status_date precisely so this is not a guess. Ten of
-- the eleven Kodeks pracy snapshots carry it; DU/1998/94 does not, hence the
-- fallback and the exact_on_src column recording which was used.
--
-- valid_to is DERIVED as the next snapshot's exact_on minus one day, NOT taken
-- from the source's expirationDate. They disagree systematically and on
-- purpose: expirationDate is the date the OBWIESZCZENIE was superseded, which
-- is the next one's promulgation, so consecutive consolidated texts overlap by
-- weeks or months (KP: DU/2019/1040 expires 2020-07-30 but DU/2020/1320 is
-- exact from 2020-06-18). Overlapping intervals cannot answer "which text for
-- date D"; max(exact_on) <= D can. source_expiration is kept beside it so the
-- disagreement is auditable rather than quietly resolved.
--
-- drift_from is the honesty column: the effective date of the first amendment
-- landing after exact_on. On [exact_on, drift_from) the text is exact. On
-- [drift_from, valid_to] it is the nearest published text and is known to be
-- behind by amendments_after edges. There is no third state and no
-- reconstruction.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pl_act_snapshots (
    act_eli           TEXT NOT NULL,
    snapshot_eli      TEXT NOT NULL,
    seq               INTEGER NOT NULL,        -- 0.. in exact_on order
    snapshot_kind     TEXT NOT NULL,           -- ogloszony | jednolity
    exact_on          DATE,
    exact_on_src      TEXT,                    -- entryIntoForce | promulgation |
                                               -- legalStatusDate | announcementDate | unknown
    valid_to          DATE,                    -- NULL = latest published snapshot
    source_expiration DATE,
    drift_from        DATE,
    amendments_after  INTEGER NOT NULL DEFAULT 0,
    has_html          BOOLEAN NOT NULL DEFAULT false,
    text_url          TEXT,                    -- .../acts/{snapshot_eli}/text.html
    pdf_file          TEXT,                    -- fallback: type T or U filename
    PRIMARY KEY (act_eli, snapshot_eli)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pl_snap_seq ON pl_act_snapshots (act_eli, seq);
CREATE INDEX IF NOT EXISTS idx_pl_snap_asof  ON pl_act_snapshots (act_eli, exact_on DESC);
CREATE INDEX IF NOT EXISTS idx_pl_snap_eli   ON pl_act_snapshots (snapshot_eli);
CREATE INDEX IF NOT EXISTS idx_pl_snap_nohtml ON pl_act_snapshots (act_eli) WHERE NOT has_html;

-- ---------------------------------------------------------------------------
-- pl_court_decisions predates this work (migration 151) and was loaded from
-- three snapshot sources with no natural key: row ids were built from the
-- position of the row inside a parquet file ("hf-pl-court-raw-12098-train_08_of_9"),
-- so a new dataset revision duplicates the corpus instead of updating it, and
-- the loader used ON CONFLICT DO NOTHING, so bad text could never be repaired.
--
-- judgment_id is Portal Orzeczen's own identifier, e.g.
-- "152515050001006_II_K_000202_2017_Uz_2017-06-27_001". It is what makes the
-- import idempotent and what lets SAOS and pl-court-raw rows describing the
-- same judgment be collapsed. The UNIQUE index is created CONCURRENTLY in the
-- companion file, because this table is 105 GB.
-- ---------------------------------------------------------------------------
ALTER TABLE pl_court_decisions ADD COLUMN IF NOT EXISTS judgment_id TEXT;
ALTER TABLE pl_court_decisions ADD COLUMN IF NOT EXISTS text_status TEXT;
