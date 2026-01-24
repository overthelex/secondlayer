/**
 * Shared HTTP server types and interfaces
 */

import { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  clientKey?: string;
  user?: {
    id: string;
    email: string;
    name?: string;
  };
}

export interface HealthCheckResponse {
  status: 'ok' | 'error';
  service: string;
  version: string;
  timestamp?: string;
}

export interface ToolCallRequest {
  arguments?: any;
  [key: string]: any;
}

export interface ToolCallResponse {
  success: boolean;
  tool: string;
  result?: any;
  error?: string;
  message?: string;
  cost_tracking?: {
    request_id: string;
    estimate_before?: any;
    actual_cost?: any;
  };
}

export interface BatchToolCall {
  name: string;
  arguments?: any;
}

export interface BatchToolCallResponse {
  success: boolean;
  results: Array<{
    tool: string;
    success: boolean;
    result?: any;
    error?: string;
  }>;
}
