/**
 * API Response Types
 */

import { Message, User, Balance, Transaction, Client, Person } from '../models';

// Common response wrapper
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

// Legal API Responses
export interface GetLegalAdviceResponse {
  answer: string;
  summary?: string;
  reasoning_chain?: ReasoningStep[];
  precedent_chunks?: PrecedentChunk[];
  source_attribution?: SourceAttribution[];
  cost?: {
    tokens: number;
    usd: number;
  };
}

export interface ReasoningStep {
  step: number;
  action: string;
  explanation?: string;
  output?: any;
}

export interface PrecedentChunk {
  case_number?: string;
  number?: string;
  court?: string;
  date?: string;
  summary?: string;
  reasoning?: string;
  content?: string;
  similarity?: number;
  relevance?: number;
}

export interface SourceAttribution {
  text?: string;
  content?: string;
  citation?: string;
  source?: string;
}

// Auth API Responses
export interface GetMeResponse {
  user: User;
}

export interface LoginResponse {
  token: string;
  user: User;
}

export interface RefreshTokenResponse {
  token: string;
}

// Billing API Responses
export interface GetBalanceResponse {
  balance: Balance;
}

export interface GetTransactionHistoryResponse {
  transactions: Transaction[];
  total: number;
  hasMore: boolean;
}

export interface CreatePaymentResponse {
  payment_id: string;
  checkout_url?: string;
  status: 'pending' | 'succeeded' | 'failed';
}

// Generic list response
export interface ListResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}
