import { MCPQueryAPI } from './dist/api/mcp-query-api.js';
import { Database } from './dist/database/database.js';
import { DocumentService } from './dist/services/document-service.js';
import { ZOAdapter } from './dist/adapters/zo-adapter.js';
import { QueryPlanner } from './dist/services/query-planner.js';
import { SemanticSectionizer } from './dist/services/semantic-sectionizer.js';
import { EmbeddingService } from './dist/services/embedding-service.js';
import { LegalPatternStore } from './dist/services/legal-pattern-store.js';
import { CitationValidator } from './dist/services/citation-validator.js';
import { HallucinationGuard } from './dist/services/hallucination-guard.js';
import { CostTracker } from './dist/services/cost-tracker.js';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const db = new Database();
  await db.initialize();

  const zoAdapter = new ZOAdapter();
  const zoPracticeAdapter = new ZOAdapter();
  const documentService = new DocumentService(db, zoAdapter);
  const queryPlanner = new QueryPlanner();
  const sectionizer = new SemanticSectionizer();
  const embeddingService = new EmbeddingService(db);
  const patternStore = new LegalPatternStore(db, embeddingService);
  const citationValidator = new CitationValidator(documentService);
  const hallucinationGuard = new HallucinationGuard(citationValidator);
  const costTracker = new CostTracker(db);

  const mcpAPI = new MCPQueryAPI(
    db,
    documentService,
    zoAdapter,
    zoPracticeAdapter,
    queryPlanner,
    sectionizer,
    embeddingService,
    patternStore,
    citationValidator,
    hallucinationGuard,
    costTracker
  );

  try {
    const result = await mcpAPI.getDocumentText({
      case_number: '756/655/23',
      depth: 5,
      reasoning_budget: 'standard'
    });
    
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
  } finally {
    await db.close();
  }
}

main();
