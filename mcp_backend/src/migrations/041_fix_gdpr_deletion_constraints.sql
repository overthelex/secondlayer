-- Migration 041: Fix FK constraints that block GDPR user deletion
-- Created: 2026-02-13
-- Description: Changes ON DELETE RESTRICT/NO ACTION to CASCADE or SET NULL
-- so that DELETE FROM users succeeds when user requests account deletion.

-- ============================================================================
-- time_entries: user_id was RESTRICT (blocks deletion), created_by/approved_by had no action
-- ============================================================================
DO $$ BEGIN
  -- user_id: RESTRICT → CASCADE (delete time entries when user is deleted)
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_user_id_fkey') THEN
    ALTER TABLE time_entries DROP CONSTRAINT time_entries_user_id_fkey;
  END IF;
  ALTER TABLE time_entries ADD CONSTRAINT time_entries_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

  -- created_by: no action → SET NULL
  -- First drop any existing constraint
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_created_by_fkey') THEN
    ALTER TABLE time_entries DROP CONSTRAINT time_entries_created_by_fkey;
  END IF;
  ALTER TABLE time_entries ALTER COLUMN created_by DROP NOT NULL;
  ALTER TABLE time_entries ADD CONSTRAINT time_entries_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

  -- approved_by: no action → SET NULL (column already nullable)
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_approved_by_fkey') THEN
    ALTER TABLE time_entries DROP CONSTRAINT time_entries_approved_by_fkey;
  END IF;
  ALTER TABLE time_entries ADD CONSTRAINT time_entries_approved_by_fkey
    FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL;
END $$;

-- ============================================================================
-- user_billing_rates: created_by had no ON DELETE action
-- ============================================================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_billing_rates_created_by_fkey') THEN
    ALTER TABLE user_billing_rates DROP CONSTRAINT user_billing_rates_created_by_fkey;
  END IF;
  ALTER TABLE user_billing_rates ALTER COLUMN created_by DROP NOT NULL;
  ALTER TABLE user_billing_rates ADD CONSTRAINT user_billing_rates_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
END $$;

-- ============================================================================
-- matter_invoices: created_by had no ON DELETE action
-- ============================================================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matter_invoices_created_by_fkey') THEN
    ALTER TABLE matter_invoices DROP CONSTRAINT matter_invoices_created_by_fkey;
  END IF;
  ALTER TABLE matter_invoices ALTER COLUMN created_by DROP NOT NULL;
  ALTER TABLE matter_invoices ADD CONSTRAINT matter_invoices_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
END $$;

-- ============================================================================
-- invoice_payments: recorded_by had no ON DELETE action
-- ============================================================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_payments_recorded_by_fkey') THEN
    ALTER TABLE invoice_payments DROP CONSTRAINT invoice_payments_recorded_by_fkey;
  END IF;
  ALTER TABLE invoice_payments ALTER COLUMN recorded_by DROP NOT NULL;
  ALTER TABLE invoice_payments ADD CONSTRAINT invoice_payments_recorded_by_fkey
    FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE SET NULL;
END $$;

-- ============================================================================
-- gdpr_requests: user_id NOT NULL prevents audit trail after user deletion
-- ============================================================================
DO $$ BEGIN
  ALTER TABLE gdpr_requests ALTER COLUMN user_id DROP NOT NULL;

  -- Change to SET NULL so deletion audit record survives
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gdpr_requests_user_id_fkey') THEN
    ALTER TABLE gdpr_requests DROP CONSTRAINT gdpr_requests_user_id_fkey;
  END IF;
  ALTER TABLE gdpr_requests ADD CONSTRAINT gdpr_requests_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
END $$;

-- ============================================================================
-- legal_holds: issued_by was RESTRICT (blocks deletion if user issued a hold)
-- ============================================================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_holds_issued_by_fkey') THEN
    ALTER TABLE legal_holds DROP CONSTRAINT legal_holds_issued_by_fkey;
  END IF;
  ALTER TABLE legal_holds ALTER COLUMN issued_by DROP NOT NULL;
  ALTER TABLE legal_holds ADD CONSTRAINT legal_holds_issued_by_fkey
    FOREIGN KEY (issued_by) REFERENCES users(id) ON DELETE SET NULL;
END $$;
