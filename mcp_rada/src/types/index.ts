// Core RADA MCP Server Types

export interface Deputy {
  id: string;
  rada_id: string;
  full_name: string;
  short_name?: string;
  convocation: number;
  active: boolean;
  status?: string;
  faction_id?: string;
  faction_name?: string;
  committee_id?: string;
  committee_name?: string;
  committee_role?: string;
  gender?: string;
  birth_date?: string;
  birth_place?: string;
  region?: string;
  district?: string;
  phone?: string;
  email?: string;
  photo_url?: string;
  biography?: string;
  assistant_count?: number;
  metadata?: any;
  cached_at?: Date;
  cache_expires_at?: Date;
  created_at?: Date;
  updated_at?: Date;
}

export interface DeputyAssistant {
  id: string;
  deputy_id: string;
  assistant_type?: string;
  full_name?: string;
  start_date?: Date;
  end_date?: Date;
  metadata?: any;
  created_at?: Date;
}

export interface Bill {
  id: string;
  bill_number: string;
  title: string;
  registration_date?: Date;
  status?: string;
  stage?: string;
  initiator_type?: string;
  initiator_names?: string[];
  initiator_ids?: string[];
  main_committee_id?: string;
  main_committee_name?: string;
  subject_area?: string;
  law_articles?: string[];
  full_text?: string;
  explanatory_note?: string;
  url?: string;
  metadata?: any;
  cached_at?: Date;
  cache_expires_at?: Date;
  created_at?: Date;
  updated_at?: Date;
}

export interface Legislation {
  id: string;
  law_number: string;
  law_alias?: string;
  title: string;
  law_type?: string;
  adoption_date?: Date;
  effective_date?: Date;
  status?: string;
  full_text_html?: string;
  full_text_plain?: string;
  article_count?: number;
  articles?: LawArticle[];
  chapters?: LawChapter[];
  url?: string;
  metadata?: any;
  cached_at?: Date;
  cache_expires_at?: Date;
  created_at?: Date;
  updated_at?: Date;
}

export interface LawArticle {
  number: string;
  title?: string;
  text: string;
  parent_chapter?: string;
}

export interface LawChapter {
  number: string;
  title: string;
  articles: string[];
}

export interface VotingRecord {
  id: string;
  session_date: Date;
  session_number?: number;
  question_number?: number;
  question_text?: string;
  bill_number?: string;
  question_type?: string;
  total_voted?: number;
  voted_for?: number;
  voted_against?: number;
  voted_abstain?: number;
  voted_not_present?: number;
  result?: string;
  votes?: { [deputyRadaId: string]: VoteType };
  metadata?: any;
  created_at?: Date;
}

export type VoteType = 'За' | 'Проти' | 'Утримався' | 'Не голосував';

export interface Faction {
  id: string;
  faction_id: string;
  name: string;
  convocation: number;
  member_count?: number;
  created_date?: Date;
  metadata?: any;
  created_at?: Date;
}

export interface Committee {
  id: string;
  committee_id: string;
  name: string;
  convocation: number;
  chair_deputy_id?: string;
  member_count?: number;
  metadata?: any;
  created_at?: Date;
}

// Search and Query Types

export interface BillSearchParams {
  query: string;
  status?: 'registered' | 'first_reading' | 'second_reading' | 'adopted' | 'rejected' | 'all';
  initiator?: string;
  committee?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
}

export interface DeputySearchParams {
  name?: string;
  rada_id?: string;
  faction?: string;
  committee?: string;
  active?: boolean;
  include_voting_record?: boolean;
  include_assistants?: boolean;
}

export interface LegislationSearchParams {
  law_identifier: string;
  article?: string;
  search_text?: string;
  include_court_citations?: boolean;
}

export interface VotingAnalysisParams {
  deputy_name: string;
  date_from?: string;
  date_to?: string;
  bill_number?: string;
  analyze_patterns?: boolean;
}

// Response Types

export interface BillSearchResult {
  bills: Bill[];
  total: number;
  query: string;
  filters: Partial<BillSearchParams>;
}

export interface DeputyInfoResult {
  deputy: Deputy;
  assistants?: DeputyAssistant[];
  voting_statistics?: VotingStatistics;
  faction_info?: Faction;
  committee_info?: Committee;
}

export interface VotingStatistics {
  total_votes: number;
  voted_for: number;
  voted_against: number;
  abstained: number;
  not_present: number;
  attendance_rate: number;
  positions: VotingPosition[];
  patterns?: VotingPattern[];
}

export interface VotingPosition {
  date: Date;
  question: string;
  bill_number?: string;
  vote: VoteType;
  result?: string;
}

export interface VotingPattern {
  pattern_type: string;
  description: string;
  frequency: number;
  confidence: number;
  examples: string[];
}

export interface LegislationResult {
  legislation: Legislation;
  article?: LawArticle;
  search_results?: { article: LawArticle; relevance: number }[];
  court_citations?: CourtCitation[];
}

export interface CourtCitation {
  case_number: string;
  case_id?: string;
  citation_count: number;
  last_citation_date?: Date;
  context?: string;
}

// Reasoning Budget (same as SecondLayer)

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

// MCP Response Types

export interface MCPToolResponse {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

export interface EnhancedMCPResponse {
  summary: string;
  data: any;
  metadata?: {
    cached?: boolean;
    execution_time_ms?: number;
    sources?: string[];
    cost_estimate?: number;
  };
  confidence_score?: number;
  reasoning_chain?: {
    step: number;
    action: string;
    input: any;
    output: any;
    confidence: number;
  }[];
}

// RADA API Types

export interface RadaDataset {
  id: string;
  title: string;
  description: string;
  resources: RadaResource[];
}

export interface RadaResource {
  name: string;
  url: string;
  format: string;
  lastModified: string;
}

// Cross-Reference Types

export interface LawCourtCitation {
  id: string;
  law_number: string;
  law_article?: string;
  court_case_id?: string;
  court_case_number: string;
  citation_count: number;
  last_citation_date?: Date;
  citation_context?: string;
  synced_from_secondlayer: boolean;
  last_sync_at?: Date;
  created_at?: Date;
  updated_at?: Date;
}

export interface BillCourtImpact {
  id: string;
  bill_number: string;
  related_law_number?: string;
  affected_cases_count: number;
  affected_cases: { case_number: string; relevance_score: number }[];
  impact_analysis?: string;
  impact_score?: number;
  analyst?: string;
  created_at?: Date;
  updated_at?: Date;
}
