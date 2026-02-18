/**
 * API Request Types
 */

// Legal API
export interface GetLegalAdviceRequest {
  query: string;
  max_precedents?: number;
  max_tokens?: number;
  include_reasoning?: boolean;
}

export interface SearchCourtCasesRequest {
  query: string;
  limit?: number;
  offset?: number;
  filters?: {
    court?: string;
    date_from?: string;
    date_to?: string;
    category?: string;
  };
}

// Auth API
export interface UpdateProfileRequest {
  name?: string;
  picture?: string;
  phone?: string;
}

// Billing API
export interface UpdateBillingSettingsRequest {
  daily_limit_usd?: number;
  monthly_limit_usd?: number;
  email_notifications?: boolean;
}

export interface CreatePaymentRequest {
  amount_usd?: number;
  provider: 'stripe' | 'metamask' | 'binance_pay';
  metadata?: Record<string, any>;
}

export interface GetTransactionHistoryRequest {
  limit?: number;
  offset?: number;
  type?: 'deposit' | 'withdrawal' | 'usage';
  date_from?: string;
  date_to?: string;
}
