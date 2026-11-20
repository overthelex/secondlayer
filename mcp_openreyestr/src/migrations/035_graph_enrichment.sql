-- 035: enrichment layer of the relationship graph (LEXAI-2305): flags on nodes and extra dated
-- edges from registers other than the ЄДР (sanctions, debts, enforcement, ProZorro, НАЗК
-- declarations, НБУ licences, НКЦПФР shareholders).
--
-- Built by src/scripts/build-graph-enrichment.ts AFTER build-graph.ts, into schema
-- graph_enrich_stage and swapped in with one transaction (services/graph/enrichment.ts; its
-- enrichDdl() must stay identical to this file). It is a layer next to graph.node / graph.edge,
-- not part of them: rows are keyed by the node (kind, key) of graph.node, not by node ids, so a
-- graph rebuild does not invalidate them, and the ЄДР builder (builder.ts) is not touched.
-- Person endpoints are kept only for names that are already a person_name node of the graph
-- (candidate match by name, namesakes included: attrs / match say so). No tax or document
-- numbers are stored: the build fails if a 10-digit run is left in a key or an attribute.

-- One row per (node, flag, source): the node is on a register.
--   flag              source                    kind of node
--   sanctions         rnbo_sanctions            company (ЄДРПОУ), foreign_entity / person_name (name)
--   war_sanctions     nazk_war_sanctions        company (ЄДРПОУ), person_name (name)
--   tax_debt          tax_debt                  company
--   esv_debt          esv_debt                  company
--   debtor_register   debtors                   company (Єдиний реєстр боржників)
--   enforcement       enforcement_proceedings   company (боржник у виконавчих провадженнях АСВП)
--   termination       termination_started       company (розпочато припинення)
--   fin_licence       nbu_fin_licenses          company (ліцензія НБУ на фінпослуги)
--   pep_declarant     nazk_declarations         person_name (подає декларацію НАЗК)
-- match: 'code' (by ЄДРПОУ) or 'name' (by the name key: a candidate, may be a namesake).
-- as_of: date of the source snapshot (or of the record); source_ref: ids of the source rows.
CREATE TABLE IF NOT EXISTS graph.node_flag (
    kind        text NOT NULL,
    key         text NOT NULL,
    flag        text NOT NULL CHECK (flag IN ('sanctions', 'war_sanctions', 'tax_debt', 'esv_debt', 'debtor_register',
                                              'enforcement', 'termination', 'fin_licence', 'pep_declarant')),
    source      text NOT NULL,
    match       text NOT NULL CHECK (match IN ('code', 'name')),
    as_of       date,
    attrs       jsonb NOT NULL DEFAULT '{}'::jsonb,
    source_ref  jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT node_flag_pkey PRIMARY KEY (kind, key, flag, source)
);

-- Extra edges between graph nodes (by kind, key). Direction:
--   creditor        creditor company -> debtor company (виконавчі провадження АСВП; стягувач — боржник)
--   supplier        supplier company -> buyer (замовник) company (договори ProZorro)
--   declared_owner  person -> company (корпоративні права / КБВ у декларації НАЗК)
--   family          declarant -> family member (декларація НАЗК: подружжя, батьки)
--   shareholder     owner -> issuer (власники >= 5 % акцій, НКЦПФР)
-- valid_from / valid_to: first / last date the source shows the relation; valid_to NULL = still
-- shown by the newest source data (open proceeding, contract in force, latest declaration year /
-- shareholder report).
CREATE TABLE IF NOT EXISTS graph.enrich_edge (
    id          bigserial,
    src_kind    text NOT NULL,
    src_key     text NOT NULL,
    dst_kind    text NOT NULL,
    dst_key     text NOT NULL,
    kind        text NOT NULL CHECK (kind IN ('creditor', 'supplier', 'declared_owner', 'family', 'shareholder')),
    valid_from  date,
    valid_to    date,
    source      text NOT NULL,
    source_ref  jsonb NOT NULL DEFAULT '{}'::jsonb,
    attrs       jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT enrich_edge_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS enrich_edge_src ON graph.enrich_edge (src_kind, src_key);
CREATE INDEX IF NOT EXISTS enrich_edge_dst ON graph.enrich_edge (dst_kind, dst_key);

-- One row per enrichment build: sources used / skipped, counts, timings.
CREATE TABLE IF NOT EXISTS graph.enrich_build (
    id           bigserial PRIMARY KEY,
    started_at   timestamptz NOT NULL,
    finished_at  timestamptz NOT NULL DEFAULT now(),
    params       jsonb NOT NULL,
    sources      jsonb NOT NULL,
    counts       jsonb NOT NULL,
    seconds      jsonb NOT NULL
);
