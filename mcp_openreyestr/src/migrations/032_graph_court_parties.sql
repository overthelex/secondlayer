-- 032: relationship graph (030) — co-party edges from court decisions (LEXAI-2304).
--
-- The court decision parties (edrsr_parties, LEXAI-1760) live in the backend database, the graph
-- here. scripts/load-court-parties.ts copies the parties that carry an ЄДРПОУ printed in the
-- caption into graph.court_party, one year at a time; the graph builder (services/graph/court.ts)
-- reads this table only, so a build never needs a second database connection and a reload never
-- needs a graph build. Only 8-digit company codes cross: no names, no 10-digit РНОКПП (ФОП and
-- individuals), so no personal data is copied.
--
-- Edge kind co_party: company <-> company, one edge per pair of companies that were parties of
-- the same decisions (lower code -> higher code), attrs.roles counts the role pairs
-- ('plaintiff-defendant' = src was a plaintiff and dst a defendant), valid_from / valid_to = the
-- first / last decision date. Source 'edrsr'. The builder recreates graph.edge from its staging
-- DDL (builder.ts stageDdl); the constraints below keep a database built before 032 consistent.

DO $$ BEGIN
  IF to_regclass('graph.edge') IS NOT NULL THEN
    ALTER TABLE graph.edge DROP CONSTRAINT IF EXISTS edge_kind_check;
    ALTER TABLE graph.edge ADD CONSTRAINT edge_kind_check
      CHECK (kind IN ('founder', 'beneficiary', 'head', 'signer', 'registered_at', 'reg_neighbour', 'co_party'));
    ALTER TABLE graph.edge DROP CONSTRAINT IF EXISTS edge_source_check;
    ALTER TABLE graph.edge ADD CONSTRAINT edge_source_check
      CHECK (source IN ('edr_hist', 'edr_current', 'edrsr'));
  END IF;
END $$;

-- One row per (decision, party with a code): role 1 = позивач, 2 = відповідач, 3 = третя особа
-- (edrsr_parties.role); case_key = case number without blanks, lower case (one case, many decisions).
CREATE TABLE IF NOT EXISTS graph.court_party (
    doc_id        bigint   NOT NULL,
    adj_year      smallint NOT NULL,
    role          smallint NOT NULL,
    ord           smallint NOT NULL,
    edrpou        text     NOT NULL CHECK (edrpou ~ '^[0-9]{8}$'),
    justice_kind  smallint,
    court_code    integer,
    decided_on    date,
    case_number   text,
    case_key      text,
    loaded_on     date     NOT NULL DEFAULT current_date,
    PRIMARY KEY (adj_year, doc_id, role, ord)
);
CREATE INDEX IF NOT EXISTS court_party_doc ON graph.court_party (doc_id);

-- One row per loaded year: what was copied and from which state of the source.
CREATE TABLE IF NOT EXISTS graph.court_party_load (
    adj_year          smallint PRIMARY KEY,
    rows              integer NOT NULL,
    source_built_at   timestamptz,     -- edrsr_parties_coverage.built_at of the year when copied
    source_max_date   date,            -- newest decision date of the year in the source
    loaded_at         timestamptz NOT NULL DEFAULT now()
);
