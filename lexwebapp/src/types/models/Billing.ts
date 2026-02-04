/**
 * Billing Domain Models
 */

export interface Balance {
  amount_usd: number;
  currency: 'USD' | 'UAH';
  lastUpdated: string;
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
  provider: 'stripe' | 'fondy';
  createdAt: string;
}
