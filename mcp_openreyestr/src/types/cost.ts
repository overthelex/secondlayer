/**
 * Cost tracking types for OpenReyestr MCP Server
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

export interface SecondLayerCallRecord {
  tool_name: string;
  timestamp: string;
  cost_usd: number;
}

export interface DatabaseQueryRecord {
  query_type: string; // 'search', 'details', 'beneficiaries', 'edrpou', 'stats'
  execution_time_ms: number;
  rows_returned: number;
  timestamp: string;
}

export interface CostEstimate {
  openai_estimated_tokens: number;
  openai_estimated_cost_usd: number;
  anthropic_estimated_tokens: number;
  anthropic_estimated_cost_usd: number;
  database_estimated_queries: number;
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
  anthropic: {
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_cost_usd: number;
    calls: AnthropicCallRecord[];
  };
  database: {
    total_queries: number;
    total_rows: number;
    calls: DatabaseQueryRecord[];
  };
  secondlayer: {
    total_calls: number;
    total_cost_usd: number;
    calls: SecondLayerCallRecord[];
  };
  totals: {
    cost_usd: number;
    execution_time_ms: number;
  };
}
