/**
 * Message Domain Model
 */

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
  thinkingSteps?: ThinkingStep[];
  decisions?: Decision[];
  citations?: Citation[];
  documents?: VaultDocument[];
}

export interface ThinkingStep {
  id: string;
  title: string;
  content: string;
  isComplete: boolean;
}

export interface Decision {
  id: string;
  number: string;
  court: string;
  date: string;
  summary: string;
  relevance: number;
  status: 'active' | 'overturned' | 'modified';
}

export interface Citation {
  text: string;
  source: string;
}

export interface VaultDocument {
  id: string;
  title: string;
  type: string;
  uploadedAt?: string;
  metadata?: Record<string, any>;
}
