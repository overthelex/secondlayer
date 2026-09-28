-- Migration 221: stored full-text vectors for the UK judgments (uk_search_judgments)
--
-- idx_uk_court_fts finds matches fast (14-31 ms on prod) but cannot RANK them: a
-- GIN index stores no weights, so ts_rank_cd has to re-run to_tsvector over each
-- matching judgment, ~56K characters on average. Measured on prod 2026-09-28:
-- 516 hits took 22.8 s to rank, and a common word ("contract") matches 21,889
-- judgments. The same ranking over a stored tsvector took 0.19 s for 926 hits.
--
-- Side table rather than a new column on uk_court_decisions: that table is 1.6 GB
-- with nine indexes including the GIN, and backfilling a column would rewrite
-- every row into every index. See 197, which did exactly that and took minutes.
--
-- ⚠ This migration only creates the structure. The trigger keeps new and edited
-- judgments current; the rows already in uk_court_decisions are filled by
-- mcp_backend/scripts/uk-judgment-fts-backfill.sql (~12 min on prod), which is
-- kept out of the migration so a deploy is not held behind it.

CREATE TABLE IF NOT EXISTS uk_court_decision_fts (
    -- ON DELETE CASCADE: a judgment withdrawn from the holding (licence principle
    -- 9) must not stay findable through its search vector.
    id   TEXT PRIMARY KEY REFERENCES uk_court_decisions (id) ON DELETE CASCADE,
    fts  TSVECTOR NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_uk_court_decision_fts
    ON uk_court_decision_fts USING gin (fts);

-- Same expression as idx_uk_court_fts, so the two can never disagree about what a
-- judgment contains.
CREATE OR REPLACE FUNCTION uk_court_decision_fts_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO uk_court_decision_fts (id, fts)
    VALUES (NEW.id, to_tsvector('english',
            COALESCE(NEW.parties, '') || ' ' || COALESCE(NEW.abstract, '') || ' ' ||
            COALESCE(NEW.full_text, '')))
    ON CONFLICT (id) DO UPDATE SET fts = EXCLUDED.fts;
    RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_uk_court_decision_fts ON uk_court_decisions;
CREATE TRIGGER trg_uk_court_decision_fts
    AFTER INSERT OR UPDATE OF parties, abstract, full_text ON uk_court_decisions
    FOR EACH ROW EXECUTE FUNCTION uk_court_decision_fts_sync();
