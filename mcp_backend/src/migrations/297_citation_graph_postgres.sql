-- 297_citation_graph_postgres.sql  (LEXAI-2323)
--
-- The citation graph moves from Neo4j to Postgres. These are the layers Postgres did
-- not have; CitationGraphService reads them (see citation-graph-service.ts).
--
--   decision_statute_citations   decision -> statute article, one row per
--                                (doc, citation_type, law_number, law_article). Filled by
--                                scripts/citation-graph/rebuild-case-edges.py --layer statute
--                                over the FULL text of every decision (Neo4j's CITES_ARTICLE
--                                came from an older 10,000-character extraction).
--   statute_article_stats        per (law_number, law_article): total citations and distinct
--                                citing decisions; the old (:Article) node properties.
--   decision_supersession        (:Decision)-[:SUPERSEDED_BY {disposition, reversed_date}]->(:Decision)
--   decision_dissent             (:Decision)-[:HAS_DISSENT]->(:Decision)
--   decision_instance_status     Decision.status: 'overruled' | 'dissent'
--   case_position_departures     (:Decision)-[:DEPARTS_FROM {departed_on}]->(:Case): the Grand
--                                Chamber departed from the legal position in that case
--   case_citation_counts         decisions citing each case (resolved, not self-citations) from
--                                case_citation_links; the old Case.cited_by_count
--
-- Data is loaded by scripts/citation-graph/neo4j-load-instance-layer.sql and the rebuild
-- scripts, never by this migration. Idempotent: on a database where the tables were built
-- and indexed by those scripts every statement is a no-op.

CREATE TABLE IF NOT EXISTS decision_statute_citations (
  doc_id        bigint   NOT NULL,
  citation_type text     NOT NULL,
  law_number    text     NOT NULL,
  law_article   text     NOT NULL DEFAULT '',
  adj_year      smallint
);
CREATE INDEX IF NOT EXISTS idx_dsc_doc ON decision_statute_citations (doc_id);
CREATE INDEX IF NOT EXISTS idx_dsc_law_article ON decision_statute_citations (law_number, law_article);

CREATE TABLE IF NOT EXISTS statute_article_stats (
  law_number       text   NOT NULL,
  law_article      text   NOT NULL,
  total_citations  bigint NOT NULL,
  unique_decisions bigint NOT NULL,
  PRIMARY KEY (law_number, law_article)
);

CREATE TABLE IF NOT EXISTS decision_supersession (
  doc_id               bigint NOT NULL,
  superseded_by_doc_id bigint NOT NULL,
  disposition          text,
  reversed_date        timestamptz,
  PRIMARY KEY (doc_id, superseded_by_doc_id)
);

CREATE TABLE IF NOT EXISTS decision_dissent (
  parent_doc_id  bigint NOT NULL,
  dissent_doc_id bigint NOT NULL,
  PRIMARY KEY (parent_doc_id, dissent_doc_id)
);
CREATE INDEX IF NOT EXISTS idx_decision_dissent_dissent ON decision_dissent (dissent_doc_id);

CREATE TABLE IF NOT EXISTS decision_instance_status (
  doc_id bigint PRIMARY KEY,
  status text   NOT NULL
);

CREATE TABLE IF NOT EXISTS case_position_departures (
  departing_doc_id   bigint NOT NULL,
  departed_cause_num text   NOT NULL,
  departed_on        timestamptz,
  PRIMARY KEY (departing_doc_id, departed_cause_num)
);
CREATE INDEX IF NOT EXISTS idx_cpd_cause ON case_position_departures (departed_cause_num);

CREATE TABLE IF NOT EXISTS case_citation_counts (
  cause_num         text PRIMARY KEY,
  citing_decisions  int  NOT NULL
);
