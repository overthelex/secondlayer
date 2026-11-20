-- 030: relationship graph built from the ЄДР (LEXAI-2303), the replacement for a "search for links"
-- feature: companies, candidate persons (grouped by name), addresses and foreign entities as nodes;
-- founder / beneficiary / head / signer / registered_at / reg_neighbour as dated edges.
--
-- Built by src/scripts/build-graph.ts from edr_hist (2016-2021 snapshots, later the weekly ones) and
-- the current dump tables (legal_entities, founders, signers, beneficiaries). The builder fills
-- schema graph_stage and swaps it in with one transaction, so graph.node / graph.edge stay
-- queryable during a rebuild; the DDL of the staged tables is in src/services/graph/builder.ts
-- (stageDdl) and must stay identical to this file.
--
-- person_name is a CANDIDATE node: every person with the same uaMatchKey(full name) is one node,
-- namesakes included. Telling people apart is LEXAI-2306. No document or tax numbers are stored.
CREATE SCHEMA IF NOT EXISTS graph;

-- kind / key:
--   company         8-digit ЄДРПОУ
--   person_name     uaMatchKey(full name)
--   address         addressKey (building level, graph-norm/address.ts) of graph.address_key
--   foreign_entity  'CC|name:<uaMatchKey(name)>' or 'CC|code:<registration code>' (CC = ISO 3166 alpha-2)
-- degree = number of incident edges; hub = degree above the threshold of the kind (see graph.build),
-- a traversal stops at hubs (mass registration addresses, formation agents, nominee directors).
CREATE TABLE IF NOT EXISTS graph.node (
    id      bigserial PRIMARY KEY,
    kind    text NOT NULL CHECK (kind IN ('company', 'person_name', 'address', 'foreign_entity')),
    key     text NOT NULL,
    label   text,
    degree  integer NOT NULL DEFAULT 0,
    hub     boolean NOT NULL DEFAULT false,
    attrs   jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT node_kind_key UNIQUE (kind, key)
);

-- Direction: participant -> company (founder, beneficiary, head, signer), company -> address
-- (registered_at), lower code -> higher code (reg_neighbour).
-- valid_from: first snapshot that showed the relation; NULL = it was already there in the first
--   snapshot publishing the field (started earlier, date unknown); exact for reg_neighbour.
-- valid_to: last snapshot that showed it; NULL = still current (in the newest dump).
-- source_ref: snapshot dates and row references (edr_hist entry hashes, current table ids).
CREATE TABLE IF NOT EXISTS graph.edge (
    id          bigserial PRIMARY KEY,
    src         bigint NOT NULL,
    dst         bigint NOT NULL,
    kind        text NOT NULL CHECK (kind IN ('founder', 'beneficiary', 'head', 'signer', 'registered_at', 'reg_neighbour')),
    valid_from  date,
    valid_to    date,
    source      text NOT NULL CHECK (source IN ('edr_hist', 'edr_current')),
    source_ref  jsonb NOT NULL DEFAULT '{}'::jsonb,
    attrs       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS edge_src_kind ON graph.edge (src, kind);
CREATE INDEX IF NOT EXISTS edge_dst_kind ON graph.edge (dst, kind);
CREATE INDEX IF NOT EXISTS edge_src_current ON graph.edge (src) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS edge_dst_current ON graph.edge (dst) WHERE valid_to IS NULL;

-- Address keys, kept across builds: the raw ЄДР address, its keys and the key version
-- ('a<ADDRESS_KEY_VERSION>/sr:<street renaming index fingerprint>'). A build recomputes only the
-- rows of another version, so a change of normAddress or of the street renamings (PR #2791)
-- re-keys the addresses on the next build.
CREATE TABLE IF NOT EXISTS graph.address_key (
    raw_md5         text PRIMARY KEY,
    raw             text NOT NULL,
    key_version     text NOT NULL,
    parse_status    text,
    settlement_key  text,
    street_key      text,
    address_key     text,
    premises_key    text,
    label           text,
    keyed_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS address_key_version ON graph.address_key (key_version);

-- One row per build: parameters, source dates, counts, hub thresholds, timings.
CREATE TABLE IF NOT EXISTS graph.build (
    id           bigserial PRIMARY KEY,
    started_at   timestamptz NOT NULL,
    finished_at  timestamptz NOT NULL DEFAULT now(),
    params       jsonb NOT NULL,
    sources      jsonb NOT NULL,
    counts       jsonb NOT NULL,
    seconds      jsonb NOT NULL
);
