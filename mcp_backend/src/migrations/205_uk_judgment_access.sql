-- Migration 205: who may reach the UK judgment corpus
--
-- Question 13 of the Find Case Law licence application (TNA ref CAS-349914-B9P5B8,
-- submitted 2026-08-28) answers "Restricted access — only subscribers or research
-- peers", and question 14 names legal professionals and researchers. That answer is
-- what separates the 5-year transactional licence, under which the tool may be
-- offered, from a 1-year R&D licence whose outputs cannot be given to third parties
-- at all.
--
-- It was not true when it was written. Measured 2026-08-31: POST /api/keys issues an
-- API key to any authenticated user, and `search_registry` with registry
-- 'uk_court_decisions' then returns judgment text to that key. Authentication
-- existed; authorisation by professional standing did not.
--
-- ⚠ This table gates the JUDGMENTS ONLY. The uk_legislation* registries stay open:
-- legislation.gov.uk is Open Government Licence v3.0, commercial use permitted, and
-- putting a professional gate in front of it would be an invention of ours rather
-- than a licence term.
--
-- Why an attestation and not a law-firm domain allow-list. The bar TNA actually set
-- (Timothy Cross, 2026-08-28) is "as long as we are confident that unqualified
-- individuals cannot access the tool to pursue legal cases (i.e.,
-- litigants-in-person)" — keep litigants in person out, not verify a roll number. A
-- domain allow-list fails that badly in both directions: it excludes in-house
-- counsel on a corporate domain and academics on .ac.uk, both of whom we named in
-- question 14, while admitting anyone at a firm including its IT and marketing
-- staff. It would also need to enumerate ~9,000 SRA-regulated firms before Scotland,
-- Northern Ireland and every other jurisdiction we serve, and would lock out our
-- existing Ukrainian users. The domain is kept below as a SIGNAL — free-mail
-- addresses route to review rather than refusal, because a sole practitioner or a
-- barrister on a personal address is ordinary.
CREATE TABLE IF NOT EXISTS uk_judgment_access (
    -- users.id is a uuid, not a serial. Getting this wrong is caught by the FK,
    -- which is why the FK is here rather than left implicit.
    user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'granted', 'refused', 'revoked')),

    -- The attestation. Named, timestamped and addressed, so that "we are confident"
    -- rests on a statement a person made rather than on a guess we made about them.
    organisation        TEXT NOT NULL,
    role_stated         TEXT NOT NULL,
    -- Explicit acknowledgement that the service is not offered to litigants in
    -- person. This is the sentence TNA's test is about.
    attested_not_lip    BOOLEAN NOT NULL DEFAULT false,
    attested_at         TIMESTAMPTZ,
    attested_ip         TEXT,

    -- Corroboration, all optional. regulator/regulator_number let a UK applicant
    -- offer something checkable against a public register; nothing here is required
    -- to be granted.
    regulator           TEXT,
    regulator_number    TEXT,
    email_domain        TEXT,
    domain_is_free_mail BOOLEAN,

    decided_by          UUID REFERENCES users(id),
    decided_at          TIMESTAMPTZ,
    decision_note       TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The gate reads this on every judgment query, so keep the granted set cheap to hit.
CREATE INDEX IF NOT EXISTS idx_uk_jud_access_granted ON uk_judgment_access (user_id)
    WHERE status = 'granted';
CREATE INDEX IF NOT EXISTS idx_uk_jud_access_pending ON uk_judgment_access (created_at)
    WHERE status = 'pending';

-- Principle 6 of the licence says access is logged. One row per judgment query that
-- reached the corpus, so a question about who read what has an answer.
CREATE TABLE IF NOT EXISTS uk_judgment_access_log (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    registry    TEXT NOT NULL,
    filters     JSONB,
    rows_returned INTEGER,
    at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_uk_jud_log_user ON uk_judgment_access_log (user_id, at DESC);
