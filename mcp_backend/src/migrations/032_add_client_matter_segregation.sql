-- Migration 032: Client-Matter Segregation
-- GDPR compliance: data isolation by client/matter for legal firms

-- Clients table — law firm clients (tied to organization)
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  client_type VARCHAR(20) NOT NULL DEFAULT 'individual'
    CHECK (client_type IN ('individual', 'business', 'government')),
  contact_email TEXT,
  tax_id TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'archived')),
  conflict_check_date TIMESTAMPTZ,
  conflict_status VARCHAR(20) NOT NULL DEFAULT 'unchecked'
    CHECK (conflict_status IN ('unchecked', 'clear', 'flagged', 'conflicted')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_clients_organization ON clients(organization_id);
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_clients_name ON clients(organization_id, client_name);
CREATE INDEX IF NOT EXISTS idx_clients_tax_id ON clients(tax_id) WHERE tax_id IS NOT NULL;

-- Matters table — cases/matters (tied to client)
CREATE TABLE IF NOT EXISTS matters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  matter_number TEXT NOT NULL UNIQUE,
  matter_name TEXT NOT NULL,
  matter_type TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'active', 'closed', 'archived')),
  opened_date TIMESTAMPTZ DEFAULT NOW(),
  closed_date TIMESTAMPTZ,
  responsible_attorney UUID REFERENCES users(id) ON DELETE SET NULL,
  opposing_party TEXT,
  court_case_number TEXT,
  court_name TEXT,
  related_parties JSONB DEFAULT '[]',
  retention_period_years INT DEFAULT 7,
  legal_hold BOOLEAN DEFAULT FALSE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_matters_client ON matters(client_id);
CREATE INDEX IF NOT EXISTS idx_matters_status ON matters(status);
CREATE INDEX IF NOT EXISTS idx_matters_number ON matters(matter_number);
CREATE INDEX IF NOT EXISTS idx_matters_responsible ON matters(responsible_attorney);
CREATE INDEX IF NOT EXISTS idx_matters_legal_hold ON matters(legal_hold) WHERE legal_hold = TRUE;
CREATE INDEX IF NOT EXISTS idx_matters_opposing_party ON matters(opposing_party) WHERE opposing_party IS NOT NULL;

-- Matter team — users assigned to a matter
CREATE TABLE IF NOT EXISTS matter_team (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  matter_id UUID NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(30) NOT NULL DEFAULT 'associate'
    CHECK (role IN ('lead_attorney', 'associate', 'paralegal', 'assistant', 'observer')),
  access_level VARCHAR(20) NOT NULL DEFAULT 'full'
    CHECK (access_level IN ('full', 'read-only', 'limited')),
  added_at TIMESTAMPTZ DEFAULT NOW(),
  added_by UUID REFERENCES users(id) ON DELETE SET NULL,
  removed_at TIMESTAMPTZ,
  UNIQUE(matter_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_matter_team_matter ON matter_team(matter_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_matter_team_user ON matter_team(user_id) WHERE removed_at IS NULL;

-- ALTER existing tables: add matter/client references

-- documents: add matter_id, client_id, document_class, privilege_status
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'matter_id'
  ) THEN
    ALTER TABLE documents ADD COLUMN matter_id UUID REFERENCES matters(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'client_id'
  ) THEN
    ALTER TABLE documents ADD COLUMN client_id UUID REFERENCES clients(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'document_class'
  ) THEN
    ALTER TABLE documents ADD COLUMN document_class VARCHAR(30);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'privilege_status'
  ) THEN
    ALTER TABLE documents ADD COLUMN privilege_status VARCHAR(30);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_documents_matter ON documents(matter_id) WHERE matter_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_client ON documents(client_id) WHERE client_id IS NOT NULL;

-- conversations: add client_id, matter_id
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'client_id'
  ) THEN
    ALTER TABLE conversations ADD COLUMN client_id UUID REFERENCES clients(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'matter_id'
  ) THEN
    ALTER TABLE conversations ADD COLUMN matter_id UUID REFERENCES matters(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conversations_matter ON conversations(matter_id) WHERE matter_id IS NOT NULL;

-- upload_sessions: add matter_id
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'upload_sessions' AND column_name = 'matter_id'
  ) THEN
    ALTER TABLE upload_sessions ADD COLUMN matter_id UUID REFERENCES matters(id) ON DELETE SET NULL;
  END IF;
END $$;
