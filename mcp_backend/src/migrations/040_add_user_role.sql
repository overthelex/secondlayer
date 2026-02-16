-- Migration 040: Add user role column
-- Roles: user (individual), company (law firm), administrator (system admin)

ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'user';

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('user', 'company', 'administrator'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Migrate existing admins
UPDATE users SET role = 'administrator' WHERE is_admin = true AND role = 'user';
