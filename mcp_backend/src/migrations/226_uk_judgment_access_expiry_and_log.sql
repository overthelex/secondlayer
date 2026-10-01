-- TNA Find Case Law licence (CAS-349914-B9P5B8), commitments 1 and principle 6.
--
-- 1. A grant is a verification of a person's professional standing on a date, and
--    standing changes: a solicitor leaves practice, a researcher leaves the
--    university. So a grant now lapses after 12 months (set by the decide route) and
--    the gate refuses a grant without a live expiry. There are no grants yet, so no
--    backfill: a NULL expiry denies, which is the safe reading of a missing date.
-- 2. "Access is logged" covered only the calls that got through. Refusals are the
--    half that shows the gate works, so the log now records the outcome, and the
--    tool and transport that asked.
ALTER TABLE uk_judgment_access ADD COLUMN IF NOT EXISTS expires_at timestamptz;

ALTER TABLE uk_judgment_access_log ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'allowed';
ALTER TABLE uk_judgment_access_log ADD COLUMN IF NOT EXISTS tool text;
ALTER TABLE uk_judgment_access_log ADD COLUMN IF NOT EXISTS transport text;
DO $$ BEGIN
  ALTER TABLE uk_judgment_access_log
    ADD CONSTRAINT uk_judgment_access_log_outcome_check CHECK (outcome IN ('allowed', 'denied'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS idx_uk_jud_log_denied ON uk_judgment_access_log (at DESC) WHERE outcome = 'denied';
