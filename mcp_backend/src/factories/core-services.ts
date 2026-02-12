import { Database } from '../database/database.js';
import { DocumentService } from '../services/document-service.js';
import { ZOAdapter } from '../adapters/zo-adapter.js';
import { QueryPlanner } from '../services/query-planner.js';
import { SemanticSectionizer } from '../services/semantic-sectionizer.js';
import { EmbeddingService } from '../services/embedding-service.js';
import { LegalPatternStore } from '../services/legal-pattern-store.js';
import { CitationValidator } from '../services/citation-validator.js';
import { HallucinationGuard } from '../services/hallucination-guard.js';
import { MCPQueryAPI } from '../api/mcp-query-api.js';
import { LegislationTools } from '../api/legislation-tools.js';

export interface BackendCoreServices {
  db: Database;
  documentService: DocumentService;
  queryPlanner: QueryPlanner;
  sectionizer: SemanticSectionizer;
  embeddingService: EmbeddingService;
  zoAdapter: ZOAdapter;
  zoPracticeAdapter: ZOAdapter;
  patternStore: LegalPatternStore;
  citationValidator: CitationValidator;
  hallucinationGuard: HallucinationGuard;
  legislationTools: LegislationTools;
  mcpAPI: MCPQueryAPI;
}

export function createBackendCoreServices(): BackendCoreServices {
  const db = new Database();
  const documentService = new DocumentService(db);
  const queryPlanner = new QueryPlanner();
  const sectionizer = new SemanticSectionizer();
  const embeddingService = new EmbeddingService();
  const zoAdapter = new ZOAdapter(documentService, undefined, embeddingService);
  const zoPracticeAdapter = new ZOAdapter('court_practice', documentService, embeddingService);
  const patternStore = new LegalPatternStore(db, embeddingService);
  const citationValidator = new CitationValidator(db);
  const hallucinationGuard = new HallucinationGuard(db);
  const legislationTools = new LegislationTools(db.getPool(), embeddingService);

  const mcpAPI = new MCPQueryAPI(
    queryPlanner,
    zoAdapter,
    zoPracticeAdapter,
    embeddingService,
    patternStore,
    citationValidator,
    hallucinationGuard,
    legislationTools
  );

  return {
    db,
    documentService,
    queryPlanner,
    sectionizer,
    embeddingService,
    zoAdapter,
    zoPracticeAdapter,
    patternStore,
    citationValidator,
    hallucinationGuard,
    legislationTools,
    mcpAPI,
  };
}
