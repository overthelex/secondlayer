/**
 * Client Domain Model
 * Aligned with backend clients table (migration 032)
 */

export type ClientType = 'individual' | 'business' | 'government';
export type ClientStatus = 'active' | 'inactive' | 'archived';
export type ConflictStatus = 'unchecked' | 'clear' | 'flagged' | 'conflicted';

export interface Client {
  id: string;
  organization_id: string;
  client_name: string;
  client_type: ClientType;
  contact_email: string | null;
  tax_id: string | null;
  status: ClientStatus;
  conflict_check_date: string | null;
  conflict_status: ConflictStatus;
  metadata: Record<string, any>;
  created_at: string;
  created_by: string;
}

export interface CreateClientRequest {
  clientName: string;
  clientType?: ClientType;
  contactEmail?: string;
  taxId?: string;
  metadata?: Record<string, any>;
}

export interface UpdateClientRequest {
  clientName?: string;
  clientType?: ClientType;
  contactEmail?: string;
  taxId?: string;
  status?: ClientStatus;
  metadata?: Record<string, any>;
}

export interface ClientsListResponse {
  clients: Client[];
  total: number;
}
