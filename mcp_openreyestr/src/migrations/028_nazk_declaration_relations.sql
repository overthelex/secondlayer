-- 028: relations from full НАЗК declarations (LEXAI-2295), for a company/person graph.
--
-- The --details pass of import-nazk-declarations.ts fetches /v2/documents/{id} (every section),
-- but stored only presence flags. These tables keep who the family members are and which
-- companies the declarant or a family member owns, holds securities of or is the beneficial
-- owner of. Sections of the document (all schema versions 1-5):
--   step_2  family members                       -> nazk_family_members
--   step_7  securities (shares etc.)             -> nazk_corporate_rights, section = 7
--   step_8  corporate rights (stakes)            -> nazk_corporate_rights, section = 8
--   step_9  legal entities of which the declarant or a family member is the beneficial owner
--                                                 -> nazk_corporate_rights, section = 9
--
-- Privacy: no birth dates, tax numbers, passport/document numbers, УНЗР, home addresses,
-- phones or e-mails are stored. Values NAZK hides ("[Конфіденційна інформація]", "[Не відомо]",
-- "[Не застосовується]", "[Член сім'ї не надав інформацію]", ...) are stored as NULL.
-- Owners who are neither the declarant nor a declared family member (third persons) are kept
-- as owner_type = 'other' without a name.
--
-- Rows are replaced per declaration_id (DELETE + INSERT in one transaction), so a re-run is
-- idempotent.

CREATE TABLE IF NOT EXISTS nazk_family_members (
    declaration_id    text NOT NULL,
    declarant_id      bigint,                 -- user_declarant_id: the same person across declarations
    declaration_year  integer,
    member_key        text NOT NULL,          -- step_2[].id; step_7/8/9 rights[].rightBelongs points here
    full_name         text,                   -- "прізвище ім'я по батькові" as declared
    lastname          text,
    firstname         text,
    middlename        text,
    name_latin        text,                   -- non_ukraine_identity: name as in a foreign passport
    name_key          text,                   -- uaMatchKey(full_name)
    relation          text,                   -- subjectRelation: дружина, чоловік, син, дочка, ...
    citizenship       text,                   -- NAZK country code ("1" = Україна)
    created_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (declaration_id, member_key)
);

CREATE INDEX IF NOT EXISTS idx_nazk_family_members_name_key ON nazk_family_members (name_key);
CREATE INDEX IF NOT EXISTS idx_nazk_family_members_declarant ON nazk_family_members (declarant_id);

CREATE TABLE IF NOT EXISTS nazk_corporate_rights (
    declaration_id      text NOT NULL,
    declarant_id        bigint,
    declaration_year    integer,
    section             smallint NOT NULL CHECK (section IN (7, 8, 9)),
    right_kind          text NOT NULL CHECK (right_kind IN ('securities', 'corporate_rights', 'beneficial_owner')),
    entry_key           text NOT NULL,        -- iteration of the entry in its step (or its position)
    owner_key           text NOT NULL,        -- '1' = declarant, step_2 member id, or a third person key
    owner_type          text NOT NULL CHECK (owner_type IN ('declarant', 'family', 'other')),
    owner_name          text,                 -- declarant / family member name; NULL for third persons
    owner_name_key      text,                 -- uaMatchKey(owner_name)
    owner_relation      text,                 -- family member's subjectRelation
    company_name        text,
    company_name_key    text,                 -- uaMatchKey(company_name)
    edrpou              char(8),              -- Ukrainian company code, zero-padded to 8 digits
    company_code_raw    text,                 -- the code as declared (foreign registration numbers too)
    country             text,                 -- NAZK country code ("1" = Україна)
    legal_form          text,
    security_type       text,                 -- step_7 typeProperty: Акції, Облігації, ...
    ownership_type      text,                 -- rights[].ownershipType: Власність, Спільна власність, ...
    share_percent       numeric,              -- step_8 cost_percent
    value               numeric,              -- step_7/8 cost (UAH)
    amount              numeric,              -- step_7 number of securities
    acquired_date       date,                 -- owningDate
    is_beneficial_owner boolean NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (declaration_id, section, entry_key, owner_key)
);

CREATE INDEX IF NOT EXISTS idx_nazk_corporate_rights_edrpou ON nazk_corporate_rights (edrpou) WHERE edrpou IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nazk_corporate_rights_company_key ON nazk_corporate_rights (company_name_key);
CREATE INDEX IF NOT EXISTS idx_nazk_corporate_rights_owner_key ON nazk_corporate_rights (owner_name_key);
CREATE INDEX IF NOT EXISTS idx_nazk_corporate_rights_declarant ON nazk_corporate_rights (declarant_id);

-- When the relations of a declaration were last extracted; NULL = not yet (the --details pass
-- picks these rows by default).
ALTER TABLE nazk_declarations ADD COLUMN IF NOT EXISTS relations_extracted_at timestamptz;
