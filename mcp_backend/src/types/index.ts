export enum SectionType {
  FACTS = 'FACTS',
  CLAIMS = 'CLAIMS',
  LAW_REFERENCES = 'LAW_REFERENCES',
  COURT_REASONING = 'COURT_REASONING',
  DECISION = 'DECISION',
  AMOUNTS = 'AMOUNTS',
}

export type ProcedureCode = 'ЦПК' | 'ГПК' | 'КАС' | 'КПК';

export type CourtLevel =
  | 'first_instance'
  | 'appeal'
  | 'cassation'
  | 'SC'
  | 'GrandChamber';

export type DesiredOutput = 'теза' | 'чеклист' | 'таблиця' | 'підбірка' | 'порівняння';

export interface MoneyTerms {
  penalty?: boolean;
  inflation?: boolean;
  three_percent?: boolean;
  legal_fees?: boolean;
}

export interface IntentSlots {
  procedure_code?: ProcedureCode;
  court_level?: CourtLevel;
  case_category?: string;
  law_article?: string;
  section_focus?: SectionType[];
  money_terms?: MoneyTerms;
  desired_output?: DesiredOutput;
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
  shepardization?: any;
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
  slots?: IntentSlots;
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
    case_number?: string;
    chamber?: string;
    dispute_category?: string;
    outcome?: string;
    deviation_flag?: boolean | null;
    precedent_status?: PrecedentStatusType;
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
  overturned_citations?: string[];
}

export interface ReasoningBudget {
  max_llm_calls: number;
  max_tokens: number;
  strategy: 'cheap-first' | 'deep-only-if-needed';
}

export interface PackagedAnswerConclusion {
  conclusion: string;
  conditions?: string;
  risk_or_exception?: string;
}

export interface PackagedAnswerNorm {
  act?: string;
  article_ref: string;
  quote?: string;
  comment?: string;
}

export interface PackagedAnswerSupremeCourtThesis {
  thesis: string;
  quotes: Array<{
    quote: string;
    source_doc_id: string;
    section_type: SectionType;
  }>;
  context?: string;
}

export interface PackagedAnswerCase {
  source_doc_id: string;
  section_type: SectionType;
  quote: string;
  relevance_reason?: string;
  case_number?: string;
  court?: string;
  date?: string;
}

export interface PackagedAnswerChecklist {
  steps: string[];
  evidence: string[];
}

export interface PackagedLawyerAnswer {
  short_conclusion: PackagedAnswerConclusion;
  legal_framework: {
    norms: PackagedAnswerNorm[];
  };
  supreme_court_positions: PackagedAnswerSupremeCourtThesis[];
  practice: PackagedAnswerCase[];
  criteria_test: string[];
  counterarguments_and_risks: string[];
  checklist: PackagedAnswerChecklist;
  sources: Array<{
    document_id: string;
    section_type?: SectionType;
    quote: string;
  }>;
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
  intent?: QueryIntent;
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
  packaged_answer?: PackagedLawyerAnswer;
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
