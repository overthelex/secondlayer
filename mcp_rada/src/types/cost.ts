/**
 * Cost tracking types for OpenAI, Anthropic, RADA API, and SecondLayer API usage
 */

export interface OpenAICallRecord {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  task: string;
  timestamp: string;
}

export interface AnthropicCallRecord {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  task: string;
  timestamp: string;
}

export interface RadaAPICallRecord {
  endpoint: string;
  timestamp: string;
  cached: boolean;
  bytes?: number;
}

export interface SecondLayerCallRecord {
  tool_name: string;
  timestamp: string;
  cost_usd: number;
}

export interface CostEstimate {
  openai_estimated_tokens: number;
  openai_estimated_cost_usd: number;
  anthropic_estimated_tokens: number;
  anthropic_estimated_cost_usd: number;
  rada_estimated_calls: number;
  secondlayer_estimated_calls: number;
  secondlayer_estimated_cost_usd: number;
  total_estimated_cost_usd: number;
  estimation_notes: string[];
}

export interface CostBreakdown {
  request_id: string;

  // OpenAI breakdown
  openai: {
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_cost_usd: number;
    calls: OpenAICallRecord[];
  };

  // Anthropic breakdown
  anthropic: {
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_cost_usd: number;
    calls: AnthropicCallRecord[];
  };

  // RADA API breakdown (FREE but track usage)
  rada_api: {
    total_calls: number;
    cached_calls: number;
    total_bytes: number;
    calls: RadaAPICallRecord[];
  };

  // SecondLayer API breakdown (for cross-referencing)
  secondlayer: {
    total_calls: number;
    total_cost_usd: number;
    calls: SecondLayerCallRecord[];
  };

  // Totals
  totals: {
    cost_usd: number;
    execution_time_ms: number;
  };
}

export interface CostTrackingRecord {
  id: string;
  request_id: string;
  tool_name: string;
  client_key: string;
  user_query: string;
  query_params: any;

  openai_total_tokens: number;
  openai_prompt_tokens: number;
  openai_completion_tokens: number;
  openai_cost_usd: number;
  openai_calls: OpenAICallRecord[];

  anthropic_total_tokens: number;
  anthropic_prompt_tokens: number;
  anthropic_completion_tokens: number;
  anthropic_cost_usd: number;
  anthropic_calls: AnthropicCallRecord[];

  rada_api_calls: number;
  rada_api_cached: number;
  rada_api_bytes: number;
  rada_calls: RadaAPICallRecord[];

  secondlayer_api_calls: number;
  secondlayer_cost_usd: number;
  secondlayer_calls: SecondLayerCallRecord[];

  total_cost_usd: number;
  execution_time_ms: number;
  status: 'pending' | 'completed' | 'failed';
  error_message?: string;

  created_at: string;
  completed_at?: string;
}

export interface MonthlyAPIUsage {
  year_month: string; // 'YYYY-MM'
  openai_total_tokens: number;
  openai_total_cost_usd: number;
  anthropic_total_tokens: number;
  anthropic_total_cost_usd: number;
  rada_total_calls: number;
  rada_total_cached: number;
  rada_total_bytes: number;
  secondlayer_total_calls: number;
  secondlayer_total_cost_usd: number;
  updated_at: string;
}

export interface ToolUsageStats {
  tool_name: string;
  year_month: string;
  total_calls: number;
  successful_calls: number;
  failed_calls: number;
  avg_execution_time_ms: number;
  max_execution_time_ms: number;
  min_execution_time_ms: number;
  total_cost_usd: number;
  updated_at: string;
}
