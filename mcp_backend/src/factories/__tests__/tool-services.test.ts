/**
 * tool-services factory tests
 *
 * Verifies that createToolServices() correctly instantiates all tool-related
 * services and registers all expected tool handlers with the ToolRegistry.
 */

// ─── Module mocks ─────────────────────────────────────────────────────────────

const mockRegisterHandler = jest.fn();

jest.mock('../../services/document-parser.js', () => ({
  DocumentParser: jest.fn().mockImplementation(() => ({ parse: jest.fn() })),
}));

jest.mock('../../api/document-analysis-tools.js', () => ({
  DocumentAnalysisTools: jest.fn().mockImplementation(() => ({
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../../api/batch-document-tools.js', () => ({
  BatchDocumentTools: jest.fn().mockImplementation(() => ({
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../../services/metadata-extractor.js', () => ({
  MetadataExtractor: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../api/tool-registry.js', () => ({
  ToolRegistry: jest.fn().mockImplementation(() => ({
    registerHandler: mockRegisterHandler,
    getHandler: jest.fn(),
  })),
}));

jest.mock('../../services/service-proxy.js', () => ({
  ServiceProxy: jest.fn().mockImplementation(() => ({
    setExternalApiMetrics: jest.fn(),
  })),
}));

jest.mock('../../services/remote-service-client.js', () => ({
  RemoteServiceClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../services/upload-service.js', () => ({
  UploadService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../services/minio-service.js', () => ({
  MinioService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../api/vault-tools.js', () => ({
  VaultTools: jest.fn().mockImplementation(() => ({
    setMinioService: jest.fn(),
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../../api/tools/court-decision-tools.js', () => ({
  CourtDecisionTools: jest.fn().mockImplementation(() => ({
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../../api/tools/procedural-tools.js', () => ({
  ProceduralTools: jest.fn().mockImplementation(() => ({
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../../api/tools/legal-advice-tools.js', () => ({
  LegalAdviceTools: jest.fn().mockImplementation(() => ({
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../../api/due-diligence-tools.js', () => ({
  DueDiligenceTools: jest.fn().mockImplementation(() => ({
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../../services/due-diligence-service.js', () => ({
  DueDiligenceService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../api/tools/court-session-tools.js', () => ({
  CourtSessionTools: jest.fn().mockImplementation(() => ({
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../../api/tools/legal-acts-tools.js', () => ({
  LegalActsTools: jest.fn().mockImplementation(() => ({
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../../api/tools/echr-practice-tools.js', () => ({
  ECHRPracticeTools: jest.fn().mockImplementation(() => ({
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../../api/tools/edrsr-search-tools.js', () => ({
  EdsrSearchTools: jest.fn().mockImplementation(() => ({
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../../api/tools/edrsr-semantic-tools.js', () => ({
  EdsrSemanticTools: jest.fn().mockImplementation(() => ({
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../../services/edrsr-fts-service.js', () => ({
  EdsrFtsService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../services/edrsr-vectorizer-service.js', () => ({
  EdsrVectorizerService: jest.fn().mockImplementation(() => ({
    setTokenUsageCallback: jest.fn(),
  })),
}));

jest.mock('../../services/nextcloud-service.js', () => ({
  NextcloudService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../api/tools/nextcloud-tools.js', () => ({
  NextcloudTools: jest.fn().mockImplementation(() => ({
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../../api/tools/state-registry-tools.js', () => ({
  StateRegistryTools: jest.fn().mockImplementation(() => ({
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../../api/tools/court-status-tools.js', () => ({
  CourtStatusTools: jest.fn().mockImplementation(() => ({
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../../api/tools/opendata-tools.js', () => ({
  OpenDataTools: jest.fn().mockImplementation(() => ({
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../../api/tools/opendata-registries-tools.js', () => ({
  OpenDataRegistriesTools: jest.fn().mockImplementation(() => ({
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../../api/tools/decision-layer-tools.js', () => ({
  DecisionLayerTools: jest.fn().mockImplementation(() => ({
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../../api/tools/import-task-tools.js', () => ({
  ImportTaskTools: jest.fn().mockImplementation(() => ({
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../../utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { createToolServices } from '../tool-services.js';
import { ToolRegistry } from '../../api/tool-registry.js';
import { ServiceProxy } from '../../services/service-proxy.js';
import { DocumentParser } from '../../services/document-parser.js';
import { DocumentAnalysisTools } from '../../api/document-analysis-tools.js';
import { BatchDocumentTools } from '../../api/batch-document-tools.js';
import { UploadService } from '../../services/upload-service.js';
import { MinioService } from '../../services/minio-service.js';
import { VaultTools } from '../../api/vault-tools.js';
import { EdsrFtsService } from '../../services/edrsr-fts-service.js';
import { EdsrVectorizerService } from '../../services/edrsr-vectorizer-service.js';
import { NextcloudService } from '../../services/nextcloud-service.js';
import { RemoteServiceClient } from '../../services/remote-service-client.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCoreServices() {
  return {
    db: { query: jest.fn(), getPool: jest.fn() },
    documentService: { getDocument: jest.fn() },
    queryPlanner: { plan: jest.fn() },
    sectionizer: { sectionize: jest.fn() },
    embeddingService: { embed: jest.fn() },
    zoAdapter: { search: jest.fn(), setCostTracker: jest.fn() },
    zoPracticeAdapter: { search: jest.fn(), setCostTracker: jest.fn() },
    zoSessionsAdapter: { search: jest.fn() },
    zoLegalActsAdapter: { search: jest.fn() },
    zoECHRAdapter: { search: jest.fn() },
    patternStore: { store: jest.fn() },
    shepardizationService: { check: jest.fn() },
    citationValidator: { validate: jest.fn() },
    hallucinationGuard: { guard: jest.fn() },
    legislationTools: {
      getTools: jest.fn().mockReturnValue([]),
    },
    reyestrDownloadService: { download: jest.fn() },
    importTaskService: { create: jest.fn() },
    mcpAPI: { getTools: jest.fn().mockReturnValue([]), setEdsrFtsService: jest.fn() },
  } as any;
}

function makeCostTracker() {
  return {
    record: jest.fn(),
    recordVoyageCall: jest.fn().mockResolvedValue(undefined),
  } as any;
}

function makeLlmAdapter() {
  return { complete: jest.fn() } as any;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createToolServices', () => {
  let coreServices: ReturnType<typeof makeCoreServices>;
  let costTracker: ReturnType<typeof makeCostTracker>;
  let llmAdapter: ReturnType<typeof makeLlmAdapter>;
  let services: ReturnType<typeof createToolServices>;

  beforeEach(() => {
    jest.clearAllMocks();
    coreServices = makeCoreServices();
    costTracker = makeCostTracker();
    llmAdapter = makeLlmAdapter();
    services = createToolServices(coreServices, costTracker, llmAdapter);
  });

  // ── return shape ──────────────────────────────────────────────────────────

  describe('return shape', () => {
    it('returns toolRegistry', () => {
      expect(services.toolRegistry).toBeDefined();
    });

    it('returns serviceProxy', () => {
      expect(services.serviceProxy).toBeDefined();
    });

    it('returns documentParser', () => {
      expect(services.documentParser).toBeDefined();
    });

    it('returns documentAnalysisTools', () => {
      expect(services.documentAnalysisTools).toBeDefined();
    });

    it('returns batchDocumentTools', () => {
      expect(services.batchDocumentTools).toBeDefined();
    });

    it('returns uploadService', () => {
      expect(services.uploadService).toBeDefined();
    });

    it('returns minioService', () => {
      expect(services.minioService).toBeDefined();
    });

    it('returns vaultTools', () => {
      expect(services.vaultTools).toBeDefined();
    });

    it('returns edsrFtsService', () => {
      expect(services.edsrFtsService).toBeDefined();
    });
  });

  // ── constructor invocations ───────────────────────────────────────────────

  describe('constructor invocations', () => {
    it('constructs ToolRegistry once', () => {
      expect(ToolRegistry).toHaveBeenCalledTimes(1);
    });

    it('constructs RemoteServiceClient once', () => {
      expect(RemoteServiceClient).toHaveBeenCalledTimes(1);
    });

    it('constructs ServiceProxy with costTracker and remoteClient', () => {
      expect(ServiceProxy).toHaveBeenCalledTimes(1);
      const args = (ServiceProxy as jest.Mock).mock.calls[0];
      expect(args[0]).toBe(costTracker);
    });

    it('constructs DocumentParser once', () => {
      expect(DocumentParser).toHaveBeenCalledTimes(1);
    });

    it('constructs DocumentAnalysisTools once', () => {
      expect(DocumentAnalysisTools).toHaveBeenCalledTimes(1);
    });

    it('constructs BatchDocumentTools once', () => {
      expect(BatchDocumentTools).toHaveBeenCalledTimes(1);
    });

    it('constructs UploadService once', () => {
      expect(UploadService).toHaveBeenCalledTimes(1);
    });

    it('constructs MinioService once', () => {
      expect(MinioService).toHaveBeenCalledTimes(1);
    });

    it('constructs VaultTools once', () => {
      expect(VaultTools).toHaveBeenCalledTimes(1);
    });

    it('constructs EdsrFtsService once', () => {
      expect(EdsrFtsService).toHaveBeenCalledTimes(1);
    });

    it('constructs NextcloudService once', () => {
      expect(NextcloudService).toHaveBeenCalledTimes(1);
    });
  });

  // ── tool registry registrations ───────────────────────────────────────────

  describe('tool registry handler registrations', () => {
    it('calls registerHandler at least once', () => {
      expect(mockRegisterHandler).toHaveBeenCalled();
    });

    it('registers the legislationTools handler', () => {
      expect(mockRegisterHandler).toHaveBeenCalledWith(coreServices.legislationTools);
    });

    it('registers the documentAnalysisTools handler', () => {
      const docToolsInstance = (DocumentAnalysisTools as jest.Mock).mock.results[0].value;
      expect(mockRegisterHandler).toHaveBeenCalledWith(docToolsInstance);
    });

    it('registers the batchDocumentTools handler', () => {
      const batchInstance = (BatchDocumentTools as jest.Mock).mock.results[0].value;
      expect(mockRegisterHandler).toHaveBeenCalledWith(batchInstance);
    });

    it('registers the mcpAPI handler', () => {
      expect(mockRegisterHandler).toHaveBeenCalledWith(coreServices.mcpAPI);
    });

    it('registers the vaultTools handler', () => {
      const vaultInstance = (VaultTools as jest.Mock).mock.results[0].value;
      expect(mockRegisterHandler).toHaveBeenCalledWith(vaultInstance);
    });
  });

  // ── VaultTools wiring ─────────────────────────────────────────────────────

  describe('VaultTools wiring', () => {
    it('calls setMinioService on vaultTools', () => {
      const vaultInstance = (VaultTools as jest.Mock).mock.results[0].value;
      expect(vaultInstance.setMinioService).toHaveBeenCalledTimes(1);
    });

    it('passes the minioService instance to setMinioService', () => {
      const vaultInstance = (VaultTools as jest.Mock).mock.results[0].value;
      const minioInstance = (MinioService as unknown as jest.Mock).mock.results[0].value;
      expect(vaultInstance.setMinioService).toHaveBeenCalledWith(minioInstance);
    });
  });

  // ── DocumentParser receives vision credentials ────────────────────────────

  describe('DocumentParser credentials', () => {
    it('passes a string path as first arg to DocumentParser', () => {
      const [pathArg] = (DocumentParser as jest.Mock).mock.calls[0];
      expect(typeof pathArg).toBe('string');
    });

    it('passes llmAdapter as second arg to DocumentParser', () => {
      const [, llmArg] = (DocumentParser as jest.Mock).mock.calls[0];
      expect(llmArg).toBe(llmAdapter);
    });

    it('uses VISION_CREDENTIALS_PATH env var when set', () => {
      const originalPath = process.env.VISION_CREDENTIALS_PATH;
      process.env.VISION_CREDENTIALS_PATH = '/custom/vision/creds.json';
      jest.clearAllMocks();
      createToolServices(coreServices, costTracker, llmAdapter);
      const [pathArg] = (DocumentParser as jest.Mock).mock.calls[0];
      expect(pathArg).toBe('/custom/vision/creds.json');
      process.env.VISION_CREDENTIALS_PATH = originalPath;
    });
  });

  // ── EdsrVectorizer optional setup ─────────────────────────────────────────

  describe('EdsrVectorizer optional setup', () => {
    it('attempts to construct EdsrVectorizerService', () => {
      // The constructor is called — whether it succeeds depends on the env;
      // here it always succeeds since we mock it
      expect(EdsrVectorizerService).toHaveBeenCalledTimes(1);
    });

    it('registers a token usage callback on edsrVectorizer when available', () => {
      const vectorizerInstance = (EdsrVectorizerService as jest.Mock).mock.results[0]?.value;
      if (vectorizerInstance) {
        expect(vectorizerInstance.setTokenUsageCallback).toHaveBeenCalledWith(expect.any(Function));
      }
    });

    it('the token usage callback calls costTracker.recordVoyageCall', async () => {
      const vectorizerInstance = (EdsrVectorizerService as jest.Mock).mock.results[0]?.value;
      if (vectorizerInstance && vectorizerInstance.setTokenUsageCallback.mock.calls.length > 0) {
        const cb = vectorizerInstance.setTokenUsageCallback.mock.calls[0][0];
        await cb(100, 'voyage-2', 'search');
        expect(costTracker.recordVoyageCall).toHaveBeenCalledWith({
          model: 'voyage-2',
          totalTokens: 100,
          task: 'search',
        });
      }
    });
  });

  // ── EdsrVectorizer gracefully skipped when constructor throws ─────────────

  describe('EdsrVectorizer failure handling', () => {
    it('returns undefined edsrVectorizer when EdsrVectorizerService throws', () => {
      (EdsrVectorizerService as jest.Mock).mockImplementationOnce(() => {
        throw new Error('VOYAGEAI_API_KEY missing');
      });
      jest.clearAllMocks();
      // Re-mock registerHandler since clearAllMocks clears it
      (ToolRegistry as jest.Mock).mockImplementationOnce(() => ({
        registerHandler: mockRegisterHandler,
        getHandler: jest.fn(),
      }));
      const s = createToolServices(coreServices, costTracker, llmAdapter);
      expect(s.edsrVectorizer).toBeUndefined();
    });
  });
});
