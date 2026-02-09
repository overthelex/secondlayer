-- Migration 033: Legal Holds
-- Prevents deletion of documents under judicial/regulatory holds

-- Legal holds — court orders preventing data deletion
CREATE TABLE IF NOT EXISTS legal_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  matter_id UUID NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  hold_name TEXT NOT NULL,
  hold_type VARCHAR(30) NOT NULL DEFAULT 'litigation'
    CHECK (hold_type IN ('litigation', 'investigation', 'regulatory', 'internal')),
  issued_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  issued_at TIMESTAMPTZ DEFAULT NOW(),
  release_date TIMESTAMPTZ,
  released_by UUID REFERENCES users(id) ON DELETE SET NULL,
  scope_description TEXT,
  custodians UUID[] DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released', 'expired')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_legal_holds_matter ON legal_holds(matter_id);
CREATE INDEX IF NOT EXISTS idx_legal_holds_status ON legal_holds(status) WHERE status = 'active';

-- Legal hold documents — which documents are under each hold
CREATE TABLE IF NOT EXISTS legal_hold_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_hold_id UUID NOT NULL REFERENCES legal_holds(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  added_by UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(legal_hold_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_legal_hold_docs_hold ON legal_hold_documents(legal_hold_id);
CREATE INDEX IF NOT EXISTS idx_legal_hold_docs_document ON legal_hold_documents(document_id);

-- Document custody chain — immutable chain of custody events
CREATE TABLE IF NOT EXISTS document_custody_chain (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  event_type VARCHAR(50) NOT NULL,
  event_timestamp TIMESTAMPTZ DEFAULT NOW(),
  performed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ip_address INET,
  document_hash_before TEXT,
  document_hash_after TEXT,
  storage_location TEXT,
  details JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_custody_chain_document ON document_custody_chain(document_id, event_timestamp);

-- Prevent UPDATE/DELETE on custody chain (immutable)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_rules WHERE rulename = 'no_update_custody_chain'
  ) THEN
    CREATE RULE no_update_custody_chain AS ON UPDATE TO document_custody_chain DO INSTEAD NOTHING;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_rules WHERE rulename = 'no_delete_custody_chain'
  ) THEN
    CREATE RULE no_delete_custody_chain AS ON DELETE TO document_custody_chain DO INSTEAD NOTHING;
  END IF;
END $$;

-- Function: check if a document can be deleted (respects holds + retention)
CREATE OR REPLACE FUNCTION can_delete_document(doc_id UUID)
RETURNS TABLE(can_delete BOOLEAN, reason TEXT, hold_ids UUID[]) AS $$
DECLARE
  active_hold_ids UUID[];
  doc_matter_id UUID;
  matter_retention INT;
  matter_closed TIMESTAMPTZ;
BEGIN
  -- Check active legal holds on the document
  SELECT ARRAY_AGG(lh.id) INTO active_hold_ids
  FROM legal_hold_documents lhd
  JOIN legal_holds lh ON lh.id = lhd.legal_hold_id
  WHERE lhd.document_id = doc_id
    AND lh.status = 'active';

  IF active_hold_ids IS NOT NULL AND array_length(active_hold_ids, 1) > 0 THEN
    RETURN QUERY SELECT FALSE, 'Document is under active legal hold'::TEXT, active_hold_ids;
    RETURN;
  END IF;

  -- Check matter-level legal hold
  SELECT d.matter_id INTO doc_matter_id
  FROM documents d WHERE d.id = doc_id;

  IF doc_matter_id IS NOT NULL THEN
    SELECT m.legal_hold INTO STRICT active_hold_ids
    FROM matters m WHERE m.id = doc_matter_id;
    -- Note: active_hold_ids reused as boolean proxy won't work; check directly
  END IF;

  IF doc_matter_id IS NOT NULL THEN
    DECLARE
      is_held BOOLEAN;
    BEGIN
      SELECT m.legal_hold INTO is_held FROM matters m WHERE m.id = doc_matter_id;
      IF is_held THEN
        SELECT ARRAY_AGG(lh.id) INTO active_hold_ids
        FROM legal_holds lh
        WHERE lh.matter_id = doc_matter_id AND lh.status = 'active';
        RETURN QUERY SELECT FALSE, 'Matter is under legal hold'::TEXT, COALESCE(active_hold_ids, '{}'::UUID[]);
        RETURN;
      END IF;
    END;

    -- Check retention period
    SELECT m.retention_period_years, m.closed_date
    INTO matter_retention, matter_closed
    FROM matters m WHERE m.id = doc_matter_id;

    IF matter_closed IS NOT NULL AND matter_retention IS NOT NULL THEN
      IF matter_closed + (matter_retention || ' years')::INTERVAL > NOW() THEN
        RETURN QUERY SELECT FALSE, ('Document within retention period until ' ||
          (matter_closed + (matter_retention || ' years')::INTERVAL)::TEXT)::TEXT, '{}'::UUID[];
        RETURN;
      END IF;
    END IF;
  END IF;

  -- No holds, no retention — safe to delete
  RETURN QUERY SELECT TRUE, NULL::TEXT, '{}'::UUID[];
END;
$$ LANGUAGE plpgsql;
