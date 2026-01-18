/**
 * Cost tracking types for OpenAI, ZakonOnline API, and SecondLayer MCP API usage
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

export interface ZOCallRecord {
  endpoint: string;
  timestamp: string;
  cached: boolean;
}

export interface SecondLayerCallRecord {
  operation: string; // 'web_scraping' | 'processing' | etc
  doc_id?: string | number;
  timestamp: string;
  cached: boolean;
}

export interface CostEstimate {
  openai_estimated_tokens: number;
  openai_estimated_cost_usd: number;
  zakononline_estimated_calls: number;
  zakononline_estimated_cost_usd: number;
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

  // ZakonOnline breakdown
  zakononline: {
    total_calls: number;
    monthly_total_before: number;
    monthly_total_after: number;
    total_cost_usd: number;
    current_tier: string;
    next_tier_at: number;
    calls: ZOCallRecord[];
  };

  // SecondLayer MCP breakdown
  secondlayer: {
    total_calls: number;
    monthly_total_before: number;
    monthly_total_after: number;
    total_cost_usd: number;
    current_tier: string;
    next_tier_at: number;
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

  zakononline_api_calls: number;
  zakononline_cost_usd: number;
  zakononline_monthly_total: number;
  zakononline_calls: ZOCallRecord[];

  secondlayer_api_calls: number;
  secondlayer_cost_usd: number;
  secondlayer_monthly_total: number;
  secondlayer_calls: SecondLayerCallRecord[];

  total_cost_usd: number;
  execution_time_ms: number;
  status: 'pending' | 'completed' | 'failed';
  error_message?: string;

  created_at: string;
  completed_at?: string;
}
