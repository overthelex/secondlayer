export interface TimeEntry {
  id: string;
  matter_id: string;
  user_id: string;
  entry_date: string;
  duration_minutes: number;
  hourly_rate_usd: number;
  billable: boolean;
  status: 'draft' | 'submitted' | 'approved' | 'invoiced' | 'rejected';
  description: string;
  notes?: string;
  invoice_id?: string;
  created_by: string;
  approved_by?: string;
  submitted_at?: string;
  approved_at?: string;
  created_at: string;
  updated_at: string;
  // Joined fields
  matter_name?: string;
  user_name?: string;
  user_email?: string;
}

export interface ActiveTimer {
  id: string;
  user_id: string;
  matter_id: string;
  description?: string;
  started_at: string;
  last_ping_at: string;
  elapsed_seconds: number;
  // Joined fields
  matter_name?: string;
}

export interface UserBillingRate {
  id: string;
  user_id: string;
  hourly_rate_usd: number;
  effective_from: string;
  effective_to?: string;
  is_default: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Invoice {
  id: string;
  matter_id: string;
  invoice_number: string;
  status: 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled' | 'void';
  issue_date: string;
  due_date: string;
  subtotal_usd: number;
  tax_rate: number;
  tax_amount_usd: number;
  total_usd: number;
  amount_paid_usd: number;
  notes?: string;
  terms?: string;
  sent_at?: string;
  paid_at?: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  // Joined fields
  matter_name?: string;
  client_name?: string;
}

export interface InvoiceLineItem {
  id: string;
  invoice_id: string;
  time_entry_id?: string;
  description: string;
  quantity: number;
  unit_price_usd: number;
  amount_usd: number;
  line_order: number;
  created_at: string;
}

export interface InvoicePayment {
  id: string;
  invoice_id: string;
  amount_usd: number;
  payment_date: string;
  payment_method?: string;
  reference_number?: string;
  notes?: string;
  recorded_by: string;
  created_at: string;
  updated_at: string;
}

export interface InvoiceWithDetails extends Invoice {
  line_items: InvoiceLineItem[];
  payments: InvoicePayment[];
}

export interface CreateTimeEntryParams {
  matter_id: string;
  user_id?: string;
  entry_date?: string;
  duration_minutes: number;
  description: string;
  billable?: boolean;
  notes?: string;
}

export interface UpdateTimeEntryParams {
  entry_date?: string;
  duration_minutes?: number;
  description?: string;
  billable?: boolean;
  notes?: string;
}

export interface TimeEntryFilters {
  matter_id?: string;
  user_id?: string;
  status?: string;
  billable?: boolean;
  date_from?: string;
  date_to?: string;
  limit?: number;
  offset?: number;
}

export interface GenerateInvoiceParams {
  matter_id: string;
  time_entry_ids: string[];
  issue_date?: string;
  due_days?: number;
  tax_rate?: number;
  notes?: string;
  terms?: string;
}
