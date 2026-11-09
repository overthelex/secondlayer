-- Cloudflare leaked-credentials detection marks a login whose email+password pair is in a
-- known breach with the request header "Exposed-Credential-Check: 1" (transform rule on the
-- legal.org.ua zone). The backend records the last such login here and mails the user at most
-- once a week.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_leaked_at TIMESTAMPTZ;
COMMENT ON COLUMN users.password_leaked_at IS 'Last password login that Cloudflare flagged as using a leaked password (Exposed-Credential-Check: 1)';
