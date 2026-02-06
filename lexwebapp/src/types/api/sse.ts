/**
 * SSE (Server-Sent Events) Types
 * Types for real-time streaming communication with MCP backend
 */

export interface SSEEvent {
  id?: string;
  event: SSEEventType;
  data: any;
}

export type SSEEventType = 'connected' | 'progress' | 'complete' | 'error' | 'end';

export interface SSEProgressEvent {
  step: number;
  action: string;
  message: string;
  progress: number; // 0.0 to 1.0
  result?: any;
  current?: number;
  total?: number;
}

export interface SSECompleteEvent {
  summary?: string;
  result?: any;
  [key: string]: any; // Different tools return different structures
}

export interface SSEErrorEvent {
  message: string;
  error?: any;
  code?: string;
}

export interface StreamingCallbacks {
  onConnected?: (data: any) => void;
  onProgress?: (data: SSEProgressEvent) => void;
  onComplete?: (data: SSECompleteEvent) => void;
  onError?: (data: SSEErrorEvent) => void;
  onEnd?: () => void;
}
