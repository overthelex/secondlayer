/**
 * Billing Domain Models
 */

export interface Balance {
  amount_usd: number;
  currency: 'USD' | 'UAH';
  lastUpdated: string;
}

export interface BillingBalance {
  user_id: string;
  balance_usd: number;
  balance_uah: number;
  total_spent_usd: number;
  total_requests: number;
  daily_limit_usd: number;
  monthly_limit_usd: number;
  pricing_tier: string;
  today_spent_usd: number;
  month_spent_usd: number;
  last_request_at?: string;
}

export interface Transaction {
  id: string;
  type: 'deposit' | 'withdrawal' | 'usage';
  amount: number;
  currency: 'USD' | 'UAH';
  description: string;
  timestamp: string;
  status: 'pending' | 'completed' | 'failed';
}

export interface BillingSettings {
  daily_limit_usd?: number;
  monthly_limit_usd?: number;
  email_notifications?: boolean;
  low_balance_alert?: number;
}

export interface PaymentIntent {
  id: string;
  amount: number;
  currency: 'USD' | 'UAH';
  status: 'pending' | 'succeeded' | 'failed';
  provider: 'stripe' | 'metamask' | 'binance_pay';
  createdAt: string;
}
