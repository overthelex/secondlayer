-- 031: relationship graph (030) — computed hub thresholds, curated address flags and the
-- 'organisation' node kind (LEXAI-2318, LEXAI-2319).
--
-- organisation: a legal entity written as a head / signer (management company, КУА,
--   ТОВ-управитель) that has no code in the entry and whose name matches no single company in
--   the ЄДР; key = uaMatchKey(name), a candidate node like person_name. With a code, or a unique
--   name, the head edge goes to the company node instead.
-- The builder recreates graph.node from its staging DDL (builder.ts stageDdl, which includes
-- this kind); the constraint below keeps a database built before 031 consistent.
DO $$ BEGIN
  IF to_regclass('graph.node') IS NOT NULL THEN
    ALTER TABLE graph.node DROP CONSTRAINT IF EXISTS node_kind_check;
    ALTER TABLE graph.node ADD CONSTRAINT node_kind_check
      CHECK (kind IN ('company', 'person_name', 'address', 'foreign_entity', 'organisation'));
  END IF;
END $$;

-- Curated address flags, empty by default and filled by hand (not from the repository):
--   mass_registration  always a hub, attrs.mass_registration = 'list'
--   not_hub            never a hub nor mass registration (e.g. a business centre whose tenants
--                      should stay connected in a traversal)
-- address_key is the building key of graph.address_key / graph.node (kind 'address').
CREATE TABLE IF NOT EXISTS graph.address_flag (
    address_key  text PRIMARY KEY,
    flag         text NOT NULL CHECK (flag IN ('mass_registration', 'not_hub')),
    note         text,
    source       text,
    added_at     timestamptz NOT NULL DEFAULT now()
);

-- Hub thresholds a build computed from the degree distribution (keys.ts computeHubThresholds):
-- {thresholds: {kind: n}, massRegistrationMinDegree, basis, observed: {kind: {percentile: degree}}}
ALTER TABLE graph.build ADD COLUMN IF NOT EXISTS hub_thresholds jsonb;
