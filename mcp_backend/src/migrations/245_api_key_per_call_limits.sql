-- Migration 245: enforce API-key limits on every MCP tool call, not only at session open
--
-- check_api_key_rate_limit() ran once when an MCP session was opened, and
-- rate_limit_per_minute was never enforced anywhere. A single session could
-- therefore make unlimited calls, and a key switched off with is_active = false
-- kept working inside sessions already open. The per-minute window is stored on
-- the row so the check is one atomic UPDATE, correct across backend instances.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS requests_this_minute INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS minute_window_start  TIMESTAMPTZ;

-- Consume one call against the key's limits. Returns allowed = true and counts the
-- call, or allowed = false with the reason and counts nothing.
CREATE OR REPLACE FUNCTION consume_api_key_call(p_api_key VARCHAR)
RETURNS TABLE(allowed BOOLEAN, reason TEXT, requests_today INTEGER, rate_limit_per_day INTEGER)
LANGUAGE plpgsql
AS $$
DECLARE
  v_minute TIMESTAMPTZ := date_trunc('minute', now());
  v_row    RECORD;
BEGIN
  UPDATE api_keys ak
     SET requests_today = CASE WHEN ak.requests_today_reset_at < CURRENT_DATE THEN 1
                               ELSE ak.requests_today + 1 END,
         requests_today_reset_at = CURRENT_DATE,
         requests_this_minute = CASE WHEN ak.minute_window_start = v_minute
                                     THEN ak.requests_this_minute + 1 ELSE 1 END,
         minute_window_start = v_minute,
         usage_count = ak.usage_count + 1,
         last_used_at = now()
   WHERE ak.key = p_api_key
     AND ak.is_active
     AND (ak.expires_at IS NULL OR ak.expires_at > now())
     AND (CASE WHEN ak.requests_today_reset_at < CURRENT_DATE THEN 0
               ELSE ak.requests_today END) < ak.rate_limit_per_day
     AND (CASE WHEN ak.minute_window_start = v_minute
               THEN ak.requests_this_minute ELSE 0 END) < ak.rate_limit_per_minute
  RETURNING ak.requests_today, ak.rate_limit_per_day INTO v_row;

  IF FOUND THEN
    RETURN QUERY SELECT true, 'OK'::TEXT, v_row.requests_today, v_row.rate_limit_per_day;
    RETURN;
  END IF;

  -- Refused: say why, without counting the call.
  SELECT * INTO v_row FROM api_keys ak WHERE ak.key = p_api_key;
  IF NOT FOUND OR NOT v_row.is_active THEN
    RETURN QUERY SELECT false, 'Invalid or inactive API key'::TEXT, 0, 0;
  ELSIF v_row.expires_at IS NOT NULL AND v_row.expires_at <= now() THEN
    RETURN QUERY SELECT false, 'API key expired'::TEXT, v_row.requests_today, v_row.rate_limit_per_day;
  ELSIF v_row.requests_today_reset_at >= CURRENT_DATE AND v_row.requests_today >= v_row.rate_limit_per_day THEN
    RETURN QUERY SELECT false, 'Daily rate limit exceeded'::TEXT, v_row.requests_today, v_row.rate_limit_per_day;
  ELSE
    RETURN QUERY SELECT false, 'Per-minute rate limit exceeded'::TEXT, v_row.requests_today, v_row.rate_limit_per_day;
  END IF;
END;
$$;

COMMENT ON FUNCTION consume_api_key_call IS
  'Atomically check and count one MCP tool call against an API key (active, expiry, per-day, per-minute) — migration 245';
