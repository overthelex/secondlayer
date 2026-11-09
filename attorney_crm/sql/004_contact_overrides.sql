-- Team corrections that must survive registry re-collection: a "do not contact"
-- flag (legal objection, not a sales stage) and manual phone / e-mail overrides.
-- Design: docs/superpowers/specs/2026-11-08-attorney-crm-pl-design.md
ALTER TABLE attorney_crm_leads
  ADD COLUMN IF NOT EXISTS do_not_contact        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS do_not_contact_reason TEXT,
  ADD COLUMN IF NOT EXISTS phone_override        TEXT,
  ADD COLUMN IF NOT EXISTS email_override        TEXT;
