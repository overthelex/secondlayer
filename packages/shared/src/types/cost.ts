/**
 * Shared cost tracking types for OpenAI, Anthropic, ZakonOnline, RADA API, and SecondLayer API usage
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

export interface ZOCallRecord {
  endpoint: string;
  timestamp: string;
  cached: boolean;
}

export interface RadaAPICallRecord {
  endpoint: string;
  timestamp: string;
  cached: boolean;
  bytes?: number;
}

export interface SecondLayerCallRecord {
  operation?: string;
  tool_name?: string;
  doc_id?: string | number;
  timestamp: string;
  cached?: boolean;
  cost_usd?: number;
}

export interface DatabaseQueryRecord {
  query_type: string;
  execution_time_ms: number;
  rows_returned: number;
  timestamp: string;
}

export interface CostEstimate {
  openai_estimated_tokens: number;
  openai_estimated_cost_usd: number;
  anthropic_estimated_tokens?: number;
  anthropic_estimated_cost_usd?: number;
  zakononline_estimated_calls?: number;
  zakononline_estimated_cost_usd?: number;
  rada_estimated_calls?: number;
  database_estimated_queries?: number;
  secondlayer_estimated_calls: number;
  secondlayer_estimated_cost_usd: number;
  total_estimated_cost_usd: number;
  estimation_notes: string[];
}

export interface CostBreakdown {
  request_id: string;

  openai: {
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_cost_usd: number;
    calls: OpenAICallRecord[];
  };

  anthropic?: {
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_cost_usd: number;
    calls: AnthropicCallRecord[];
  };

  zakononline?: {
    total_calls: number;
    monthly_total_before: number;
    monthly_total_after: number;
    total_cost_usd: number;
    current_tier: string;
    next_tier_at: number;
    calls: ZOCallRecord[];
  };

  rada_api?: {
    total_calls: number;
    cached_calls: number;
    total_bytes: number;
    calls: RadaAPICallRecord[];
  };

  database?: {
    total_queries: number;
    total_rows: number;
    calls: DatabaseQueryRecord[];
  };

  secondlayer: {
    total_calls: number;
    monthly_total_before?: number;
    monthly_total_after?: number;
    total_cost_usd: number;
    current_tier?: string;
    next_tier_at?: number;
    calls: SecondLayerCallRecord[];
  };

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

  anthropic_total_tokens?: number;
  anthropic_prompt_tokens?: number;
  anthropic_completion_tokens?: number;
  anthropic_cost_usd?: number;
  anthropic_calls?: AnthropicCallRecord[];

  zakononline_api_calls?: number;
  zakononline_cost_usd?: number;
  zakononline_monthly_total?: number;
  zakononline_calls?: ZOCallRecord[];

  rada_api_calls?: number;
  rada_api_cached?: number;
  rada_api_bytes?: number;
  rada_calls?: RadaAPICallRecord[];

  secondlayer_api_calls: number;
  secondlayer_cost_usd: number;
  secondlayer_monthly_total?: number;
  secondlayer_calls: SecondLayerCallRecord[];

  total_cost_usd: number;
  execution_time_ms: number;
  status: 'pending' | 'completed' | 'failed';
  error_message?: string;

  created_at: string;
  completed_at?: string;
}

export interface MonthlyAPIUsage {
  year_month: string;
  openai_total_tokens?: number;
  openai_total_cost_usd?: number;
  anthropic_total_tokens?: number;
  anthropic_total_cost_usd?: number;
  zakononline_total_calls?: number;
  zakononline_total_cost_usd?: number;
  rada_total_calls?: number;
  rada_total_cached?: number;
  rada_total_bytes?: number;
  secondlayer_total_calls?: number;
  secondlayer_total_cost_usd?: number;
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
