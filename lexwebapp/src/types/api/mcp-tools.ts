/**
 * MCP Tools Types
 * Type definitions for all 43 MCP tools available in SecondLayer backend
 */

// ============================================================================
// Common Types
// ============================================================================

export interface Tool {
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: any;
}

export type ToolCategory =
  | 'search'
  | 'documents'
  | 'legislation'
  | 'analysis'
  | 'complex'
  | 'rada'
  | 'openreyestr';

// ============================================================================
// Search & Analysis Tools (11 tools)
// ============================================================================

export interface ClassifyIntentParams {
  query: string;
}

export interface ClassifyIntentResult {
  intent: string;
  domain: string;
  confidence: number;
  suggested_tools: string[];
}

export interface SearchLegalPrecedentsParams {
  query: string;
  limit?: number;
  domain?: 'court' | 'npa' | 'echr' | 'all';
  offset?: number;
}

export interface SearchLegalPrecedentsResult {
  precedents: Array<{
    case_number: string;
    court: string;
    date: string;
    summary: string;
    similarity: number;
  }>;
  total: number;
}

export interface SearchCourtCasesParams {
  query: string;
  limit?: number;
  offset?: number;
}

export interface SearchCourtCasesResult {
  cases: Array<{
    id: string;
    case_number: string;
    court: string;
    date: string;
    category: string;
    summary: string;
  }>;
  total: number;
}

export interface AnalyzeCasePatternParams {
  case_description: string;
  search_similar?: boolean;
}

export interface AnalyzeCasePatternResult {
  pattern: string;
  legal_basis: string[];
  similar_cases?: any[];
  recommendations: string[];
}

export interface GetSimilarReasoningParams {
  query: string;
  limit?: number;
}

export interface GetSimilarReasoningResult {
  reasoning_patterns: Array<{
    pattern_id: string;
    similarity: number;
    reasoning: string;
    source: string;
  }>;
}

export interface CountCasesByPartyParams {
  party_name: string;
  role?: 'plaintiff' | 'defendant' | 'any';
}

export interface CountCasesByPartyResult {
  party_name: string;
  total_cases: number;
  as_plaintiff: number;
  as_defendant: number;
  win_rate: number;
}

// ============================================================================
// Document Tools (7 tools)
// ============================================================================

export interface GetDocumentTextParams {
  document_id: string;
  include_metadata?: boolean;
}

export interface GetDocumentTextResult {
  document_id: string;
  text: string;
  metadata?: {
    case_number?: string;
    court?: string;
    date?: string;
    judge?: string;
  };
}

export interface ExtractDocumentSectionsParams {
  document_id: string;
  sections?: string[];
}

export interface ExtractDocumentSectionsResult {
  document_id: string;
  sections: Array<{
    name: string;
    content: string;
  }>;
}

export interface LoadFullTextsParams {
  document_ids: string[];
}

export interface LoadFullTextsResult {
  documents: Array<{
    document_id: string;
    text: string;
  }>;
}

export interface ParseDocumentParams {
  document_text: string;
  extract_entities?: boolean;
}

export interface ParseDocumentResult {
  sections: any[];
  entities?: {
    persons: string[];
    organizations: string[];
    laws: string[];
    dates: string[];
  };
}

export interface CompareDocumentsParams {
  document_id_1: string;
  document_id_2: string;
}

export interface CompareDocumentsResult {
  similarity: number;
  differences: string[];
  common_elements: string[];
}

// ============================================================================
// Legislation Tools (5 tools)
// ============================================================================

export interface SearchLegislationParams {
  query: string;
  limit?: number;
  type?: 'code' | 'law' | 'constitution' | 'all';
}

export interface SearchLegislationResult {
  legislation: Array<{
    id: string;
    title: string;
    type: string;
    relevance: number;
    snippet: string;
  }>;
}

export interface GetLegislationArticleParams {
  legislation_id: string;
  article_number: string | number;
}

export interface GetLegislationArticleResult {
  legislation_id: string;
  article_number: string;
  text: string;
  context?: string;
}

export interface GetLegislationSectionParams {
  legislation_id: string;
  section_name: string;
}

export interface GetLegislationSectionResult {
  legislation_id: string;
  section_name: string;
  content: string;
  articles: string[];
}

export interface GetLegislationArticlesParams {
  legislation_id: string;
  article_numbers: (string | number)[];
}

export interface GetLegislationArticlesResult {
  legislation_id: string;
  articles: Array<{
    article_number: string;
    text: string;
  }>;
}

export interface GetLegislationStructureParams {
  legislation_id: string;
}

export interface GetLegislationStructureResult {
  legislation_id: string;
  title: string;
  structure: Array<{
    type: 'section' | 'chapter' | 'article';
    number: string;
    title: string;
  }>;
}

// ============================================================================
// Complex Operations (10+ tools)
// ============================================================================

export interface GetLegalAdviceParams {
  query: string;
  max_precedents?: number;
  include_reasoning?: boolean;
}

export interface GetLegalAdviceResult {
  answer: string;
  summary?: string;
  reasoning_chain?: Array<{
    step: number;
    action: string;
    output?: any;
    explanation?: string;
  }>;
  precedent_chunks?: Array<{
    case_number: string;
    court: string;
    date: string;
    summary: string;
    similarity: number;
  }>;
  source_attribution?: Array<{
    text: string;
    citation: string;
  }>;
}

export interface PackagedLawyerAnswerParams {
  question: string;
  context?: string;
}

export interface PackagedLawyerAnswerResult {
  answer: string;
  legal_basis: string[];
  precedents: any[];
  recommendations: string[];
  confidence: number;
}

export interface ValidateCitationsParams {
  text: string;
  citations: string[];
}

export interface ValidateCitationsResult {
  valid_citations: string[];
  invalid_citations: string[];
  suggestions: Array<{
    citation: string;
    correction: string;
    confidence: number;
  }>;
}

export interface CheckPrecedentStatusParams {
  case_number: string;
}

export interface CheckPrecedentStatusResult {
  case_number: string;
  status: 'active' | 'overturned' | 'modified' | 'unknown';
  details: string;
  related_cases: string[];
}

export interface BulkIngestCourtDecisionsParams {
  documents: Array<{
    case_number: string;
    text: string;
    metadata?: any;
  }>;
}

export interface BulkIngestCourtDecisionsResult {
  ingested: number;
  failed: number;
  errors: string[];
}

// ============================================================================
// RADA Tools (4 tools)
// ============================================================================

export interface SearchDeputiesParams {
  query: string;
  faction?: string;
  limit?: number;
}

export interface SearchDeputiesResult {
  deputies: Array<{
    id: string;
    name: string;
    faction: string;
    position?: string;
    photo_url?: string;
  }>;
}

export interface GetDeputyInfoParams {
  deputy_id: string;
}

export interface GetDeputyInfoResult {
  id: string;
  name: string;
  faction: string;
  position?: string;
  committee?: string;
  bio?: string;
  voting_stats?: {
    total_votes: number;
    attendance_rate: number;
  };
}

export interface SearchBillsParams {
  query: string;
  status?: 'draft' | 'submitted' | 'adopted' | 'rejected' | 'all';
  limit?: number;
}

export interface SearchBillsResult {
  bills: Array<{
    id: string;
    number: string;
    title: string;
    status: string;
    date: string;
    initiators: string[];
  }>;
}

export interface GetBillDetailsParams {
  bill_id: string;
}

export interface GetBillDetailsResult {
  id: string;
  number: string;
  title: string;
  status: string;
  text?: string;
  initiators: Array<{
    name: string;
    faction?: string;
  }>;
  voting_history?: any[];
}

// ============================================================================
// OpenReyestr Tools (5 tools)
// ============================================================================

export interface SearchEntitiesParams {
  query: string;
  entity_type?: 'uo' | 'fop' | 'fsu' | 'all';
  limit?: number;
}

export interface SearchEntitiesResult {
  entities: Array<{
    edrpou: string;
    name: string;
    entity_type: string;
    status: string;
    registration_date?: string;
  }>;
}

export interface GetEntityDetailsParams {
  edrpou: string;
}

export interface GetEntityDetailsResult {
  edrpou: string;
  name: string;
  entity_type: string;
  status: string;
  address?: string;
  registration_date?: string;
  activity_types?: string[];
  founders?: Array<{
    name: string;
    share?: string;
  }>;
}

export interface GetBeneficiariesParams {
  edrpou: string;
}

export interface GetBeneficiariesResult {
  edrpou: string;
  entity_name: string;
  beneficiaries: Array<{
    name: string;
    share?: string;
    control_type?: string;
  }>;
}

export interface SearchByBeneficiaryParams {
  beneficiary_name: string;
  limit?: number;
}

export interface SearchByBeneficiaryResult {
  beneficiary_name: string;
  entities: Array<{
    edrpou: string;
    name: string;
    share?: string;
  }>;
}

export interface GetEntityByEDRPOUParams {
  edrpou: string;
}

export interface GetEntityByEDRPOUResult {
  edrpou: string;
  name: string;
  entity_type: string;
  status: string;
  full_info: any;
}

// ============================================================================
// Union Type for All Tool Parameters
// ============================================================================

export type MCPToolParams =
  | ClassifyIntentParams
  | SearchLegalPrecedentsParams
  | SearchCourtCasesParams
  | AnalyzeCasePatternParams
  | GetSimilarReasoningParams
  | CountCasesByPartyParams
  | GetDocumentTextParams
  | ExtractDocumentSectionsParams
  | LoadFullTextsParams
  | ParseDocumentParams
  | CompareDocumentsParams
  | SearchLegislationParams
  | GetLegislationArticleParams
  | GetLegislationSectionParams
  | GetLegislationArticlesParams
  | GetLegislationStructureParams
  | GetLegalAdviceParams
  | PackagedLawyerAnswerParams
  | ValidateCitationsParams
  | CheckPrecedentStatusParams
  | BulkIngestCourtDecisionsParams
  | SearchDeputiesParams
  | GetDeputyInfoParams
  | SearchBillsParams
  | GetBillDetailsParams
  | SearchEntitiesParams
  | GetEntityDetailsParams
  | GetBeneficiariesParams
  | SearchByBeneficiaryParams
  | GetEntityByEDRPOUParams;

export type MCPToolResult =
  | ClassifyIntentResult
  | SearchLegalPrecedentsResult
  | SearchCourtCasesResult
  | AnalyzeCasePatternResult
  | GetSimilarReasoningResult
  | CountCasesByPartyResult
  | GetDocumentTextResult
  | ExtractDocumentSectionsResult
  | LoadFullTextsResult
  | ParseDocumentResult
  | CompareDocumentsResult
  | SearchLegislationResult
  | GetLegislationArticleResult
  | GetLegislationSectionResult
  | GetLegislationArticlesResult
  | GetLegislationStructureResult
  | GetLegalAdviceResult
  | PackagedLawyerAnswerResult
  | ValidateCitationsResult
  | CheckPrecedentStatusResult
  | BulkIngestCourtDecisionsResult
  | SearchDeputiesResult
  | GetDeputyInfoResult
  | SearchBillsResult
  | GetBillDetailsResult
  | SearchEntitiesResult
  | GetEntityDetailsResult
  | GetBeneficiariesResult
  | SearchByBeneficiaryResult
  | GetEntityByEDRPOUResult;
