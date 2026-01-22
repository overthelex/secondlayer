/**
 * ADR-002 Target Prompt Architecture - Core Type Definitions
 *
 * These types define the abstractions for centralized, versioned prompt management.
 * They replace the distributed, hardcoded prompt construction pattern.
 */

/**
 * Describes WHAT and WHY we're prompting the LLM
 */
export interface PromptIntent {
  name: 'classify_intent' | 'extract_keywords' | 'sectionize' | 'legal_reasoning' | 'hallucination_check';
  reasoning_budget: 'quick' | 'standard' | 'deep';
  output_schema?: any; // JSON schema for structured output
}

/**
 * The data context for prompt assembly
 */
export interface PromptContext {
  sources: SourceBlock[];
  user_query?: string;
  conversation_history?: Array<{ role: string; content: string }>;
  metadata: {
    request_id: string;
    user_id?: string;
    tool_name?: string;
  };
}

/**
 * Constraints and safety rules for prompt execution
 */
export interface PromptPolicy {
  max_tokens: number;
  temperature: number;
  allow_external_sources: boolean;
  require_citations: boolean;
  hallucination_guard_level: 'none' | 'basic' | 'strict';
  retry_on_failure: boolean;
}

/**
 * Reusable prompt building blocks
 */
export interface PromptTemplate {
  id: string;
  intent: PromptIntent['name'];
  template: string; // Template with {{variable}} placeholders
  variables: string[]; // Required variables
  version: string;
}

/**
 * Typed source injection - sources NEVER go into system messages
 */
export interface SourceBlock {
  type: 'raw_text' | 'section' | 'pattern' | 'citation' | 'legal_article';
  payload: any;
  trust_level: 'primary' | 'derived';
  metadata?: Record<string, any>;
}

/**
 * The final assembled prompt ready for LLM execution
 */
export interface PromptInstance {
  intent: PromptIntent;
  system: SystemInstruction[];
  user: string;
  sources: SourceBlock[];
  constraints: PromptPolicy;
  metadata: {
    version: string;
    template_id: string;
    assembled_at: Date;
    instance_id: string;
  };
}

/**
 * Versioned system instruction
 */
export interface SystemInstruction {
  id: string;
  scope: PromptIntent['name'][];
  text: string;
  version: string;
  priority: number; // Order in system message array
}

/**
 * Execution result with lifecycle tracking
 */
export interface PromptExecutionResult {
  instance_id: string;
  intent: PromptIntent;
  output: any;
  model_used: string;
  tokens_used: { input: number; output: number };
  cost_usd: number;
  execution_time_ms: number;
  validation_passed: boolean;
  retry_count: number;
  created_at: Date;
}
