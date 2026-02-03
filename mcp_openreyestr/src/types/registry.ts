/**
 * Types for NAIS OpenReyestr registries
 */

export interface Debtor {
  id: string;
  proceeding_number: string;
  debtor_name: string;
  debtor_edrpou?: string;
  debtor_type: 'individual' | 'legal_entity';
  issuing_authority?: string;
  issuing_person?: string;
  enforcement_agency?: string;
  executor_name?: string;
  executor_phone?: string;
  executor_email?: string;
  collection_category?: string;
  raw_data?: any;
  data_source: string;
  source_file?: string;
  created_at: Date;
  updated_at: Date;
}

export interface LegalEntity {
  id: string;
  edrpou: string;
  full_name: string;
  short_name?: string;
  legal_form?: string;
  status: 'active' | 'inactive' | 'liquidated' | 'bankruptcy';
  registration_date?: Date;
  termination_date?: Date;
  address?: string;
  region?: string;
  district?: string;
  founders?: any;
  management?: any;
  authorized_capital?: number;
  economic_activity_type?: string;
  tax_number?: string;
  raw_data?: any;
  data_source: string;
  source_file?: string;
  created_at: Date;
  updated_at: Date;
}

export interface Notary {
  id: string;
  certificate_number: string;
  full_name: string;
  region?: string;
  district?: string;
  organization?: string;
  address?: string;
  phone?: string;
  email?: string;
  certificate_date?: Date;
  status: 'active' | 'suspended' | 'terminated';
  raw_data?: any;
  data_source: string;
  source_file?: string;
  created_at: Date;
  updated_at: Date;
}

export interface EnforcementProceeding {
  id: string;
  proceeding_number: string;
  opening_date?: Date;
  proceeding_status?: string;
  debtor_name?: string;
  debtor_edrpou?: string;
  debtor_type?: 'individual' | 'legal_entity';
  creditor_name?: string;
  creditor_edrpou?: string;
  creditor_type?: 'individual' | 'legal_entity';
  enforcement_agency?: string;
  executor_name?: string;
  raw_data?: any;
  data_source: string;
  source_file?: string;
  created_at: Date;
  updated_at: Date;
}

// Search arguments
export interface SearchDebtorsArgs {
  name?: string;
  edrpou?: string;
  proceeding_number?: string;
  category?: string;
  limit?: number;
}

export interface SearchLegalEntitiesArgs {
  query?: string;
  edrpou?: string;
  status?: 'active' | 'inactive' | 'liquidated' | 'bankruptcy' | 'all';
  region?: string;
  limit?: number;
}

export interface GetLegalEntityDetailsArgs {
  edrpou: string;
  include_debtors?: boolean;
  include_bankruptcy?: boolean;
}

export interface SearchNotariesArgs {
  name?: string;
  region?: string;
  certificate_number?: string;
  status?: 'active' | 'suspended' | 'terminated' | 'all';
  limit?: number;
}
