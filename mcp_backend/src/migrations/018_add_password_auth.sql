-- Migration: Add password authentication
-- Purpose: Add password field and login endpoint support
-- Author: SecondLayer Team
-- Date: 2026-02-02

-- Make google_id nullable to support password-based auth
ALTER TABLE users
ALTER COLUMN google_id DROP NOT NULL;

-- Add password_hash column to users table
ALTER TABLE users
ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

-- Add index for email lookups (for login)
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Insert admin user with password 'admin123'
-- Password hash is bcrypt hash of 'admin123' with salt rounds 10
-- Generated with: bcrypt.hash('admin123', 10)
INSERT INTO users (
  id,
  email,
  name,
  password_hash,
  email_verified,
  created_at
)
VALUES (
  gen_random_uuid(),
  'admin@secondlayer.com',
  'Admin User',
  '$2b$10$82A0rQ0SI0zwQUEjnNa6pujeEGaNNbahTKdYfqSzu.Jdtgzt9acOK', -- admin123
  true,
  NOW()
)
ON CONFLICT (email) DO UPDATE
SET password_hash = EXCLUDED.password_hash,
    name = EXCLUDED.name;

COMMENT ON COLUMN users.password_hash IS 'Bcrypt hashed password for email/password authentication';
