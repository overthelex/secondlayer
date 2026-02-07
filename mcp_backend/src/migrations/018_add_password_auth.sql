-- Migration: Add password authentication
-- Purpose: Add password field and login endpoint support
-- Author: SecondLayer Team
-- Date: 2026-02-02

-- Step 1: Make google_id nullable to support password-based auth
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'google_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE users ALTER COLUMN google_id DROP NOT NULL;
  END IF;
END $$;

-- Step 2: Add password_hash column to users table
ALTER TABLE users
ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

-- Step 3: Add index for email lookups (for login)
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Step 4: Admin user should be created via set-user-password.ts script after migration
-- Example: npx tsx src/scripts/set-user-password.ts admin@secondlayer.com <password>

COMMENT ON COLUMN users.password_hash IS 'Bcrypt hashed password for email/password authentication';
