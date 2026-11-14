-- One welcome bonus per person, not just per account/card. Monobank does not
-- return the cardholder name, so a claim is matched against earlier claims by
-- the normalised profile name, the client IP and a browser device id. A match
-- does not credit the bonus: the claim waits for an administrator.
ALTER TABLE welcome_bonus_claims
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'credited',
  ADD COLUMN IF NOT EXISTS name_key TEXT,
  ADD COLUMN IF NOT EXISTS client_ip TEXT,
  ADD COLUMN IF NOT EXISTS device_id TEXT,
  ADD COLUMN IF NOT EXISTS match_reason TEXT,
  ADD COLUMN IF NOT EXISTS matched_user_id UUID,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID;

DO $$ BEGIN
  ALTER TABLE welcome_bonus_claims
    ADD CONSTRAINT welcome_bonus_claims_status_chk
    CHECK (status IN ('credited', 'pending_review', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_wbc_name_key ON welcome_bonus_claims (name_key) WHERE name_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wbc_client_ip ON welcome_bonus_claims (client_ip) WHERE client_ip IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wbc_device_id ON welcome_bonus_claims (device_id) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wbc_pending ON welcome_bonus_claims (created_at) WHERE status = 'pending_review';

-- Name key for earlier claims; must match nameKey() in welcome-bonus-service.ts:
-- lower case, apostrophes dropped, words sorted by code point (COLLATE "C"
-- = JS default sort for these letters), at least two words.
UPDATE welcome_bonus_claims c
SET name_key = k.key
FROM (
  SELECT u.id,
         (SELECT string_agg(t, ' ' ORDER BY t COLLATE "C")
            FROM regexp_split_to_table(
                   lower(regexp_replace(coalesce(u.name, ''), $q$['’ʼ`]$q$, '', 'g')),
                   '[^[:alpha:]]+') AS t
           WHERE t <> '') AS key,
         (SELECT count(*)
            FROM regexp_split_to_table(
                   lower(regexp_replace(coalesce(u.name, ''), $q$['’ʼ`]$q$, '', 'g')),
                   '[^[:alpha:]]+') AS t
           WHERE t <> '') AS words
  FROM users u
) k
WHERE k.id = c.user_id AND c.name_key IS NULL AND k.words >= 2
  AND NOT (k.key ~ '(^| )дія( |$)' AND k.key ~ '(^| )користувач( |$)');
