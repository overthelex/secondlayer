export enum SectionType {
  FACTS = 'FACTS',
  CLAIMS = 'CLAIMS',
  LAW_REFERENCES = 'LAW_REFERENCES',
  COURT_REASONING = 'COURT_REASONING',
  DECISION = 'DECISION',
  AMOUNTS = 'AMOUNTS',
}

export interface DocumentSection {
  type: SectionType;
  text: string;
  start_index: number;
  end_index: number;
  confidence: number;
}

export type PrecedentStatusType =
  | 'valid'
  | 'questioned'
  | 'limited'
  | 'implicitly_overruled'
  | 'explicitly_overruled'
  | 'unknown';

export interface PrecedentStatus {
  case_id: string;
  status: PrecedentStatusType;
  reversed_by?: string[];
  overruled_by?: string[];
  distinguished_in?: string[];
  last_checked: string;
  confidence: number;
  citation_chain?: CitationLink[];
}

export interface CitationLink {
  from_case_id: string;
  to_case_id: string;
  citation_type: 'follows' | 'distinguishes' | 'overrules' | 'references';
  context?: string;
  section_type?: SectionType;
  confidence: number;
}

export interface QueryIntent {
  intent: string;
  confidence: number;
  domains: string[];
  required_entities: string[];
  sections: SectionType[];
  time_range?: { from: string; to: string };
  reasoning_budget: 'quick' | 'standard' | 'deep';
}

export interface LegalPattern {
  id: string;
  intent: string;
  law_articles: string[];
  court_reasoning_vector?: number[];
  decision_outcome: 'consumer_won' | 'seller_won' | 'partial' | 'rejected';
  frequency: number;
  confidence: number;
  example_cases: string[];
  risk_factors: string[];
  success_arguments: string[];
  anti_patterns?: {
    description: string;
    why_fails: string;
    example_cases: string[];
  }[];
  created_at: string;
  updated_at: string;
}

export interface EmbeddingChunk {
  id: string;
  source: 'zakononline';
  doc_id: string;
  section_type: SectionType;
  text: string;
  embedding: number[];
  metadata: {
    date: string;
    court?: string;
    law_articles?: string[];
  };
  created_at: string;
}

export interface ValidationResult {
  is_valid: boolean;
  claims_without_sources: string[];
  invalid_citations: string[];
  confidence: number;
  warnings: string[];
}

export interface ReasoningBudget {
  max_llm_calls: number;
  max_tokens: number;
  strategy: 'cheap-first' | 'deep-only-if-needed';
}

export const BUDGETS: Record<string, ReasoningBudget> = {
  quick: {
    max_llm_calls: 1,
    max_tokens: 1000,
    strategy: 'cheap-first',
  },
  standard: {
    max_llm_calls: 3,
    max_tokens: 3000,
    strategy: 'cheap-first',
  },
  deep: {
    max_llm_calls: 5,
    max_tokens: 5000,
    strategy: 'deep-only-if-needed',
  },
};

export interface EnhancedMCPResponse {
  summary: string;
  confidence_score: number;
  relevant_patterns: LegalPattern[];
  precedent_chunks: {
    text: string;
    source_doc_id: string;
    section_type: SectionType;
    similarity_score: number;
    precedent_status?: PrecedentStatus;
    similar_cases?: any[];
  }[];
  law_articles: string[];
  risk_notes: string[];
  reasoning_chain: {
    step: number;
    action: string;
    input: any;
    output: any;
    confidence: number;
    sources: string[];
  }[];
  explanation: {
    why_relevant: string;
    key_factors: string[];
    differences: string[];
    risks: string[];
  };
  source_attribution: {
    document_id: string;
    section: string;
    quote: string;
    relevance_score: number;
  }[];
  validation: ValidationResult;
}
