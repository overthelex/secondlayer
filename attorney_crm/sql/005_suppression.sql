-- Outbound mail hygiene for the advocate campaign (Azure Communication Services
-- quota ticket 2611080050001034 promised List-Unsubscribe, a suppression list and
-- bounce handling). All idempotent.

-- One row per address we must never mail again. Filled by the public unsubscribe
-- endpoint (/u/:token), by bounce imports and by the team ("do not contact").
CREATE TABLE IF NOT EXISTS attorney_crm_suppression (
  email              TEXT PRIMARY KEY,                 -- lower-cased, trimmed
  reason             TEXT NOT NULL CHECK (reason IN ('unsubscribe','bounce','complaint','manual')),
  source             TEXT NOT NULL DEFAULT '',          -- one-click | link | postfix-log | import | crm | cli
  advocate_source_id TEXT,
  detail             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_attorney_crm_suppression_advocate ON attorney_crm_suppression (advocate_source_id);

-- Every attempt the sender made, so a campaign can be resumed without double
-- sends and the failure rate can be measured before asking Azure for more quota.
CREATE TABLE IF NOT EXISTS attorney_crm_mail_log (
  id                 BIGSERIAL PRIMARY KEY,
  email              TEXT NOT NULL,
  advocate_source_id TEXT,
  campaign           TEXT NOT NULL DEFAULT '',
  subject            TEXT NOT NULL,
  message_id         TEXT,
  status             TEXT NOT NULL CHECK (status IN ('sent','suppressed','failed','dry-run')),
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_attorney_crm_mail_log_email ON attorney_crm_mail_log (email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attorney_crm_mail_log_campaign ON attorney_crm_mail_log (campaign, status);
