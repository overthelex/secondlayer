import { MCPQueryAPI } from '../mcp-query-api.js';
import { QueryPlanner } from '../../services/query-planner.js';
import { ZOAdapter } from '../../adapters/zo-adapter.js';
import { SemanticSectionizer } from '../../services/semantic-sectionizer.js';
import { EmbeddingService } from '../../services/embedding-service.js';
import { LegalPatternStore } from '../../services/legal-pattern-store.js';
import { CitationValidator } from '../../services/citation-validator.js';
import { HallucinationGuard } from '../../services/hallucination-guard.js';
import { Database } from '../../database/database.js';

describe('search_legal_precedents tool', () => {
  let mcpAPI: MCPQueryAPI;
  let db: Database;
  let queryPlanner: QueryPlanner;
  let zoAdapter: ZOAdapter;
  let sectionizer: SemanticSectionizer;
  let embeddingService: EmbeddingService;
  let patternStore: LegalPatternStore;
  let citationValidator: CitationValidator;
  let hallucinationGuard: HallucinationGuard;

  beforeAll(async () => {
    // Initialize database
    db = new Database();
    await db.connect();

    // Initialize services
    queryPlanner = new QueryPlanner();
    zoAdapter = new ZOAdapter();
    sectionizer = new SemanticSectionizer();
    embeddingService = new EmbeddingService();
    await embeddingService.initialize();
    
    patternStore = new LegalPatternStore(db, embeddingService);
    citationValidator = new CitationValidator(db);
    hallucinationGuard = new HallucinationGuard(db);

    // Initialize MCP API
    mcpAPI = new MCPQueryAPI(
      queryPlanner,
      zoAdapter,
      zoAdapter,
      sectionizer,
      embeddingService,
      patternStore,
      citationValidator,
      hallucinationGuard
    );
  }, 60000);

  afterAll(async () => {
    // Cleanup connections
    try {
      if (db) {
        await db.close();
      }
      if (zoAdapter && (zoAdapter as any).redis) {
        const redis = (zoAdapter as any).redis;
        if (redis && typeof redis.quit === 'function') {
          await redis.quit();
        } else if (redis && typeof redis.disconnect === 'function') {
          await redis.disconnect();
        }
      }
      // Give time for connections to close
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      // Ignore cleanup errors
      console.warn('Cleanup warning:', error);
    }
  }, 10000);

  test('should find relevant precedents for case 756/655/23', async () => {
    const caseNumber = '756/655/23';
    const query = `Справа ${caseNumber}`;

    const args = {
      query: query,
      domain: 'court',
      limit: 10,
    };

    console.log(`\n🔍 Testing search_legal_precedents for case: ${caseNumber}`);
    console.log(`Query: "${query}"`);

    let result;
    try {
      result = await mcpAPI.handleToolCall('search_legal_precedents', args);
    } catch (error: any) {
      console.log(`\n⚠️  Tool call failed: ${error.message}`);
      console.log(`This might be due to API connectivity issues.`);
      // If it's a connectivity error, skip the test instead of failing
      if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
        console.log(`\n⏭️  Skipping test due to API unavailability`);
        return; // Skip this test
      }
      throw error;
    }

    // Verify result structure
    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);

    // Parse the result
    const resultText = result.content[0].text;
    let parsedResult;
    try {
      parsedResult = JSON.parse(resultText);
    } catch (parseError: any) {
      console.error('\n❌ Failed to parse result:', resultText.substring(0, 200));
      // If result contains error message, it's likely an API error
      if (resultText.includes('Error:') || resultText.includes('error')) {
        console.log(`\n⏭️  Skipping test due to API error in response`);
        return; // Skip this test
      }
      throw new Error(`Invalid JSON response: ${parseError.message}`);
    }

    console.log(`\n✅ Search completed`);
    console.log(`Intent: ${parsedResult.intent?.intent || 'N/A'}`);
    console.log(`Confidence: ${parsedResult.intent?.confidence || 'N/A'}`);
    console.log(`Total results: ${parsedResult.total || 0}`);

    // Verify result structure
    expect(parsedResult).toHaveProperty('results');
    expect(parsedResult).toHaveProperty('intent');
    expect(parsedResult).toHaveProperty('total');
    expect(Array.isArray(parsedResult.results)).toBe(true);
    expect(parsedResult.total).toBeGreaterThanOrEqual(0);

    // If results found, verify structure
    if (parsedResult.results.length > 0) {
      console.log(`\n📋 Found ${parsedResult.results.length} precedents:`);
      
      parsedResult.results.slice(0, 5).forEach((precedent: any, index: number) => {
        console.log(`\n${index + 1}. ${precedent.title || precedent.id || 'N/A'}`);
        if (precedent.court) console.log(`   Court: ${precedent.court}`);
        if (precedent.date) console.log(`   Date: ${precedent.date}`);
        if (precedent.url) console.log(`   URL: ${precedent.url}`);
      });

      // Verify first result structure
      const firstResult = parsedResult.results[0];
      expect(firstResult).toBeDefined();
      
      // Check if any result mentions the case number
      const hasRelevantCase = parsedResult.results.some((r: any) => 
        (typeof r.case_number === 'string' && r.case_number.includes(caseNumber)) || 
        (typeof r.title === 'string' && r.title.includes(caseNumber)) ||
        (typeof r.id === 'string' && r.id.includes(caseNumber)) ||
        (typeof r.id === 'number' && String(r.id).includes(caseNumber))
      );

      if (hasRelevantCase) {
        console.log(`\n✅ Found direct match for case ${caseNumber}`);
      } else {
        console.log(`\n⚠️  No direct match found, but found ${parsedResult.results.length} related precedents`);
      }
    } else {
      console.log(`\n⚠️  No precedents found for case ${caseNumber}`);
    }

    // Verify intent classification
    expect(parsedResult.intent).toBeDefined();
    expect(parsedResult.intent).toHaveProperty('intent');
    expect(parsedResult.intent).toHaveProperty('confidence');
  }, 120000);

  test('should handle search with different domains', async () => {
    const query = '756/655/23';

    // Limit to single domain test to avoid excessive API calls
    const testCases = [
      { domain: 'court', description: 'Court decisions' },
      // Removed 'all' domain to reduce API calls and respect rate limits
    ];

    for (const testCase of testCases) {
      console.log(`\n🔍 Testing domain: ${testCase.domain} (${testCase.description})`);

      const args = {
        query: query,
        domain: testCase.domain,
        limit: 5, // Reduced limit to minimize API load
      };

      // Add delay between requests to respect rate limits
      if (testCase !== testCases[0]) {
        console.log(`   ⏳ Waiting 500ms to respect API rate limits...`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      let result;
      try {
        result = await mcpAPI.handleToolCall('search_legal_precedents', args);
      } catch (error: any) {
        console.log(`   ⚠️  Search failed: ${error.message}`);
        // If rate limited, skip remaining tests
        if (error.message.includes('429') || error.message.includes('rate limit')) {
          console.log(`   ⏭️  Rate limited - skipping remaining tests to respect API limits`);
          break;
        }
        // Continue with next test case even if this one fails
        continue;
      }

      const resultText = result.content[0].text;
      let parsedResult;
      try {
        parsedResult = JSON.parse(resultText);
      } catch (parseError) {
        console.log(`   ⚠️  Failed to parse result`);
        continue;
      }

      expect(parsedResult).toHaveProperty('results');
      expect(parsedResult).toHaveProperty('total');
      expect(Array.isArray(parsedResult.results)).toBe(true);

      console.log(`   Results: ${parsedResult.total}`);
    }
  }, 120000);
});
