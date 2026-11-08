-- Migration 191: Polish legislation text, article by article.
--
-- 39,110 of 97,681 Dziennik Ustaw acts serve text.html (40.0%). Monitor Polski
-- serves none - 0 of 66,532, checked across all 92 MP year listings - so MP is
-- a register-and-graph corpus and no text pipeline is built for it. DU coverage
-- by era: 1918-1989 11.3%, 1990-1999 15.7%, 2000-2011 16.9%, 2012-2023 99.7%,
-- 2024 100%, 2025-2026 0%. The recent zero is a publication lag, not a
-- permanent hole, which is why sync_eli_changes.py must re-poll acts previously
-- recorded as HTML-less instead of trusting text_html once.
--
-- The API also exposes /struct, a nested tree whose node ids are byte-identical
-- to the id= attribute on the <div class="unit unit_arti"> wrappers in the HTML.
-- Extraction therefore walks struct and looks each node up in the DOM, rather
-- than pattern-matching headings the way the Ukrainian splitter had to. That is
-- not a stylistic preference: DU/2020/1320 carries three <div data-id="arti_5",
-- "arti_6", "arti_86"> inside the obwieszczenie's own footnotes, which struct
-- correctly omits, so a regex over the same HTML returns 497 articles for a
-- 494-article code.
--
-- The article PK ends in `ord` rather than the article number, for the reason
-- nl_law_articles gives: labels repeat. DU/1964/93 lists
-- book_trzecia-titl_XI-bran_I-arti_538 twice (2,290 struct nodes, 2,289
-- distinct ids) and DU/1997/553 lists `none_` twice. Keying on the label would
-- reject the whole insert batch.

-- ---------------------------------------------------------------------------
-- One row per article per snapshot. `text` includes the article's own
-- paragraf / ustep / punkt / litera children, because that is the unit Polish
-- practice cites and quotes. Sub-article addressing is served by pl_act_units,
-- which stores character offsets into this text rather than a second copy of it.
--
-- symbol vs struct_id: struct ids are NOT stable across snapshots. Art. 415 KC
-- is book_trzecia-titl_VI-arti_415 in the 1964 text and
-- book_TRZECIA-titl_VI-arti_415 in the 2023 consolidation - the book name
-- changes case. Cross-snapshot article identity therefore keys on art_no,
-- derived from the snapshot-local symbol, never on the path.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pl_act_articles (
    act_eli       TEXT NOT NULL,
    snapshot_eli  TEXT NOT NULL,
    ord           INTEGER NOT NULL,     -- document order within the snapshot
    symbol        TEXT NOT NULL,        -- 'arti_304_4'   - stable across snapshots
    struct_id     TEXT NOT NULL,        -- 'bran_PIETNASTY-arti_304_4' - snapshot-local
    art_no        TEXT NOT NULL,        -- '304^4'        - canonical form
    art_display   TEXT NOT NULL,        -- 'Art. 304(4).' - as rendered
    art_sort_1    INTEGER,              -- 304
    art_sort_2    INTEGER,              -- 4, NULL when there is no superscript
    art_title     TEXT,                 -- article heading where one exists
    text          TEXT NOT NULL,
    n_chars       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (act_eli, snapshot_eli, ord)
);

-- "what did art. 415 of the civil code say" - the lookup that matters
CREATE INDEX IF NOT EXISTS idx_pl_articles_lookup
    ON pl_act_articles (act_eli, art_no, snapshot_eli);
CREATE INDEX IF NOT EXISTS idx_pl_articles_snapshot
    ON pl_act_articles (snapshot_eli, ord);
CREATE INDEX IF NOT EXISTS idx_pl_articles_symbol
    ON pl_act_articles (act_eli, symbol);

-- ---------------------------------------------------------------------------
-- The struct tree, all levels, no text. Two jobs:
--   1. navigation: ksiega / czesc / tytul / dzial / rozdzial / oddzial headings
--   2. sub-article addressing: "art. 415 § 1" resolves to a (char_from, char_to)
--      slice of pl_act_articles.text, so no provision is stored twice.
-- Node types seen: part, book, titl, bran, chpt, schp, arti, para, pint, lett,
-- pass, none.
--
-- in_annex marks nodes under a top-level part whose title starts with
-- "Zalacznik". On a consolidating obwieszczenie the law IS the annex: DU/2020/1320
-- puts all 494 arti nodes under part_2 ("Zalacznik - Tekst jednolity ustawy ...
-- Kodeks pracy") and none under part_1 ("Tresc obwieszczenia").
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pl_act_units (
    snapshot_eli  TEXT NOT NULL,
    ord           INTEGER NOT NULL,     -- preorder position in the struct tree
    parent_ord    INTEGER,
    depth         SMALLINT NOT NULL,
    struct_id     TEXT NOT NULL,
    symbol        TEXT,
    unit_type     TEXT NOT NULL,
    name          TEXT,
    title         TEXT,
    article_ord   INTEGER,              -- pl_act_articles.ord of the enclosing arti
    char_from     INTEGER,              -- offset into that article's text
    char_to       INTEGER,
    in_annex      BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (snapshot_eli, ord)
);

CREATE INDEX IF NOT EXISTS idx_pl_units_art
    ON pl_act_units (snapshot_eli, article_ord) WHERE article_ord IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pl_units_type
    ON pl_act_units (snapshot_eli, unit_type);

-- ---------------------------------------------------------------------------
-- The fetch record. EVERY snapshot gets a row, success or not, so that "never
-- downloaded" and "downloaded, came back empty" are never the same state - the
-- rule migration 182 set for nl_law_edition_texts.
--
-- http_status carries our verdicts above the HTTP range, the npa.edition idiom:
--   200  ok
--   404  gone
--   599  network failure / timeout after all retries
--   900  HTTP 200 with a zero-byte body        <- the dominant Polish failure mode
--   901  HTTP 200, non-empty, but no <h1 and no class="unit " - not an act render
--   902  act declares textHTML=true but /struct returned 404
--   903  not attempted: the source declares no HTML (textHTML=false). Every MP
--        act and 58,571 DU acts land here. This is NOT a failure. It is the
--        honest statement that no machine-readable text was ever published, and
--        it is what distinguishes a gap in the source from a gap in our harvest.
--        Konstytucja RP DU/1997/483 is the most recognisable instance: no HTML,
--        /struct 404, text.html 200-with-zero-bytes, PDF only.
--   904  struct declared N articles in scope, extraction produced fewer
--   905  the label parsed from the DOM disagrees with the struct symbol
--
-- `text` holds the whole cleaned document only where article extraction found
-- nothing, so a provision is never stored twice.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pl_snapshot_texts (
    snapshot_eli     TEXT PRIMARY KEY,
    act_eli          TEXT NOT NULL,
    http_status      SMALLINT NOT NULL,
    html_bytes       INTEGER,
    struct_bytes     INTEGER,
    struct_articles  INTEGER,           -- arti nodes struct declared, in annex scope
    article_count    INTEGER NOT NULL DEFAULT 0,   -- articles actually stored
    unit_count       INTEGER NOT NULL DEFAULT 0,
    text             TEXT,
    n_chars          INTEGER NOT NULL DEFAULT 0,
    text_hash        TEXT,              -- sha256 of the cleaned text; cross-snapshot dedup
    label_mismatches INTEGER NOT NULL DEFAULT 0,
    nonmonotonic     INTEGER NOT NULL DEFAULT 0,
    annex_part_id    TEXT,              -- 'part_2' on a consolidation, NULL otherwise
    fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pl_snapshot_texts_bad
    ON pl_snapshot_texts (http_status) WHERE http_status <> 200;
CREATE INDEX IF NOT EXISTS idx_pl_snapshot_texts_act
    ON pl_snapshot_texts (act_eli);
CREATE INDEX IF NOT EXISTS idx_pl_snapshot_texts_hash
    ON pl_snapshot_texts (text_hash) WHERE text_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The only sanctioned way to answer "what did article X say on date D".
--
-- It returns the nearest published snapshot at or before the date AND the
-- amendments that took effect between that snapshot and the date. There is no
-- argument that suppresses the second half, because a caller who sees only the
-- text would reasonably believe it was the law on that date, and for Poland
-- that is usually false.
--
--   exact          the snapshot is dated at or before D and no amendment took
--                  effect in between - the text IS the law as at D
--   stale          the nearest snapshot is followed by N amendments effective
--                  by D; the text is the closest published one and is behind
--   no_text        a snapshot exists but its text was never published in a
--                  machine-readable form (verdict 903)
--   pre_enactment  D precedes the act's first published text
--
-- Verified live on 2026-08-14:
--   pl_article_as_of('DU/1974/141','1','2019-06-01')
--     -> exact, DU/2019/1040, exact_on 2019-05-09, 0 amendments in between
--   pl_article_as_of('DU/1974/141','1','2020-06-01')
--     -> stale, with a non-empty amendment list
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pl_article_as_of(
    p_act TEXT, p_art_no TEXT, p_date DATE)
RETURNS TABLE (
    confidence        TEXT,
    snapshot_eli      TEXT,
    snapshot_kind     TEXT,
    exact_on          DATE,
    days_before_query INTEGER,
    art_no            TEXT,
    art_display       TEXT,
    text              TEXT,
    amendments_since  JSONB,
    next_snapshot_eli TEXT,
    next_snapshot_on  DATE
) LANGUAGE sql STABLE AS $fn$
WITH s AS (
    SELECT * FROM pl_act_snapshots
    WHERE act_eli = p_act AND exact_on IS NOT NULL AND exact_on <= p_date
    ORDER BY exact_on DESC, seq DESC
    LIMIT 1
), nx AS (
    SELECT * FROM pl_act_snapshots
    WHERE act_eli = p_act AND exact_on > p_date
    ORDER BY exact_on ASC, seq ASC
    LIMIT 1
), am AS (
    SELECT jsonb_agg(jsonb_build_object(
               'eli', r.dst_eli,
               'effective_date', r.effective_date,
               'title', a.title) ORDER BY r.effective_date) AS j,
           count(*) AS n
    FROM pl_act_references r
    LEFT JOIN pl_acts a ON a.eli = r.dst_eli
    WHERE r.src_eli = p_act
      AND r.category = 'Akty zmieniające'
      AND r.effective_date > (SELECT exact_on FROM s)
      AND r.effective_date <= p_date
)
SELECT
    CASE WHEN art.text IS NULL                       THEN 'no_text'
         WHEN coalesce((SELECT n FROM am), 0) = 0    THEN 'exact'
         ELSE 'stale' END,
    s.snapshot_eli, s.snapshot_kind, s.exact_on,
    (p_date - s.exact_on)::int,
    art.art_no, art.art_display, art.text,
    coalesce((SELECT j FROM am), '[]'::jsonb),
    (SELECT snapshot_eli FROM nx), (SELECT exact_on FROM nx)
FROM s
LEFT JOIN pl_act_articles art
       ON art.snapshot_eli = s.snapshot_eli
      AND art.art_no = p_art_no
UNION ALL
-- No snapshot at or before the date: say so, rather than returning zero rows,
-- which a caller can too easily read as "no such article".
SELECT 'pre_enactment', NULL, NULL, NULL, NULL, p_art_no, NULL, NULL,
       '[]'::jsonb,
       (SELECT snapshot_eli FROM nx), (SELECT exact_on FROM nx)
WHERE NOT EXISTS (SELECT 1 FROM s);
$fn$;

-- Per-act chain, for display and for the audit's chain-integrity check.
CREATE OR REPLACE VIEW pl_act_timeline AS
SELECT s.act_eli, a.title, s.seq, s.snapshot_eli, s.snapshot_kind,
       s.exact_on, s.exact_on_src, s.drift_from, s.valid_to,
       s.source_expiration, s.amendments_after, s.has_html,
       t.http_status, t.article_count
FROM pl_act_snapshots s
LEFT JOIN pl_acts a ON a.eli = s.act_eli
LEFT JOIN pl_snapshot_texts t ON t.snapshot_eli = s.snapshot_eli
ORDER BY s.act_eli, s.seq;
