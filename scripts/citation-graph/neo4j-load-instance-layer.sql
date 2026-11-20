-- neo4j-load-instance-layer.sql  (LEXAI-2323)
--
-- Loads the CSVs written by neo4j-export-instance-layer.sh (copied into the postgres
-- container's /tmp/neo4j-export by neo4j-load-instance-layer.sh) into the tables of
-- migration 297 (their DDL is repeated below, IF NOT EXISTS, so this can run before
-- the migration has; the statute tables are left alone). Each table is replaced as a whole, in one transaction, so a rerun
-- converges instead of piling up rows.

\set ON_ERROR_STOP on
\timing on
SET statement_timeout = '30min';
SET lock_timeout = '10s';

BEGIN;
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

CREATE TEMP TABLE x_sup (doc_id text, by_doc text, disposition text, reversed_date text);
\copy x_sup FROM '/tmp/neo4j-export/superseded_by.csv' WITH (FORMAT csv, NULL 'NULL')
CREATE TEMP TABLE x_dis (parent text, dissent text);
\copy x_dis FROM '/tmp/neo4j-export/dissent.csv' WITH (FORMAT csv, NULL 'NULL')
CREATE TEMP TABLE x_dep (doc_id text, cause_num text, departed_on text);
\copy x_dep FROM '/tmp/neo4j-export/departs.csv' WITH (FORMAT csv, NULL 'NULL')
CREATE TEMP TABLE x_st (doc_id text, status text);
\copy x_st FROM '/tmp/neo4j-export/status.csv' WITH (FORMAT csv, NULL 'NULL')

TRUNCATE decision_supersession, decision_dissent, case_position_departures, decision_instance_status;

INSERT INTO decision_supersession (doc_id, superseded_by_doc_id, disposition, reversed_date)
SELECT DISTINCT ON (doc_id::bigint, by_doc::bigint) doc_id::bigint, by_doc::bigint,
       NULLIF(disposition, ''), NULLIF(reversed_date, '')::timestamptz
  FROM x_sup ORDER BY doc_id::bigint, by_doc::bigint;
INSERT INTO decision_dissent SELECT DISTINCT parent::bigint, dissent::bigint FROM x_dis;
INSERT INTO case_position_departures (departing_doc_id, departed_cause_num, departed_on)
SELECT DISTINCT ON (doc_id::bigint, cause_num) doc_id::bigint, cause_num, NULLIF(departed_on, '')::timestamptz
  FROM x_dep ORDER BY doc_id::bigint, cause_num, departed_on DESC;
INSERT INTO decision_instance_status (doc_id, status)
SELECT DISTINCT ON (doc_id::bigint) doc_id::bigint, status FROM x_st WHERE status <> ''
 ORDER BY doc_id::bigint, status;
COMMIT;

ANALYZE decision_supersession; ANALYZE decision_dissent;
ANALYZE case_position_departures; ANALYZE decision_instance_status;

SELECT 'decision_supersession' t, count(*) FROM decision_supersession
UNION ALL SELECT 'decision_dissent', count(*) FROM decision_dissent
UNION ALL SELECT 'case_position_departures', count(*) FROM case_position_departures
UNION ALL SELECT 'decision_instance_status', count(*) FROM decision_instance_status
UNION ALL SELECT 'status ' || status, count(*) FROM decision_instance_status GROUP BY status;
