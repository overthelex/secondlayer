-- LEXAI-2191: search_public_spending(contractor_edrpou) matched c->>'code', a key the
-- spending.gov.ua documents do not have (the contractor's ЄДРПОУ/РНОКПП is
-- "identifier"), so the filter returned 0 for every value; the per-element EXISTS also
-- had no index and ran past the 15s budget on spending_acts (9.4M rows).
--
-- GIN over the identifiers alone; the tool queries
--   jsonb_path_query_array(contractors, '$[*].identifier') @> jsonb_build_array($1::text)
-- which this index serves. jsonb_path_ops is enough for @> and is the smaller opclass.
-- One CREATE INDEX CONCURRENTLY per file (see 211): the runner cannot wrap it in a
-- transaction. Companions: 241 addendums, 242 peny, 243 contracts.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_spending_acts_contractor_identifier
  ON spending_acts USING gin ((jsonb_path_query_array(contractors, '$[*].identifier')) jsonb_path_ops);
