-- Fill uk_court_decision_fts for judgments loaded before migration 221.
--
-- Idempotent and resumable: each batch takes only ids that have no vector yet and
-- commits on its own, so an interrupted run continues where it stopped. Measured
-- on prod: ~13 ms per judgment, ~12 min for the 54,453 rows.
--
--   docker exec -i pg-lawrider psql -U secondlayer -d secondlayer_prod \
--     < mcp_backend/scripts/uk-judgment-fts-backfill.sql
--
-- "word is too long to be indexed" notices are expected and harmless.

SET client_min_messages = warning;

DO $$
DECLARE
    n INT;
    total INT := 0;
BEGIN
    LOOP
        INSERT INTO uk_court_decision_fts (id, fts)
        SELECT d.id, uk_court_decision_tsv(d.parties, d.abstract, d.full_text)
          FROM uk_court_decisions d
         WHERE NOT EXISTS (SELECT 1 FROM uk_court_decision_fts f WHERE f.id = d.id)
         ORDER BY d.id
         LIMIT 1000
        ON CONFLICT (id) DO NOTHING;
        GET DIAGNOSTICS n = ROW_COUNT;
        EXIT WHEN n = 0;
        total := total + n;
        RAISE WARNING 'uk_court_decision_fts: +% (total %)', n, total;
        COMMIT;
    END LOOP;
END
$$;

SELECT (SELECT count(*) FROM uk_court_decisions)    AS judgments,
       (SELECT count(*) FROM uk_court_decision_fts) AS vectors;
