-- Migration 025: Team Management Schema
-- Creates organizations, organization members, and payment methods tables

-- Create organizations table
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan VARCHAR(50) DEFAULT 'free',
  max_members INTEGER DEFAULT 10,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE organizations IS 'Organizations/teams that group users together';
COMMENT ON COLUMN organizations.plan IS 'Current pricing plan: free, professional, business, enterprise';
COMMENT ON COLUMN organizations.max_members IS 'Maximum number of members allowed for this plan';

-- Create organization members table
CREATE TABLE IF NOT EXISTS organization_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('owner', 'admin', 'user', 'observer')),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('active', 'inactive', 'pending')),
  invited_at TIMESTAMP DEFAULT NOW(),
  joined_at TIMESTAMP,
  last_active TIMESTAMP,
  UNIQUE(organization_id, email)
);

COMMENT ON TABLE organization_members IS 'Members of organizations with roles and status';
COMMENT ON COLUMN organization_members.role IS 'Role in organization: owner, admin, user, observer';
COMMENT ON COLUMN organization_members.status IS 'Membership status: active, inactive, pending';

-- Create indices for faster queries
CREATE INDEX IF NOT EXISTS idx_org_members_org ON organization_members(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_email ON organization_members(email);
CREATE INDEX IF NOT EXISTS idx_organizations_owner ON organizations(owner_id);

-- Create payment methods table
CREATE TABLE IF NOT EXISTS payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL CHECK (provider IN ('stripe', 'fondy')),
  card_last4 VARCHAR(4),
  card_brand VARCHAR(20),
  card_bank VARCHAR(100),
  is_primary BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  provider_id VARCHAR(255) NOT NULL,
  UNIQUE(user_id, provider, provider_id)
);

COMMENT ON TABLE payment_methods IS 'Saved payment methods for users';
COMMENT ON COLUMN payment_methods.provider IS 'Payment provider: stripe or fondy';
COMMENT ON COLUMN payment_methods.is_primary IS 'Whether this is the default payment method';

-- Create index for payment methods
CREATE INDEX IF NOT EXISTS idx_payment_methods_user ON payment_methods(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_methods_primary ON payment_methods(user_id) WHERE is_primary = TRUE;

-- Create auto-update timestamp function if it doesn't exist
CREATE OR REPLACE FUNCTION update_timestamp() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for auto-update
DROP TRIGGER IF EXISTS update_organizations_timestamp ON organizations;
CREATE TRIGGER update_organizations_timestamp
BEFORE UPDATE ON organizations
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS update_payment_methods_timestamp ON payment_methods;
CREATE TRIGGER update_payment_methods_timestamp
BEFORE UPDATE ON payment_methods
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();
