/**
 * TypeScript Type Definitions
 * Shared types and interfaces for the payment system
 */

import { Request } from 'express';

// ============================================================================
// User Types
// ============================================================================

export type UserRole = 'user' | 'admin';

export interface User {
  id: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  google_id: string | null;
  role: UserRole;
  email_verified: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface UserWithBalance extends User {
  balance: number;
  lifetime_purchased: number;
  lifetime_used: number;
}

// ============================================================================
// Authentication Types
// ============================================================================

export interface JWTPayload {
  userId: string;
  email: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

export interface AuthenticatedRequest extends Request {
  user?: User;
}

export interface APIKey {
  id: string;
  user_id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

// ============================================================================
// Subscription Types
// ============================================================================

export interface SubscriptionPlan {
  id: string;
  name: string;
  price_monthly: number;
  price_yearly: number | null;
  token_limit_monthly: number | null; // null = unlimited
  features: string[];
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export type SubscriptionStatus = 'active' | 'cancelled' | 'past_due' | 'expired';
export type BillingCycle = 'monthly' | 'yearly';

export interface Subscription {
  id: string;
  user_id: string;
  plan_id: string;
  status: SubscriptionStatus;
  billing_cycle: BillingCycle;
  current_period_start: Date;
  current_period_end: Date;
  cancel_at_period_end: boolean;
  stripe_subscription_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SubscriptionWithPlan extends Subscription {
  plan: SubscriptionPlan;
}

// ============================================================================
// Payment Types
// ============================================================================

export type PaymentMethodType = 'stripe_card' | 'monobank' | 'crypto_wallet';

export interface PaymentMethod {
  id: string;
  user_id: string;
  type: PaymentMethodType;
  stripe_payment_method_id: string | null;
  card_brand: string | null;
  card_last4: string | null;
  wallet_address: string | null;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

export type InvoiceType = 'subscription' | 'token_purchase' | 'refund';
export type InvoiceStatus = 'pending' | 'paid' | 'failed' | 'refunded';

export interface Invoice {
  id: string;
  user_id: string;
  subscription_id: string | null;
  invoice_number: string;
  type: InvoiceType;
  amount_usd: number;
  tokens_granted: number | null;
  status: InvoiceStatus;
  payment_method_id: string | null;
  stripe_invoice_id: string | null;
  issued_at: Date;
  paid_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// ============================================================================
// Token Types
// ============================================================================

export interface UserTokenBalance {
  user_id: string;
  balance: number;
  lifetime_purchased: number;
  lifetime_used: number;
  updated_at: Date;
}

export type TokenTransactionType = 'subscription_grant' | 'purchase' | 'usage' | 'admin_adjust' | 'refund';

export interface TokenTransaction {
  id: string;
  user_id: string;
  type: TokenTransactionType;
  amount: number; // Positive for add, negative for deduct
  balance_after: number;
  description: string | null;
  related_invoice_id: string | null;
  related_request_id: string | null;
  created_at: Date;
}

// ============================================================================
// Usage Tracking Types
// ============================================================================

export interface UserMonthlyUsage {
  user_id: string;
  year_month: string; // Format: 'YYYY-MM'
  tokens_used: number;
  api_calls: number;
  cost_usd: number;
}

export interface UsageSummary {
  user_id: string;
  email: string;
  name: string | null;
  current_balance: number;
  lifetime_purchased: number;
  lifetime_used: number;
  subscription_status: SubscriptionStatus | null;
  subscription_plan: string | null;
  token_limit_monthly: number | null;
  tokens_used_this_month: number;
  api_calls_this_month: number;
  cost_usd_this_month: number;
}

// ============================================================================
// Audit Log Types
// ============================================================================

export interface AuditLog {
  id: string;
  user_id: string | null;
  admin_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  details: Record<string, any> | null;
  ip_address: string | null;
  created_at: Date;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface RegisterRequest {
  email: string;
  password: string;
  name?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: Omit<User, 'password_hash'>;
}

export interface SubscribeRequest {
  plan_id: string;
  billing_cycle: BillingCycle;
  payment_method_id?: string;
}

export interface BuyTokensRequest {
  amount_usd: number;
  payment_method_id?: string;
}

export interface CreateAPIKeyRequest {
  name: string;
}

export interface CreateAPIKeyResponse {
  api_key: string; // Full key (only shown once!)
  key_prefix: string;
  name: string;
  created_at: Date;
}

// ============================================================================
// Admin Types
// ============================================================================

export interface AdminStats {
  totalUsers: number;
  activeSubscriptions: number;
  monthlyRevenue: number;
  totalTokensUsed: number;
  newUsersThisMonth: number;
  topTools: Array<{ tool: string; calls: number }>;
}

// ============================================================================
// Stripe Webhook Types
// ============================================================================

export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: {
    object: any;
  };
}

// ============================================================================
// Error Types
// ============================================================================

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public isOperational = true
  ) {
    super(message);
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized') {
    super(401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden') {
    super(403, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found') {
    super(404, message);
  }
}
