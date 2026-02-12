/**
 * Matter Domain Models
 * Aligned with backend matters/legal_holds/audit_log tables (migrations 032-034)
 */

// ─── Matter Types ──────────────────────────────────────────

export type MatterStatus = 'open' | 'active' | 'closed' | 'archived';

export type MatterType =
  | 'litigation'
  | 'advisory'
  | 'transactional'
  | 'regulatory'
  | 'arbitration'
  | 'other';

export interface Matter {
  id: string;
  client_id: string;
  matter_number: string;
  matter_name: string;
  matter_type: MatterType;
  status: MatterStatus;
  responsible_attorney: string | null;
  opposing_party: string | null;
  court_case_number: string | null;
  court_name: string | null;
  related_parties: string[] | null;
  retention_period_years: number;
  has_legal_hold: boolean;
  metadata: Record<string, any>;
  opened_date: string;
  closed_date: string | null;
  created_at: string;
  created_by: string;
  // Joined fields
  client_name?: string;
}

export interface CreateMatterRequest {
  clientId: string;
  matterName: string;
  matterType?: MatterType;
  responsibleAttorney?: string;
  opposingParty?: string;
  courtCaseNumber?: string;
  courtName?: string;
  relatedParties?: string[];
  retentionPeriodYears?: number;
  metadata?: Record<string, any>;
}

export interface UpdateMatterRequest {
  matterName?: string;
  matterType?: MatterType;
  status?: MatterStatus;
  responsibleAttorney?: string;
  opposingParty?: string;
  courtCaseNumber?: string;
  courtName?: string;
  relatedParties?: string[];
  retentionPeriodYears?: number;
  metadata?: Record<string, any>;
}

export interface MattersListResponse {
  matters: Matter[];
  total: number;
}

// ─── Team Types ────────────────────────────────────────────

export type MatterTeamRole =
  | 'lead_attorney'
  | 'associate'
  | 'paralegal'
  | 'counsel'
  | 'admin'
  | 'observer';

export type MatterAccessLevel = 'full' | 'read_only' | 'documents_only';

export interface MatterTeamMember {
  id: string;
  matter_id: string;
  user_id: string;
  role: MatterTeamRole;
  access_level: MatterAccessLevel;
  added_at: string;
  added_by: string;
  // Joined
  user_name?: string;
  user_email?: string;
}

// ─── Legal Hold Types ──────────────────────────────────────

export type HoldType = 'litigation' | 'regulatory' | 'investigation' | 'preservation';
export type HoldStatus = 'active' | 'released' | 'expired';

export interface LegalHold {
  id: string;
  matter_id: string;
  hold_name: string;
  hold_type: HoldType;
  status: HoldStatus;
  scope_description: string | null;
  custodians: string[] | null;
  created_at: string;
  created_by: string;
  released_at: string | null;
  released_by: string | null;
}

export interface CreateHoldRequest {
  holdName: string;
  holdType?: HoldType;
  scopeDescription?: string;
  custodians?: string[];
}

// ─── Audit Types ───────────────────────────────────────────

export interface AuditLogEntry {
  id: string;
  user_id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: Record<string, any>;
  ip_address: string | null;
  hash: string;
  previous_hash: string | null;
  created_at: string;
  // Joined
  user_name?: string;
}

export interface AuditLogResponse {
  entries: AuditLogEntry[];
  total: number;
}

export interface AuditValidationResult {
  valid: boolean;
  checked: number;
  broken_at?: number;
  message: string;
}

// ─── Conflict Types ────────────────────────────────────────

export interface ConflictMatch {
  type: string;
  matched_entity: string;
  client_id?: string;
  matter_id?: string;
  details: Record<string, any>;
}

export interface ConflictResult {
  has_conflicts: boolean;
  matches: ConflictMatch[];
  checked_at: string;
}
