# SecondLayer API Contract v1

**Status**: Active — this document is the canonical reference for all API response formats.
**Last updated**: 2026-02-15
**Compatibility policy**: Additive-only changes (see [Change Policy](#change-policy))

---

## Table of Contents

- [HTTP Envelope](#http-envelope)
- [MCP ToolResult Envelope](#mcp-toolresult-envelope)
- [Backend Tools (36)](#backend-tools)
  - [Pipeline Tools](#pipeline-tools)
  - [Court Decision Tools](#court-decision-tools)
  - [Procedural Tools](#procedural-tools)
  - [Legislation Tools](#legislation-tools)
  - [Document Analysis Tools](#document-analysis-tools)
  - [Vault Tools](#vault-tools)
  - [Due Diligence Tools](#due-diligence-tools)
  - [Batch Tools](#batch-tools)
- [RADA Tools (4)](#rada-tools)
- [OpenReyestr Tools (5)](#openreyestr-tools)
- [Common Patterns](#common-patterns)
- [Change Policy](#change-policy)

---

## HTTP Envelope

All REST API calls to `POST /api/tools/:toolName` return one of two envelopes:

### Success (200)

```jsonc
{
  "success": true,
  "tool": "search_legal_precedents",
  "service": "backend",              // "backend" | "rada" | "openreyestr"
  "result": {                        // ToolResult — see below
    "content": [{ "type": "text", "text": "<JSON or plain text>" }],
    "isError": false
  },
  "cost_tracking": {
    "request_id": "uuid",
    "estimate_before": { ... },
    "actual_cost": { ... }
  }
}
```

### Error (500)

```jsonc
{
  "error": "Tool execution failed",
  "message": "human-readable error",
  "tool": "search_legal_precedents",
  "cost_tracking": { ... }
}
```

### Not Found (404)

```jsonc
{
  "success": false,
  "error": "Tool not found",
  "message": "No handler registered for tool: unknown_tool"
}
```

---

## MCP ToolResult Envelope

Every tool returns a `ToolResult`. The actual data is JSON-stringified inside `content[0].text`.

```typescript
interface ToolResult {
  content: Array<{ type: "text"; text: string }>;  // text = JSON.stringify(data, null, 2)
  isError?: boolean;
}
```

**Error variant**:
```typescript
{
  content: [{ type: "text", text: "Error: <message>" }],
  isError: true
}
```

To get the typed data, parse: `JSON.parse(result.content[0].text)`.

---

## Backend Tools

### Pipeline Tools

#### `classify_intent`

```typescript
{
  service: string;              // "legal_research" | "document_vault" | "workflow_automation" | "due_diligence"
  task: string;                 // "answer_question" | "semantic_search" | "run_workflow" | "bulk_review"
  inputs: {
    question: string;
    jurisdiction: string;       // "UA"
    language: string;           // "uk"
  };
  depth: string;                // "quick" | "standard" | "deep"
  confidence: number;           // 0.0–1.0
}
```

#### `retrieve_legal_sources`

```typescript
{
  cases: Array<{
    id: string;                 // ZakonOnline doc_id
    source: string;             // "zakononline"
    title: string;
    url?: string;
    date?: string;              // YYYY-MM-DD
    court?: string;
    text?: string;
  }>;
  laws: Array<{
    id: string;                 // "rada_id:article_number"
    source: string;             // "rada"
    title: string;
    url?: string;
    article?: string;
    text?: string;
    rada_id?: string;
  }>;
  guidance: Array<any>;         // Reserved, currently empty
  confidence: number;
}
```

#### `analyze_legal_patterns`

```typescript
{
  success_arguments: string[];
  risk_factors: string[];
  confidence: number;           // 0.0–1.0
}
```

#### `validate_response`

```typescript
{
  is_valid: boolean;
  confidence: number;
  issues: Array<{
    type: string;               // "missing_source" | "invalid_citation" | "warning"
    message: string;
  }>;
}
```

#### `find_relevant_law_articles`

```typescript
{
  articles: string[];
  patterns_count: number;
}
```

#### `check_precedent_status`

```typescript
{
  status: string;               // Precedent status description
}
```

---

### Court Decision Tools

#### `get_court_decision` / `get_case_text`

```typescript
{
  doc_id?: number;
  case_number?: string;
  url?: string;
  depth: number;                // 1–5
  sections: Array<{
    type: string;               // "FACTS" | "COURT_REASONING" | "DECISION" | ...
    text: string;
  }>;
  full_text_length: number;
}
```

#### `get_case_documents_chain`

```typescript
{
  case_number: string;
  total_documents: number;

  // When group_by_instance=false:
  documents?: Array<CaseDocument>;

  // When group_by_instance=true (default):
  grouped_documents?: {
    "Перша інстанція": CaseDocument[];
    "Апеляція": CaseDocument[];
    "Касація": CaseDocument[];
    "Велика Палата ВС": CaseDocument[];
    "Невідомо": CaseDocument[];
  };

  search_strategy: {
    variations_tried: string[];
    sources: {
      by_title: number;
      filtered_out: number;
      duplicates_removed: number;
    };
    note: string;
  };

  summary: {
    instances: {
      first_instance: number;
      appeal: number;
      cassation: number;
      grand_chamber: number;
    };
    document_types: {
      decisions: number;
      rulings: number;
      orders: number;
    };
  };
}

// Shared type
interface CaseDocument {
  doc_id: number;
  case_number: string;
  document_type: string;        // "Рішення" | "Постанова" | "Ухвала" | "Вирок" | "Окрема думка" | "Невідомо"
  instance: string;             // "Перша інстанція" | "Апеляція" | "Касація" | "Велика Палата ВС" | "Невідомо"
  court?: string;
  chamber?: string;
  judge?: string;
  date?: string;
  url?: string;
  resolution?: string;
  snippet?: string;
  full_text?: string;           // Only if include_full_text=true
}
```

#### `extract_document_sections`

```typescript
{
  sections: Array<{
    type: string;               // "ФАКТИ" | "ОБОСНУВАННЯ" | "РІШЕННЯ"
    text: string;
  }>;
}
```

#### `load_full_texts`

```typescript
{
  requested_docs: number;
  unique_docs: number;
  duplicates_removed: number;
  processed_docs: number;
  limited_to: number;
  time_taken_ms: number;
  estimated_cost_usd: number;
  note: string;
  deduplication_note?: string;
  warning?: string;
}
```

#### `bulk_ingest_court_decisions`

```typescript
{
  query: string;
  search_query_used: string;
  date_from: string;
  date_to?: string;
  pages_fetched: number;
  unique_doc_ids_collected: number;
  max_docs: number;
  max_pages: number;
  time_taken_ms: number;
  cost_estimate_usd: {
    search_api: number;
    scrape_max: number;
  };
  note: string;
}
```

#### `analyze_case_pattern`

```typescript
{
  patterns: Array<any>;         // Legal pattern objects from Qdrant pattern store
}
```

#### `count_cases_by_party`

```typescript
{
  party_name: string;
  party_type: string;           // "plaintiff" | "defendant" | "any"
  search_query: string;
  total_unique_cases: number;
  unique_doc_ids_found: number;
  pages_fetched: number;
  time_taken_ms: number;
  cost_estimate_usd: number;
  date_from?: string;
  date_to?: string;
  filtering_method?: string;
  note?: string;
  warning?: string;
  scanned_documents?: number;
  cases?: Array<{               // Only if return_cases=true
    cause_num: string;
    doc_id: number;
    title: string;
    resolution: string;
    judge: string;
    court_code: string;
    adjudication_date: string;
    url: string;
  }>;
  cases_returned?: number;
}
```

#### `get_similar_reasoning`

```typescript
{
  similar: Array<any>;          // Embedding search results from Qdrant
}
```

#### `get_citation_graph`

```typescript
{
  graph: any;                   // Citation graph structure
}
```

---

### Procedural Tools

#### `search_legal_precedents`

**Text-based search:**
```typescript
{
  results: Array<any>;          // ZakonOnline search results
  intent: object;
  search_method: "text_based";
  total: number;
  warnings?: string[];
}
```

**Smart search (by case number):**
```typescript
{
  source_case: {
    cause_num: string;
    doc_id: number;
    title: string;
    resolution: string;
    judge: string;
    court_code: string;
    adjudication_date: string;
    url: string;
    category_code: string;
    justice_kind: string;
  };
  search_method: "smart_text_search_with_pagination";
  text_source: string;
  text_length: number;
  extracted_terms: {
    law_articles: string[];
    keywords: string[];
    dispute_type: string;
    case_essence: string;
  };
  search_query: string;
  similar_cases: Array<{
    cause_num: string;
    doc_id: number;
    title: string;
    resolution: string;
    judge: string;
    court_code: string;
    adjudication_date: string;
    url: string;
    similarity_reason: string;
  }>;
  total_found: number;
  pages_fetched: number;
  reached_safety_limit: boolean;
  displaying: number;
  total_available_info: string;
}
```

**Count-all mode:**
```typescript
{
  query: string;
  count_all_mode: true;
  total_count: number;
  pages_fetched: number;
  time_taken_ms: number;
  cost_estimate_usd: number;
  note: string;
  warning: string | null;
}
```

#### `search_supreme_court_practice`

```typescript
{
  procedure_code: string;       // "cpc" | "gpc" | "cac" | "crpc"
  query: string;
  time_range: any;
  applied_filters: {
    court_level: string;        // "SC" | "GrandChamber"
    date_from?: string;
    date_to?: string;
  };
  results: Array<{
    doc_id: number;
    court?: string;
    chamber?: string;
    date?: string;
    case_number?: string;
    url?: string;
    section_focus?: string[];
    snippets: string[];
  }>;
  total_returned: number;
  warning?: string;
}
```

#### `compare_practice_pro_contra`

```typescript
{
  procedure_code: string;
  query: string;
  time_range: any;
  pro: Array<PracticeCase>;
  contra: Array<PracticeCase>;
  total_pro: number;
  total_contra: number;
  warning?: string;
}

interface PracticeCase {
  doc_id: number;
  court?: string;
  chamber?: string;
  date?: string;
  case_number?: string;
  url?: string;
  snippet?: string;
}
```

#### `find_similar_fact_pattern_cases`

```typescript
{
  procedure_code: string;
  time_range: any;
  extracted_search_terms: string[];
  search_query: string;
  results: Array<{
    doc_id: number;
    court?: string;
    chamber?: string;
    date?: string;
    case_number?: string;
    url?: string;
    why_similar: string[];
  }>;
  warning: string;
  time_range_warning?: string;
}
```

#### `calculate_procedural_deadlines`

```typescript
{
  conclusion: {
    summary: string;
    conditions: string;
    risks: string;
  };
  procedure_code: string;
  event_type: string;
  appeal_type: string;
  event_date: string;
  received_full_text_date?: string;
  days: number;
  variants: Array<{
    rule: string;
    start_date: string;
    end_date: string;
  }>;
  norms: {
    act: string;
    article: string;
    quote: string;
    commentary: string;
    source_url: string;
    query_used: string;
    error?: string;
  };
  renewal_criteria: {
    title: string;
    criteria: Array<{
      criterion: string;
      explanation: string;
    }>;
    source_note: string;
  };
  sources: {
    supreme_court_practice: Array<any>;
    practice_query: string;
    practice_queries_tried: string[];
    practice_time_range: string | null;
    practice_disable_time_range: boolean;
    practice_use_court_practice: boolean;
    practice_case_map_max: number;
    court_practice_map_stats?: object;
    practice_error?: string;
    supreme_court_practice_expanded?: {
      requested: number;
      depth: number;
      returned: number;
      time_taken_ms: number;
      items: Array<any>;
      warning?: string;
    };
  };
  risks_and_counterarguments: {
    title: string;
    counterarguments: Array<{
      argument: string;
      basis: string;
      mitigation: string;
    }>;
    procedural_risks: string[];
  };
  action_checklist: {
    title: string;
    steps: Array<{
      step: string;
      details: string;
    }>;
    required_evidence: string[];
  };
  supreme_court_theses?: Array<{
    thesis: string;
    court_and_date: string;
    quote: string;
    context: string;
    section_type: string;
    doc_id: number;
    url: string;
  }>;
  structured_cases?: Array<{
    case_number: string;
    court: string;
    date: string;
    relevance_reason: string;
    quote: string;
    section_type: string;
    doc_id: number;
    url: string;
  }>;
  warnings: string[];
}
```

#### `build_procedural_checklist`

```typescript
{
  stage: string;
  procedure_code: string;
  case_category?: string;
  steps: string[];
  typical_refusal_grounds: string[];
  norms_reference?: string;
  warning: string;
}
```

#### `calculate_monetary_claims`

```typescript
{
  amount: number;
  date_from: string;
  date_to: string;
  claim_type: string;
  calculation: {
    days: number;
    three_percent?: number;
  };
  warning: string;
}
```

#### `search_procedural_norms`

Returns **plain text** (not JSON):
```
B. Норма / правова рамка

Норма: [title] (№ [law_number])
Стаття: [article]
Джерело: [url]

Цитата:
- [snippet1]
- [snippet2]
```

---

### Legislation Tools

#### `get_legislation_article`

```typescript
{
  rada_id: string;
  article_number: string;
  title: string;
  full_text: string;
  url: string;
  metadata: object;
  html?: string;                // Only if include_html=true
}
```

#### `get_legislation_section`

```typescript
{
  rada_id: string;
  article_number: string;
  title: string;
  full_text: string;
  url: string;
  metadata: object;
  resolved_from?: {
    query: string;
    method: string;             // "regexp" | "ai" | "explicit"
    confidence?: number;
  };
  html?: string;
}
```

#### `get_legislation_articles`

```typescript
{
  rada_id: string;
  total_found: number;
  articles: Array<{
    article_number: string;
    title: string;
    full_text: string;
    url: string;
  }>;
  html?: string;
}
```

#### `search_legislation`

**Direct reference resolved:**
```typescript
{
  query: string;
  resolved_reference: {
    rada_id: string;
    article_number: string;
    source: string;             // "regexp" | "ai"
    confidence?: number;
  };
  total_found: number;
  articles: Array<{
    rada_id: string;
    article_number: string;
    title: string;
    full_text: string;
    url: string;
  }>;
  html?: string;
}
```

**Semantic search:**
```typescript
{
  query: string;
  total_found: number;
  articles: Array<{
    rada_id: string;
    article_number: string;
    title: string;
    full_text: string;          // Truncated to 500 chars + "..."
    url: string;
  }>;
  html?: string;
  suggestion?: string;
}
```

#### `get_legislation_structure`

```typescript
{
  rada_id: string;
  title: string;
  short_title: string;
  type: string;
  total_articles: number;
  table_of_contents: any;
  articles_summary: Array<{     // First 20 articles
    article_number: string;
    title: string;
    byte_size: number;
  }>;
}
```

---

### Document Analysis Tools

#### `parse_document`

```typescript
{
  text: string;
  metadata: {
    pageCount: number;
    source: string;             // "native" | "ocr" | "mammoth" | "html"
    mimeType?: string;
    filename?: string;
    [key: string]: any;
  };
}
```

#### `extract_key_clauses`

```typescript
{
  clauses: Array<{
    type: string;               // "parties_subject" | "rights_obligations" | "terms_conditions" |
                                // "payments_finance" | "liability_penalties" | "force_majeure" |
                                // "termination" | "confidentiality"
    text: string;
    confidence: number;
    riskLevel?: "low" | "medium" | "high";
    pageNumber?: number;
  }>;
  riskReport: {
    riskFactors: any[];
    highRiskClauses: Array<ExtractedClause>;
  };
}
```

#### `summarize_document`

```typescript
{
  executiveSummary: string;     // 2–3 paragraphs
  detailedSummary: string;
  keyFacts: {
    parties?: string[];
    dates?: string[];
    amounts?: string[];
  };
}
```

#### `compare_documents`

```typescript
{
  changes: Array<{
    type: "addition" | "deletion" | "modification";
    oldText?: string;
    newText?: string;
    location: string;
    importance: "critical" | "significant" | "minor";
  }>;
  summary: string;
}
```

---

### Vault Tools

#### `store_document`

```typescript
{
  id: string;                   // UUID
  title: string;
  type: "contract" | "legislation" | "court_decision" | "internal" | "other";
  content: string;
  metadata: {
    uploadedAt: string;         // ISO timestamp
    processedAt: string;
    processingTimeMs: number;
    sectionCount: number;
    embeddingCount: number;
    patterns: {
      riskFactors: string[];
      keyArguments: string[];
      confidence: number;
    };
    documentDate?: string;
    tags: string[];
    parties: string[];
    jurisdiction?: string;
    documentSubtype?: string;
    uploadedBy?: string;
    category?: string;
    riskLevel?: "low" | "medium" | "high";
    [key: string]: any;         // Extensible metadata
  };
  sections: Array<{
    type: string;
    text: string;
  }>;
  patterns: {
    riskFactors: string[];
    keyArguments: string[];
    confidence: number;
  };
}
```

#### `get_document`

```typescript
{
  id: string;
  title: string;
  type: string;
  content: string;
  metadata: object;
  sections?: Array<{            // If includeSections=true
    type: string;
    text: string;
  }>;
  patterns?: {                  // If includePatterns=true
    riskFactors: string[];
    keyArguments: string[];
    confidence: number;
  };
}
// Returns null if not found
```

#### `list_documents`

```typescript
{
  documents: Array<{
    id: string;
    title: string;
    type: string;
    content: "";                // Always empty in list view
    metadata: object;
  }>;
  total: number;
}
```

#### `semantic_search`

```typescript
{
  results: Array<{
    documentId: string;
    title: string;
    relevance: number;          // 0.0–1.0
    matchedSections: Array<{
      sectionType: string;
      text: string;
      relevance: number;
    }>;
    metadata: object;
  }>;
}
```

---

### Due Diligence Tools

All DD tools wrap responses in a versioned envelope:

```typescript
{
  version: "v1";
  trace_id: string;
  data: <tool-specific result>;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: any;
  };
}
```

#### `bulk_review_runner`

```typescript
// data field:
{
  reviewId: string;
  totalDocuments: number;
  reviewedDocuments: number;
  failedDocuments: number;
  findings: Array<{
    documentId: string;
    documentTitle: string;
    category: string;
    riskLevel: "critical" | "high" | "medium" | "low";
    title: string;
    description: string;
    recommendation?: string;
    anchor?: {
      sectionType: string;
      quote: string;
    };
  }>;
  riskScores: Array<DocumentRiskScore>;
  processingTimeMs: number;
}

interface DocumentRiskScore {
  documentId: string;
  documentTitle: string;
  overallRisk: "critical" | "high" | "medium" | "low";
  score: number;                // 0–100
  breakdown: {
    contractual: number;
    financial: number;
    compliance: number;
    legal: number;
    operational: number;
  };
  criticalFindingsCount: number;
  highFindingsCount: number;
}
```

#### `risk_scoring`

```typescript
// data field:
{
  riskScores: Array<DocumentRiskScore>;  // Same shape as above
}
```

#### `generate_dd_report`

**JSON format (default):**
```typescript
// data field:
{
  id: string;
  title: string;
  createdAt: string;
  overallRisk: "critical" | "high" | "medium" | "low";
  executiveSummary: string;
  summary: string;
  findings: Array<DDFinding>;
  riskScores: Array<DocumentRiskScore>;
  recommendations: string[];
  processingTimeMs: number;
}
```

**Markdown/HTML format:** returns formatted string.

---

### Batch Tools

#### `batch_process_documents`

```typescript
{
  total: number;
  completed: number;
  failed: number;
  results: Array<{
    fileId: string;
    filename: string;
    success: boolean;
    error?: string;
    result?: {
      parsed?: { text: string; metadata: object };
      clauses?: { clauses: Array<ExtractedClause>; riskReport: any };
      summary?: { executiveSummary: string; detailedSummary: string; keyFacts: object };
    };
    executionTimeMs: number;
    costEstimate?: {
      openai_usd: number;
      vision_usd: number;
      total_usd: number;
    };
  }>;
  totalCostUsd: number;
  totalExecutionTimeMs: number;
}
```

---

## RADA Tools

All RADA tools use the standard ToolResult envelope.
In Unified Gateway mode, tool names are prefixed with `rada_`.

### `search_parliament_bills`

```typescript
{
  query: string;
  status: "registered" | "first_reading" | "second_reading" | "adopted" | "rejected" | "all";
  total_found: number;
  bills: Array<{
    bill_number: string;
    title: string;
    registration_date: string | null;
    status: string | null;
    stage: string | null;
    initiator_type: string | null;
    initiator_names: string[];
    main_committee_name: string | null;
    url: string | null;
  }>;
}
```

### `get_deputy_info`

**Single deputy:**
```typescript
{
  rada_id: string;
  full_name: string;
  short_name: string;
  active: boolean;
  faction_name: string | null;
  committee_name: string | null;
  committee_role: string | null;
  region: string | null;
  district: string | null;
  birth_date: string | null;
  birth_place: string | null;
  biography: string | null;
  photo_url: string | null;
  voting_statistics?: {         // If include_voting_record=true
    total_votes: number;
    voted_for: number;
    voted_against: number;
    abstained: number;
    not_present: number;
    attendance_rate: number;
  };
  assistants?: Array<{          // If include_assistants=true
    assistant_type: string;
    full_name: string;
    start_date: string;
    end_date: string;
  }>;
}
```

**Multiple matches (<10):**
```typescript
{
  multiple_matches: true;
  count: number;
  deputies: Array<{
    rada_id: string;
    full_name: string;
    faction_name: string;
    active: boolean;
  }>;
  message: string;
}
```

**Faction list (>10):** returns plain text listing.

### `search_legislation_text`

```typescript
{
  law_number: string;
  title: string;
  law_type: string | null;
  adoption_date: string | null;
  effective_date: string | null;
  status: string | null;
  url: string;
  full_text_plain: string;
  article?: {                   // If specific article requested
    number: string;
    title?: string;
    text: string;
    parent_chapter?: string;
  };
  court_citations?: {           // If include_court_citations=true
    total: number;
    recent: Array<{
      case_number: string;
      citation_count: number;
      last_citation_date: string;
    }>;
  };
}
```

### `analyze_voting_record`

```typescript
{
  deputy: {
    rada_id: string;
    full_name: string;
    faction: string;
  };
  period: {
    from: string;
    to: string;
  };
  statistics: {
    total_votes: number;
    voted_for: number;
    voted_against: number;
    abstained: number;
    not_present: number;
    attendance_rate: number;    // Percentage
  };
  voting_records: Array<{       // Max 20 recent
    date: string;
    question: string;
    bill_number: string | null;
    vote: "За" | "Проти" | "Утримався" | "Не голосував";
    result: string;
  }>;
  ai_analysis?: Array<{        // If analyze_patterns=true
    pattern_type: "consistency" | "topic_based" | "time_based" | "abstention";
    description: string;
    frequency: number;          // 0–100
    confidence: number;         // 0–1
    examples: string[];
  }>;
}
```

---

## OpenReyestr Tools

All OpenReyestr tools use the standard ToolResult envelope.
In Unified Gateway mode, tool names are prefixed with `openreyestr_`.

### `search_entities`

**Found results:**
```typescript
Array<{
  id: number;
  record: string;
  edrpou?: string;             // UO/FSU only
  name: string;
  short_name?: string;
  opf?: string;                // UO only (організаційно-правова форма)
  type_subject?: string;       // FSU only
  type_branch?: string;        // FSU only
  stan: string;                // "зареєстровано" | "припинено" | ...
  registration: string;        // Date
  entity_type: "UO" | "FOP" | "FSU";
}>
```

**No results:**
```typescript
[{
  found: false;
  query: string;
  message: string;
  availableRegistries: Array<{
    registry: string;
    records: number;
  }>;
  suggestions: string[];
}]
```

### `get_entity_details`

```typescript
{
  entityType: "UO" | "FOP" | "FSU";
  record: string;
  mainInfo: {
    id: number;
    record: string;
    edrpou?: string;
    name: string;
    short_name?: string;
    opf?: string;
    stan: string;
    registration: string;
    // ... all fields from entity table
  };
  founders?: Array<{
    id: number;
    entity_type: string;
    entity_record: string;
    founder_info: string;
    share?: string;
  }>;
  beneficiaries?: Array<{
    id: number;
    entity_type: string;
    entity_record: string;
    beneficiary_info: string;
  }>;
  signers?: Array<{
    id: number;
    entity_type: string;
    entity_record: string;
    signer_info: string;
  }>;
  members?: Array<any>;        // UO only
  branches?: Array<any>;       // UO only
  predecessors?: Array<any>;
  assignees?: Array<any>;      // UO only
  executivePower?: object;     // UO only
  terminationStarted?: object;
  bankruptcyInfo?: object;     // UO only
  exchangeData?: Array<any>;
}
```

### `search_beneficiaries`

```typescript
Array<{
  id: number;
  entity_type: "UO" | "FOP" | "FSU";
  entity_record: string;
  beneficiary_info: string;
  entity_name: string;         // Joined from entity table
}>
```

### `get_by_edrpou`

**Found:**
```typescript
{
  id: number;
  record: string;
  edrpou: string;
  name: string;
  short_name?: string;
  opf?: string;
  stan: string;
  registration: string;
  entity_type: "UO" | "FSU";   // FOP don't have EDRPOU
  // ... all fields from entity table
}
```

**Not found:**
```typescript
{
  found: false;
  edrpou: string;
  message: string;
  availableRegistries: Array<{
    registry: string;
    records: number;
  }>;
  suggestions: string[];
}
```

### `get_statistics`

```typescript
{
  totalEntities: {
    legalEntities: number;
    individualEntrepreneurs: number;
    publicAssociations: number;
    total: number;
  };
  activeEntities: {
    legalEntities: number;
    individualEntrepreneurs: number;
    publicAssociations: number;
    total: number;
  };
}
```

---

## Common Patterns

### Data Types

| Type | Format | Example |
|------|--------|---------|
| Date | ISO 8601 `YYYY-MM-DD` | `"2024-01-15"` |
| Timestamp | ISO 8601 full | `"2024-01-15T10:30:00.000Z"` |
| Internal ID | UUID v4 | `"550e8400-e29b-41d4-a716-446655440000"` |
| ZO doc_id | number | `12345678` |
| Confidence | float 0.0–1.0 | `0.85` |
| Cost USD | float | `0.0234` |
| URL | absolute URL string | `"https://reyestr.court.gov.ua/..."` |

### Nullable Fields

Fields marked with `?` may be absent from the response. Consumers should always handle missing optional fields with defaults.

### Text Truncation

Some fields are truncated in list/search responses:
- `search_legislation` → `full_text` truncated to 500 chars + `"..."`
- `list_documents` → `content` is always `""`

### Error Responses

All tools follow the same error pattern:
```typescript
{
  content: [{ type: "text", text: "Error: <human-readable message>" }],
  isError: true
}
```

Some tools return structured errors inside the data:
```typescript
{ error: string; suggestion?: string; }
```

---

## Change Policy

### Rules

1. **Additive only** — new fields MAY be added to any response at any time. Consumers MUST ignore unknown fields.

2. **No removals** — existing fields MUST NOT be removed or renamed. If a field becomes obsolete, it continues to be returned (may be `null` or empty).

3. **No type changes** — a field that returns `string` today MUST NOT start returning `number` tomorrow. If a new type is needed, add a new field.

4. **No semantic changes** — the meaning of a field MUST NOT change. `confidence: 0.8` must always mean "80% confident", not "80 out of 100".

5. **Deprecation** — before eventually removing a field (in a future v2), mark it deprecated in this document for at least 2 months and add a `deprecated_fields` array to the response listing the field names.

### Breaking Change Triggers (require v2)

The following changes are breaking and require a new API version:
- Removing or renaming a response field
- Changing a field's type
- Changing the HTTP envelope structure
- Changing authentication scheme
- Changing URL structure

### Changelog

| Date | Change | Type |
|------|--------|------|
| 2026-02-15 | Initial contract documented | Baseline |
