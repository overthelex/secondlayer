-- Migration 034: Immutable Audit Log with hash chain
-- Append-only table for compliance auditing

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id TEXT,
  ip_address INET,
  user_agent TEXT,
  details JSONB DEFAULT '{}',
  previous_hash TEXT,
  current_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);

-- Prevent UPDATE/DELETE on audit_log (immutable)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_rules WHERE rulename = 'no_update_audit_log'
  ) THEN
    CREATE RULE no_update_audit_log AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_rules WHERE rulename = 'no_delete_audit_log'
  ) THEN
    CREATE RULE no_delete_audit_log AS ON DELETE TO audit_log DO INSTEAD NOTHING;
  END IF;
END $$;

-- Function: insert audit log entry with hash chain
CREATE OR REPLACE FUNCTION add_audit_log(
  p_user_id UUID,
  p_action VARCHAR(100),
  p_resource_type VARCHAR(50),
  p_resource_id TEXT,
  p_ip_address INET,
  p_user_agent TEXT,
  p_details JSONB
) RETURNS UUID AS $$
DECLARE
  v_id UUID;
  v_previous_hash TEXT;
  v_current_hash TEXT;
  v_data TEXT;
BEGIN
  -- Get the hash of the last entry
  SELECT current_hash INTO v_previous_hash
  FROM audit_log
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  -- If no previous entry, use a genesis hash
  IF v_previous_hash IS NULL THEN
    v_previous_hash := 'GENESIS';
  END IF;

  v_id := gen_random_uuid();

  -- Build data string for hashing
  v_data := v_id::TEXT || COALESCE(p_user_id::TEXT, 'NULL') ||
            p_action || p_resource_type || COALESCE(p_resource_id, 'NULL') ||
            COALESCE(p_details::TEXT, '{}') || v_previous_hash;

  -- Compute SHA-256 hash
  v_current_hash := encode(digest(v_data, 'sha256'), 'hex');

  INSERT INTO audit_log (id, user_id, action, resource_type, resource_id,
                          ip_address, user_agent, details, previous_hash, current_hash)
  VALUES (v_id, p_user_id, p_action, p_resource_type, p_resource_id,
          p_ip_address, p_user_agent, p_details, v_previous_hash, v_current_hash);

  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- Function: validate the integrity of the audit chain
CREATE OR REPLACE FUNCTION validate_audit_chain()
RETURNS TABLE(is_valid BOOLEAN, invalid_entry_id UUID, expected_hash TEXT, actual_hash TEXT, entries_checked INT) AS $$
DECLARE
  rec RECORD;
  v_previous_hash TEXT := 'GENESIS';
  v_expected_hash TEXT;
  v_data TEXT;
  v_count INT := 0;
BEGIN
  FOR rec IN SELECT * FROM audit_log ORDER BY created_at ASC, id ASC LOOP
    v_count := v_count + 1;

    -- Verify previous_hash matches
    IF rec.previous_hash != v_previous_hash THEN
      RETURN QUERY SELECT FALSE, rec.id, v_previous_hash, rec.previous_hash, v_count;
      RETURN;
    END IF;

    -- Recompute hash
    v_data := rec.id::TEXT || COALESCE(rec.user_id::TEXT, 'NULL') ||
              rec.action || rec.resource_type || COALESCE(rec.resource_id, 'NULL') ||
              COALESCE(rec.details::TEXT, '{}') || rec.previous_hash;
    v_expected_hash := encode(digest(v_data, 'sha256'), 'hex');

    IF rec.current_hash != v_expected_hash THEN
      RETURN QUERY SELECT FALSE, rec.id, v_expected_hash, rec.current_hash, v_count;
      RETURN;
    END IF;

    v_previous_hash := rec.current_hash;
  END LOOP;

  RETURN QUERY SELECT TRUE, NULL::UUID, NULL::TEXT, NULL::TEXT, v_count;
END;
$$ LANGUAGE plpgsql;
