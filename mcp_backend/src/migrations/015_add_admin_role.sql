-- Migration 015: Add Admin Role Support
-- Purpose: Add is_admin column to users table for admin access control
-- Date: 2026-02-01

BEGIN;

-- Add is_admin column to users table
ALTER TABLE users
ADD COLUMN is_admin BOOLEAN DEFAULT false NOT NULL;

-- Create index for faster admin checks
CREATE INDEX idx_users_admin ON users(id) WHERE is_admin = true;

-- Add admin audit log table
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES users(id),
  action VARCHAR(50) NOT NULL,
  target_user_id UUID REFERENCES users(id),
  target_resource_id VARCHAR(100),
  details JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for audit log
CREATE INDEX idx_audit_admin ON admin_audit_log(admin_id, created_at DESC);
CREATE INDEX idx_audit_target ON admin_audit_log(target_user_id, created_at DESC);
CREATE INDEX idx_audit_action ON admin_audit_log(action, created_at DESC);
CREATE INDEX idx_audit_created ON admin_audit_log(created_at DESC);

-- Add comments
COMMENT ON TABLE admin_audit_log IS 'Audit log for all admin actions';
COMMENT ON COLUMN admin_audit_log.action IS 'Type of admin action (e.g., adjust_balance, change_tier, refund_transaction)';
COMMENT ON COLUMN admin_audit_log.target_user_id IS 'User affected by the admin action';
COMMENT ON COLUMN admin_audit_log.target_resource_id IS 'ID of affected resource (transaction_id, etc.)';
COMMENT ON COLUMN admin_audit_log.details IS 'JSON details of the action (old/new values, reasons, etc.)';

-- Create view for recent admin activity
CREATE OR REPLACE VIEW admin_activity_summary AS
SELECT
  aal.admin_id,
  u.email as admin_email,
  aal.action,
  COUNT(*) as action_count,
  MAX(aal.created_at) as last_action_at
FROM admin_audit_log aal
JOIN users u ON aal.admin_id = u.id
WHERE aal.created_at >= NOW() - INTERVAL '30 days'
GROUP BY aal.admin_id, u.email, aal.action
ORDER BY action_count DESC;

COMMENT ON VIEW admin_activity_summary IS 'Summary of admin actions in the last 30 days';

COMMIT;
