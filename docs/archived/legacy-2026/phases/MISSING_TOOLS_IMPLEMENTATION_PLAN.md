# Detailed Implementation Plan for 24 Missing Backend Tools

## Executive Summary

After analyzing the current state of `mcp_backend/src/api/mcp-query-api.ts`, I found that **24 out of 36 backend tools are missing implementations**. The tool registry declares 36 backend tools, but only 12 are actually implemented in the `handleToolCall` method.

## Current State Analysis

### ✅ **Implemented Tools (12/36)**
1. `classify_intent`
2. `retrieve_legal_sources`
3. `analyze_legal_patterns`
4. `validate_response`
5. `search_legal_precedents`
6. `analyze_case_pattern`
7. `get_similar_reasoning`
8. `extract_document_sections`
9. `count_cases_by_party`
10. `find_relevant_law_articles`
11. `check_precedent_status`
12. `load_full_texts`
13. `bulk_ingest_court_decisions`
14. `get_citation_graph`
15. `search_procedural_norms`
16. `search_business_entities`
17. `get_business_entity_details`
18. `search_entity_beneficiaries`
19. `lookup_by_edrpou`
20. `search_supreme_court_practice`
21. `get_court_decision`
22. `get_case_text`
23. `get_case_documents_chain`
24. `compare_practice_pro_contra`
25. `find_similar_fact_pattern_cases`
26. `calculate_procedural_deadlines`
27. `build_procedural_checklist`
28. `calculate_monetary_claims`
29. `format_answer_pack`
30. `get_legal_advice`

### ❌ **Missing Tools (24/36)**

## 1. Missing Document Processing Tools (6 tools)

### **Simple Complexity (2-4 days each)**
1. **`get_document_text`**
   - **Purpose**: Retrieve raw document text by document ID
   - **Dependencies**: ZOAdapter.getDocumentFullText()
   - **Implementation**: Simple wrapper around existing functionality
   - **Pattern**: Similar to `get_court_decision` but returns only raw text

2. **`get_document`**
   - **Purpose**: Generic document retrieval (could be court decision, legislation, etc.)
   - **Dependencies**: DocumentService (if exists), ZOAdapter
   - **Implementation**: Router that determines document type and delegates

### **Medium Complexity (4-6 days each)**
3. **`parse_document`**
   - **Purpose**: Parse document structure (HTML to text, metadata extraction)
   - **Dependencies**: HTML parsing utilities, document type detection
   - **Implementation**: Use existing CourtDecisionHTMLParser pattern for other doc types

4. **`extract_key_clauses`**
   - **Purpose**: Extract specific legal clauses from contract/document text
   - **Dependencies**: LLM for clause identification, pattern matching
   - **Implementation**: Use OpenAI API with legal clause detection prompts

5. **`summarize_document`**
   - **Purpose**: Generate legal document summaries
   - **Dependencies**: OpenAI API, document text retrieval
   - **Implementation**: Use OpenAI summarization with legal context

6. **`compare_documents`**
   - **Purpose**: Compare two legal documents for differences
   - **Dependencies**: Document retrieval, text comparison algorithms
   - **Implementation**: Combine semantic similarity with structured comparison

## 2. Missing Search & Analysis Tools (8 tools)

### **Simple Complexity (2-3 days each)**
7. **`semantic_search`** (Note: Duplicate name - rename to `semantic_document_search`)
   - **Purpose**: Vector-based semantic search across all documents
   - **Dependencies**: EmbeddingService, Qdrant
   - **Implementation**: Use existing embedding infrastructure for broader search

8. **`search_by_category`**
   - **Purpose**: Search cases by legal category/dispute type
   - **Dependencies**: ZOAdapter with category filtering
   - **Implementation**: Extend existing search with category metadata

9. **`search_by_court`**
   - **Purpose**: Search cases by specific court
   - **Dependencies**: ZOAdapter with court filtering
   - **Implementation**: Court name normalization + search filtering

10. **`search_by_judge`**
    - **Purpose**: Search cases by judge name
    - **Dependencies**: ZOAdapter with judge filtering
    - **Implementation**: Judge name normalization + search

### **Medium Complexity (4-6 days each)**
11. **`search_by_date_range`**
    - **Purpose**: Search cases within specific date range
    - **Dependencies**: ZOAdapter with date filtering
    - **Implementation**: Date parsing + range optimization

12. **`find_legal_patterns`**
    - **Purpose**: Find recurring legal patterns in case law
    - **Dependencies**: Pattern matching, LegalPatternStore
    - **Implementation**: Use existing pattern store with broader search

13. **`validate_citations`**
    - **Purpose**: Validate legal citations against source documents
    - **Dependencies**: CitationValidator, source documents
    - **Implementation**: Extend existing citation validation

14. **`packaged_lawyer_answer`**
    - **Purpose**: Generate structured lawyer answer format
    - **Dependencies**: LLM, document retrieval, format templates
    - **Implementation**: Use existing packaging logic from get_legal_advice

## 3. Missing Case Management Tools (5 tools)

### **Simple Complexity (2-3 days each)**
15. **`get_case_metadata`**
    - **Purpose**: Get case metadata without full text
    - **Dependencies**: ZOAdapter metadata retrieval
    - **Implementation**: Lightweight version of get_court_decision

16. **`get_related_cases`**
    - **Purpose**: Find cases related to a given case
    - **Dependencies**: Citation graph, semantic similarity
    - **Implementation**: Combine citation analysis with semantic search

17. **`get_practice_document`**
    - **Purpose**: Get specific practice database document
    - **Dependencies**: ZOAdapter practice database access
    - **Implementation**: Use existing zoPracticeAdapter

### **Medium Complexity (4-5 days each)**
18. **`analyze_judicial_reasoning`**
    - **Purpose**: Analyze judge's reasoning patterns
    - **Dependencies**: LLM, document sections, reasoning patterns
    - **Implementation**: Use sectionizer + OpenAI for reasoning analysis

19. **`track_precedent_evolution`**
    - **Purpose**: Track how precedent evolves over time
    - **Dependencies**: Citation graph, temporal analysis
    - **Implementation**: Citation tracking + chronological analysis

## 4. Missing Advanced Analysis Tools (3 tools)

### **Medium Complexity (5-7 days each)**
20. **`extract_legal_principles`**
    - **Purpose**: Extract fundamental legal principles from cases
    - **Dependencies**: LLM, pattern recognition
    - **Implementation**: Use OpenAI with legal principle extraction prompts

21. **`compare_decisions`**
    - **Purpose**: Deep comparison of multiple decisions
    - **Dependencies**: Document retrieval, LLM, structured comparison
    - **Implementation**: Multi-document analysis with comparison framework

22. **`analyze_court_trends`**
    - **Purpose**: Analyze decision trends over time
    - **Dependencies**: Aggregated case data, statistical analysis
    - **Implementation**: Database queries + trend analysis algorithms

## 5. Missing Network & Citation Tools (2 tools)

### **Medium Complexity (4-5 days each)**
23. **`get_citation_network`**
    - **Purpose**: Get citation network for cases
    - **Dependencies**: CitationValidator, graph building
    - **Implementation**: Extend existing getCitationGraph method

24. **`search_court_practice`**
    - **Purpose**: Search specialized court practice database
    - **Dependencies**: ZOAdapter practice database
    - **Implementation**: Use zoPracticeAdapter with search UI

## Implementation Dependencies & Prerequisites

### **Database Tables Needed**
```sql
-- Additional tables for missing tools
CREATE TABLE IF NOT EXISTS document_comparisons (
    id SERIAL PRIMARY KEY,
    doc1_id INTEGER NOT NULL,
    doc2_id INTEGER NOT NULL,
    comparison_result JSONB,
    similarity_score FLOAT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS legal_principles (
    id SERIAL PRIMARY KEY,
    principle TEXT NOT NULL,
    source_doc_id INTEGER,
    case_ids INTEGER[],
    extraction_confidence FLOAT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS judicial_reasoning_patterns (
    id SERIAL PRIMARY KEY,
    judge_id VARCHAR(255),
    pattern_type VARCHAR(100),
    pattern_description TEXT,
    case_ids INTEGER[],
    frequency INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW()
);
```

### **New Service Classes Needed**
```typescript
// DocumentProcessingService
class DocumentProcessingService {
  parseDocument(docId: string): Promise<ParsedDocument>
  extractKeyClaauses(text: string, clauseTypes: string[]): Promise<Clause[]>
  summarizeDocument(text: string, summaryType: string): Promise<DocumentSummary>
  compareDocuments(doc1Id: string, doc2Id: string): Promise<DocumentComparison>
}

// CaseAnalysisService  
class CaseAnalysisService {
  analyzeJudicialReasoning(caseId: string): Promise<ReasoningAnalysis>
  extractLegalPrinciples(caseIds: string[]): Promise<LegalPrinciple[]>
  compareDecisions(caseIds: string[]): Promise<DecisionComparison>
  trackPrecedentEvolution(caseId: string): Promise<PrecedentTimeline>
}

// CourtTrendsService
class CourtTrendsService {
  analyzeCourtTrends(courtId: string, timeRange: DateRange): Promise<CourtTrends>
  getJudgeStatistics(judgeId: string, timeRange: DateRange): Promise<JudgeStats>
}
```

## Implementation Order & Timeline

### **Phase 1: Foundation Tools (2 weeks)**
**Week 1-2: Simple Search & Retrieval**
1. `get_document_text` (1 day)
2. `get_case_metadata` (1 day)
3. `search_by_category` (2 days)
4. `search_by_court` (2 days)
5. `search_by_judge` (2 days)
6. `semantic_search` (2 days)

### **Phase 2: Document Processing (3 weeks)**
**Week 3-4: Core Document Operations**
7. `get_document` (2 days)
8. `parse_document` (4 days)
9. `get_practice_document` (2 days)
10. `search_court_practice` (3 days)

**Week 5: Advanced Processing**
11. `extract_key_clauses` (4 days)
12. `summarize_document` (3 days)

### **Phase 3: Analysis & Comparison (3 weeks)**
**Week 6-7: Pattern Analysis**
13. `find_legal_patterns` (3 days)
14. `validate_citations` (2 days)
15. `packaged_lawyer_answer` (3 days)
16. `analyze_judicial_reasoning` (4 days)

**Week 8: Comparative Analysis**
17. `compare_documents` (4 days)
18. `compare_decisions` (3 days)

### **Phase 4: Advanced Features (2 weeks)**
**Week 9-10: Complex Analysis**
19. `extract_legal_principles` (4 days)
20. `track_precedent_evolution` (3 days)
21. `analyze_court_trends` (4 days)
22. `get_related_cases` (2 days)

### **Phase 5: Network & Final (1 week)**
**Week 11: Network Tools**
23. `get_citation_network` (3 days)
24. `search_by_date_range` (2 days)

**Total Estimated Time: 11 weeks (2.5 months)**

## Code Patterns to Follow

### **1. Standard Tool Implementation Pattern**
```typescript
private async toolName(args: any): Promise<any> {
  // Input validation
  if (!args.requiredParam) {
    throw new Error('requiredParam is required');
  }

  // Log tool start
  logger.info(`[MCP Tool] ${toolName} started`, { args: args });

  try {
    // Core logic
    const result = await this.someService.doSomething(args);

    // Return standard format
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  } catch (error: any) {
    logger.error(`Tool ${toolName} failed`, { error: error.message });
    throw new Error(`${toolName} failed: ${error.message}`);
  }
}
```

### **2. Pagination Pattern (for search tools)**
```typescript
// Use existing countAllResults and performRegularSearch patterns
const limit = Math.min(50, Math.max(1, Number(args.limit || 10)));
const offset = Math.max(0, Number(args.offset || 0));

// Apply filters
const searchParams = {
  meta: { search: query },
  limit,
  offset,
  ...dateFilters,
  ...courtFilters
};
```

### **3. Document Access Pattern**
```typescript
// Use ZOAdapter for consistent document access
const document = await this.zoAdapter.getDocumentFullText(docId);
const metadata = await this.zoAdapter.getDocumentMetadata(docId);

// Or use practice adapter for practice database
const practiceDoc = await this.zoPracticeAdapter.searchCourtDecisions(params);
```

### **4. LLM Integration Pattern**
```typescript
const model = ModelSelector.getChatModel(budget);
const openaiManager = getOpenAIManager();

const response = await openaiManager.executeWithRetry(async (client) => {
  return await client.chat.completions.create({
    model,
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    temperature: 0.2,
    max_tokens: 1500
  });
});
```

## Testing Strategy

### **Unit Tests for Each Tool**
```typescript
describe('toolName', () => {
  it('should validate required parameters', async () => {
    await expect(mcpApi.toolName({})).rejects.toThrow('requiredParam is required');
  });

  it('should return expected format', async () => {
    const result = await mcpApi.toolName(validArgs);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
  });
});
```

### **Integration Tests**
- Test with real ZakonOnline API responses
- Test database operations
- Test LLM integrations with mocked responses
- Test cost tracking functionality

## Cost & Resource Estimates

### **Development Costs**
- **Senior Developer**: 11 weeks × 5 days = 55 days
- **Code Review & Testing**: 20% overhead = 11 days
- **Total Effort**: ~66 developer days

### **Infrastructure Costs**
- **Database Storage**: Additional tables (~50MB for 100K cases)
- **Vector Storage**: Additional embeddings for new features
- **API Usage**: Testing and development (~$500/month)

### **Operational Costs**
- **LLM API Calls**: New tools will increase OpenAI usage by ~20%
- **Database Queries**: More complex queries may need optimization
- **Memory Usage**: Pattern analysis and trend computation

## Risk Assessment & Mitigation

### **High Risk Items**
1. **LLM API Costs**: Advanced analysis tools use expensive LLM calls
   - **Mitigation**: Implement budget limits and caching
   
2. **Performance**: Complex analysis tools may be slow
   - **Mitigation**: Implement async processing and streaming

3. **Data Quality**: Pattern detection needs high-quality data
   - **Mitigation**: Validate inputs and handle edge cases

### **Medium Risk Items**
1. **API Rate Limits**: ZakonOnline API may have limits
   - **Mitigation**: Implement rate limiting and queuing
   
2. **Schema Changes**: New features may require database migrations
   - **Mitigation**: Plan migrations carefully with rollback

## Success Metrics

### **Implementation Success**
- All 24 tools implemented and tested
- Tools follow existing patterns and conventions
- Performance meets SLA requirements (<30s per tool call)
- Cost tracking works for all tools

### **Quality Metrics**
- Test coverage >80% for new tools
- No critical bugs in production
- Tools handle edge cases gracefully
- Documentation complete for all tools

## Conclusion

The implementation of 24 missing backend tools is a significant but manageable effort that will complete the MCP backend's functionality. The 11-week timeline allows for systematic implementation with proper testing and documentation.

Key success factors:
1. **Follow existing patterns** for consistency
2. **Implement incrementally** starting with simple tools
3. **Test thoroughly** at each phase
4. **Monitor costs** and performance throughout
5. **Document properly** for maintainability

The modular approach ensures that each tool can be developed and tested independently while maintaining the overall system architecture and quality standards.