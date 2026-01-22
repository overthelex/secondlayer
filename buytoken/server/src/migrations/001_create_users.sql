-- Migration: Create users table
-- Description: User accounts with support for email/password and Google OAuth2 authentication

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    password_hash VARCHAR(255), -- Nullable for OAuth-only users
    google_id VARCHAR(255) UNIQUE, -- Nullable for email/password users
    role VARCHAR(50) NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Index for faster lookups
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL;
CREATE INDEX idx_users_role ON users(role);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Create default admin user (password: admin123 - CHANGE IN PRODUCTION!)
-- Password hash for 'admin123' using bcrypt with 10 rounds
INSERT INTO users (email, name, password_hash, role, email_verified)
VALUES (
    'admin@secondlayer.legal',
    'System Administrator',
    '$2b$10$rKvhYF7XqJ8P5Kx5Kx5Kx5Kx5Kx5Kx5Kx5Kx5Kx5Kx5Kx5Kx5K', -- Placeholder hash
    'admin',
    TRUE
) ON CONFLICT (email) DO NOTHING;

COMMENT ON TABLE users IS 'User accounts with support for email/password and OAuth2 authentication';
COMMENT ON COLUMN users.password_hash IS 'BCrypt hash of password (nullable for OAuth-only users)';
COMMENT ON COLUMN users.google_id IS 'Google OAuth2 user ID (nullable for email/password users)';
COMMENT ON COLUMN users.role IS 'User role: user or admin';
