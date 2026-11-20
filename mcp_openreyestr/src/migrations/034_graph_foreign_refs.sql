-- 034: relationship graph (030, 031) — foreign registers linked to the foreign_entity nodes (LEXAI-2321).
--
-- Filled by src/scripts/import-foreign-refs.ts from the registers of the secondlayer database
-- (cy_companies / cy_officials: Cyprus DRCOR open data; icij_nodes: ICIJ Offshore Leaks) and from
-- the Companies House numbers written in the ЄДР entries. The graph builder reads only these
-- tables (no cross-database queries): links go to graph.node.attrs.links of the foreign entity,
-- the officials of a linked Cypriot company become 'head' edges with source 'cy_drcor'.

-- One row per (foreign entity, register record).
--   node_key   graph.node key of the foreign entity ('CY|name:...', 'CY|code:HE123456')
--   ref_id     cy_drcor: '<org_type_code>/<registration_no>'; icij: node_id; companies_house: number
--   match      'code' (registration number in the entry) or 'name' (name skeleton)
--   candidate  true when the link is not an identification: every ICIJ name match, an unverified
--              Companies House number
CREATE TABLE IF NOT EXISTS graph.foreign_ref (
    node_key       text NOT NULL,
    source         text NOT NULL CHECK (source IN ('cy_drcor', 'icij', 'companies_house')),
    ref_id         text NOT NULL,
    match          text NOT NULL CHECK (match IN ('code', 'name')),
    candidate      boolean NOT NULL DEFAULT false,
    name           text,
    jurisdiction   text,
    status         text,
    registered_on  date,
    url            text,
    source_date    date,
    attrs          jsonb NOT NULL DEFAULT '{}'::jsonb,
    imported_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (node_key, source, ref_id)
);
CREATE INDEX IF NOT EXISTS foreign_ref_source_ref ON graph.foreign_ref (source, ref_id);

-- Officials of a linked register record (directors, secretaries, ...). ep_kind / ep_key: the graph
-- endpoint of the official, computed with the person key version key_version (keys.ts
-- PERSON_KEY_VERSION); the builder skips rows of another version until the import is re-run.
CREATE TABLE IF NOT EXISTS graph.foreign_officer (
    source       text NOT NULL CHECK (source IN ('cy_drcor')),
    ref_id       text NOT NULL,
    name         text NOT NULL,
    role         text NOT NULL,
    position     text,
    ep_kind      text NOT NULL CHECK (ep_kind IN ('person_name', 'foreign_entity')),
    ep_key       text NOT NULL,
    key_version  text NOT NULL,
    source_date  date,
    url          text,
    PRIMARY KEY (source, ref_id, ep_kind, ep_key, role)
);

-- Edge source 'cy_drcor' is allowed by the builder's staging DDL (builder.ts stageDdl), from which
-- every build recreates graph.edge; the constraint of a graph built before is left alone (it has
-- no such edges), so this migration does not race other migrations that widen the same list.

-- Edge source 'cy_drcor' (head edges from Cypriot officials). The builder recreates graph.edge from
-- its staging DDL; this keeps a graph built before 034 consistent with the full source list.
DO $$ BEGIN
  IF to_regclass('graph.edge') IS NOT NULL THEN
    ALTER TABLE graph.edge DROP CONSTRAINT IF EXISTS edge_source_check;
    ALTER TABLE graph.edge ADD CONSTRAINT edge_source_check
      CHECK (source IN ('edr_hist', 'edr_current', 'edrsr', 'prozorro', 'cy_drcor'));
  END IF;
END $$;
