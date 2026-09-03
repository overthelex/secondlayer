import { BackendCoreServices } from './core-services.js';
import { CostTracker } from '../services/cost-tracker.js';
import { DocumentParser } from '../services/document-parser.js';
import { DocumentAnalysisTools } from '../api/document-analysis-tools.js';
import { BatchDocumentTools } from '../api/batch-document-tools.js';
import { MetadataExtractor } from '../services/metadata-extractor.js';
import { ToolRegistry } from '../api/tool-registry.js';
import { ServiceProxy } from '../services/service-proxy.js';
import { RemoteServiceClient } from '../services/remote-service-client.js';
import { UploadService } from '../services/upload-service.js';
import { MinioService } from '../services/minio-service.js';
import { VaultTools } from '../api/vault-tools.js';
import { CourtDecisionTools } from '../api/tools/court-decision-tools.js';
import { ProceduralTools } from '../api/tools/procedural-tools.js';
import { LegalAdviceTools } from '../api/tools/legal-advice-tools.js';
import { DueDiligenceTools } from '../api/due-diligence-tools.js';
import { DueDiligenceService } from '../services/due-diligence-service.js';
import { CourtSessionTools } from '../api/tools/court-session-tools.js';
import { LegalActsTools } from '../api/tools/legal-acts-tools.js';
import { ECHRPracticeTools } from '../api/tools/echr-practice-tools.js';
import { EdsrExtendedTools } from '../api/tools/edrsr-extended-tools.js';
import { EdsrUnifiedSearchTool } from '../api/tools/edrsr-unified-search-tool.js';
import { EdsrFtsService } from '../services/edrsr-fts-service.js';
import { EdsrVectorizerService } from '../services/edrsr-vectorizer-service.js';
import { SearchResultFilter } from '../services/search-result-filter.js';
import { QueryReformulator } from '../services/query-reformulator.js';
import { NextcloudService } from '../services/nextcloud-service.js';
import { NextcloudTools } from '../api/tools/nextcloud-tools.js';
import { CourtStatusTools } from '../api/tools/court-status-tools.js';
import { OpenDataTools } from '../api/tools/opendata-tools.js';
import { NpaTools } from '../api/tools/npa-tools.js';
import { ChCitationTools } from '../api/tools/ch-citation-tools.js';
import { ChVerificationTools } from '../api/tools/ch-verification-tools.js';
import { ChCourtTools } from '../api/tools/ch-court-tools.js';
import { ChLegislationTools } from '../api/tools/ch-legislation-tools.js';
import { ChRegistryTools } from '../api/tools/ch-registry-tools.js';
import { ChCommentaryTools } from '../api/tools/ch-commentary-tools.js';
import { ChMaterialsTools } from '../api/tools/ch-materials-tools.js';
import { AmcuPracticeTools } from '../api/tools/amcu-practice-tools.js';
import { ChSemanticTools } from '../api/tools/ch-semantic-tools.js';
import { SpendingTools } from '../api/tools/spending-tools.js';
import { OpenDataRegistriesTools } from '../api/tools/opendata-registries-tools.js';
import { Tier1OpenDataTools } from '../api/tools/tier1-opendata-tools.js';
import { RegistrySearchTool } from '../api/tools/registry-search-tool.js';
import { IpObjectsTools } from '../api/tools/ip-objects-tools.js';
import { AnalyzeDataTool } from '../api/tools/analyze-data-tool.js';
import { LLMAdapter } from '../infrastructure/adapters/llm-adapter.js';
import { DecisionLayerTools } from '../api/tools/decision-layer-tools.js';
import { ImportTaskTools } from '../api/tools/import-task-tools.js';
import { WorkflowMemoryTools } from '../api/tools/workflow-memory-tools.js';
import { WorkflowMemoryService } from '../services/workflow-memory-service.js';
import { WorkflowMemoryPushService } from '../services/workflow-memory-push-service.js';
import { OsintProxyAdapter } from '../adapters/osint-proxy-adapter.js';
import { OsintProxyTools } from '../api/tools/osint-proxy-tools.js';
import { IndiaCourtTools } from '../api/tools/india-court-tools.js';
import { ABTestingTools } from '../api/tools/ab-testing-tools.js';
import { ABTestingService } from '../services/ab-testing-service.js';
import { logger } from '../utils/logger.js';
import path from 'path';

export interface ToolServices {
  toolRegistry: ToolRegistry;
  serviceProxy: ServiceProxy;
  documentParser: DocumentParser;
  documentAnalysisTools: DocumentAnalysisTools;
  batchDocumentTools: BatchDocumentTools;
  uploadService: UploadService;
  minioService: MinioService;
  vaultTools: VaultTools;
  edsrFtsService: EdsrFtsService;
  edsrVectorizer?: EdsrVectorizerService;
}

export function createToolServices(
  coreServices: BackendCoreServices,
  costTracker: CostTracker,
  llmAdapter: LLMAdapter
): ToolServices {
  // Document parser with Vision API credentials
  const visionKeyPath = process.env.VISION_CREDENTIALS_PATH ||
                       process.env.GOOGLE_APPLICATION_CREDENTIALS ||
                       path.resolve(process.cwd(), '../vision-ocr-credentials.json');
  const documentParser = new DocumentParser(visionKeyPath, llmAdapter);

  const documentAnalysisTools = new DocumentAnalysisTools(
    documentParser,
    coreServices.sectionizer,
    coreServices.patternStore,
    coreServices.citationValidator,
    coreServices.embeddingService,
    coreServices.documentService,
    llmAdapter
  );

  const batchDocumentTools = new BatchDocumentTools(
    documentParser,
    documentAnalysisTools
  );
  logger.info('Batch document processing tools initialized');

  // Unified Gateway components — single shared HTTP client for remote services
  const remoteClient = new RemoteServiceClient();
  const toolRegistry = new ToolRegistry(remoteClient);
  const serviceProxy = new ServiceProxy(costTracker, remoteClient);
  logger.info('Unified Gateway initialized (Tool Registry + Service Proxy)');

  // EDRSR FTS service — instantiated early so procedural/unified tools can share it
  const edsrFtsService = new EdsrFtsService();
  // check_precedent_status resolves case numbers against edrsr_case_index, which lives in
  // the dedicated EDRSR database when EDRSR_DATABASE_URL is set. Hand the service over so
  // it reads the corpus from the same pool the corpus tools use.
  coreServices.mcpAPI.setEdsrFtsService(edsrFtsService);

  // Register all tool handlers with the central registry
  toolRegistry.registerHandler(coreServices.legislationTools);
  toolRegistry.registerHandler(documentAnalysisTools);
  toolRegistry.registerHandler(batchDocumentTools);
  const ddService = new DueDiligenceService(
    coreServices.sectionizer,
    coreServices.patternStore,
    coreServices.citationValidator,
    coreServices.documentService,
    llmAdapter
  );
  toolRegistry.registerHandler(new DueDiligenceTools(ddService));
  toolRegistry.registerHandler(coreServices.mcpAPI);
  toolRegistry.registerHandler(new CourtDecisionTools(
    coreServices.zoAdapter,
    coreServices.zoPracticeAdapter,
    coreServices.sectionizer,
    coreServices.embeddingService,
    coreServices.patternStore,
    coreServices.db,
    edsrFtsService,
    coreServices.citationGraphService
  ));
  // EDRSR vectorizer (BGE-M3 + qdrant edrsr_serving HNSW) — shared by ProceduralTools
  // (find_similar_fact_pattern_cases) and EdsrUnifiedSearchTool below.
  let edsrVectorizer: EdsrVectorizerService | undefined;
  try {
    edsrVectorizer = new EdsrVectorizerService();
    edsrVectorizer.setUsageCallback((tokens, model, task) => {
      costTracker.recordVoyageCall({ model, totalTokens: tokens, task }).catch((err) => {
        logger.warn('Failed to record embedding cost', { error: err.message });
      });
    });
  } catch (err: any) {
    logger.warn('EdsrVectorizerService not available (BGE_M3_URL missing?)', { error: err.message });
  }

  toolRegistry.registerHandler(new ProceduralTools(
    coreServices.zoAdapter,
    coreServices.zoPracticeAdapter,
    coreServices.sectionizer,
    coreServices.embeddingService,
    coreServices.patternStore,
    llmAdapter,
    edsrFtsService,
    coreServices.db,
    edsrVectorizer,
  ));
  toolRegistry.registerHandler(new LegalAdviceTools(
    coreServices.queryPlanner,
    coreServices.zoAdapter,
    coreServices.zoPracticeAdapter,
    coreServices.sectionizer,
    coreServices.embeddingService,
    coreServices.patternStore,
    coreServices.citationValidator,
    coreServices.shepardizationService,
    llmAdapter,
    coreServices.db,
    edsrFtsService,
    coreServices.citationGraphService
  ));
  toolRegistry.registerHandler(new CourtSessionTools(
    coreServices.zoSessionsAdapter,
    coreServices.db
  ));
  toolRegistry.registerHandler(new LegalActsTools(coreServices.zoLegalActsAdapter));
  toolRegistry.registerHandler(new ECHRPracticeTools(coreServices.zoECHRAdapter));
  toolRegistry.registerHandler(new CourtStatusTools(coreServices.db));
  toolRegistry.registerHandler(new RegistrySearchTool(coreServices.db));
  toolRegistry.registerHandler(new IpObjectsTools(coreServices.db, toolRegistry));
  toolRegistry.registerHandler(new AnalyzeDataTool(coreServices.db));
  // Bespoke tools with non-parametric query patterns
  toolRegistry.registerHandler(new OpenDataTools(coreServices.db));
  // Full НПА corpus (schema `npa`) — 293K acts, distinct from the ~655 curated legislation acts
  toolRegistry.registerHandler(new NpaTools(coreServices.db));
  toolRegistry.registerHandler(new ChCourtTools(coreServices.db));
  toolRegistry.registerHandler(new ChLegislationTools(coreServices.db));
  // Case-citation graph + precedent status over ch_case_citations / ch_decision_index
  toolRegistry.registerHandler(new ChCitationTools(coreServices.db));
  // Deterministic grounding self-check for external MCP agents (LEXAI-2036)
  toolRegistry.registerHandler(new ChVerificationTools(coreServices.db));
  // Swiss company registers: Zefix + SHAB gazette + FINMA + SECO sanctions + Kantonsblatt
  toolRegistry.registerHandler(new ChRegistryTools(coreServices.db));
  // Open-access commentaries on Swiss federal acts (onlinekommentar.ch, CC BY 4.0; LEXAI-2037)
  toolRegistry.registerHandler(new ChCommentaryTools(coreServices.db));
  // Federal Gazette materials: Botschaften, reports, article purpose via provenance (LEXAI-2038)
  toolRegistry.registerHandler(new ChMaterialsTools(coreServices.db));
  // Semantic layer over the whole CH corpus (Qdrant ch_corpus_bge_cls, LEXAI-2004)
  toolRegistry.registerHandler(new ChSemanticTools(coreServices.db));
  // Semantic layer over АМКУ decisions (Qdrant amcu_bge_cls); keyword search stays in search_registry
  toolRegistry.registerHandler(new AmcuPracticeTools(coreServices.db));
  toolRegistry.registerHandler(new SpendingTools(coreServices.db));
  toolRegistry.registerHandler(new OpenDataRegistriesTools(coreServices.db));
  toolRegistry.registerHandler(new Tier1OpenDataTools(coreServices.db));
  toolRegistry.registerHandler(new EdsrExtendedTools(coreServices.db));
  toolRegistry.registerHandler(new IndiaCourtTools(coreServices.db));
  toolRegistry.registerHandler(new DecisionLayerTools(llmAdapter));

  // EDRSR unified search (structured + FTS + hybrid + semantic in one tool)
  // Reuses the edsrVectorizer instance created above.
  const edsrUnifiedSearch = new EdsrUnifiedSearchTool(coreServices.db, edsrFtsService, edsrVectorizer);
  edsrUnifiedSearch.setResultFilter(new SearchResultFilter(llmAdapter));
  edsrUnifiedSearch.setQueryReformulator(new QueryReformulator(llmAdapter));
  toolRegistry.registerHandler(edsrUnifiedSearch);
  // Import task manager (multi-IP downloads)
  toolRegistry.registerHandler(new ImportTaskTools(coreServices.importTaskService));

  // Workflow Memory — three-layer semantic retrieval + push-mode orchestrator
  const wmService = new WorkflowMemoryService(coreServices.db, coreServices.embeddingService);
  const wmTools = new WorkflowMemoryTools(wmService);
  const pushSummarize = async (prompt: string) => {
    const resp = await llmAdapter.chatCompletion({ messages: [{ role: 'user', content: prompt }] }, 'quick');
    return typeof resp === 'string' ? resp : (resp as any).content ?? '';
  };
  const wmPushService = new WorkflowMemoryPushService(coreServices.db, pushSummarize);
  wmTools.setPushService(wmPushService);
  toolRegistry.registerHandler(wmTools);

  // A/B testing tools
  const abTestingService = new ABTestingService(coreServices.db);
  toolRegistry.registerHandler(new ABTestingTools(abTestingService));

  logger.info('Core tool handlers registered with ToolRegistry');

  // Nextcloud integration
  const nextcloudService = new NextcloudService();
  toolRegistry.registerHandler(new NextcloudTools(nextcloudService));
  logger.info('Nextcloud tools registered');

  // Upload and storage services
  const uploadService = new UploadService(coreServices.db);
  const minioService = new MinioService();
  const metadataExtractor = new MetadataExtractor(llmAdapter);
  const vaultTools = new VaultTools(
    documentParser,
    coreServices.sectionizer,
    coreServices.patternStore,
    coreServices.embeddingService,
    coreServices.documentService,
    metadataExtractor
  );
  vaultTools.setMinioService(minioService);
  toolRegistry.registerHandler(vaultTools);
  logger.info('Upload, MinIO, and Vault services initialized');

  // OSINT proxy (SneakyPiper integration)
  //
  // TEMPORARILY DISABLED 2026-06-23: the upstream SneakyPiper self-hosted yente /
  // OpenSanctions host (178.150.37.129, reachable over the wg-panoptic mesh at
  // 10.77.0.1:8200) is down, and the INTERPOL relay is failing. Every osint_* call
  // therefore returned an empty result set, which for a sanctions/PEP check is a
  // dangerous false-negative ("nothing found" reads as "not sanctioned"). We keep the
  // adapter and tools in the codebase (nothing deleted) but skip registration so they
  // do not reach the chat. Re-enable once the host is restored: either revert this
  // guard or set OSINT_PROXY_ENABLED=true.
  const osintAdapter = new OsintProxyAdapter(
    process.env.SNEAKYPIPER_API_URL || '',
    process.env.SNEAKYPIPER_API_KEY || ''
  );
  const osintProxyEnabled = process.env.OSINT_PROXY_ENABLED === 'true';
  if (osintProxyEnabled && osintAdapter.isConfigured()) {
    toolRegistry.registerHandler(new OsintProxyTools(osintAdapter));
    logger.info('OSINT proxy tools registered (SneakyPiper)');
  } else if (osintAdapter.isConfigured()) {
    logger.warn(
      'OSINT proxy tools NOT registered: disabled via kill-switch (set OSINT_PROXY_ENABLED=true to re-enable once SneakyPiper upstream is restored)'
    );
  }

  return {
    toolRegistry,
    serviceProxy,
    documentParser,
    documentAnalysisTools,
    batchDocumentTools,
    uploadService,
    minioService,
    vaultTools,
    edsrFtsService,
    edsrVectorizer,
  };
}
