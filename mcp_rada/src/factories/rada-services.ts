import { Database } from '../database/database';
import { RadaAPIAdapter } from '../adapters/rada-api-adapter';
import { ZakonRadaAdapter } from '../adapters/zakon-rada-adapter';
import { DeputyService } from '../services/deputy-service';
import { BillService } from '../services/bill-service';
import { LegislationService } from '../services/legislation-service';
import { VotingService } from '../services/voting-service';
import { CrossReferenceService } from '../services/cross-reference-service';
import { CostTracker } from '../services/cost-tracker';
import { MCPRadaAPI } from '../api/mcp-rada-api';
import { getLLMManager } from '../utils/llm-client-manager';

export interface RadaCoreServices {
  db: Database;
  radaAdapter: RadaAPIAdapter;
  zakonAdapter: ZakonRadaAdapter;
  costTracker: CostTracker;
  deputyService: DeputyService;
  billService: BillService;
  legislationService: LegislationService;
  votingService: VotingService;
  crossRefService: CrossReferenceService;
  mcpAPI: MCPRadaAPI;
}

export function createRadaCoreServices(): RadaCoreServices {
  const db = new Database();
  const radaAdapter = new RadaAPIAdapter();
  const zakonAdapter = new ZakonRadaAdapter();

  const costTracker = new CostTracker(db);

  // Set cost tracker on LLM manager
  const llmManager = getLLMManager();
  llmManager.setCostTracker(costTracker);

  const deputyService = new DeputyService(db, radaAdapter);
  const billService = new BillService(db, radaAdapter);
  const legislationService = new LegislationService(db, zakonAdapter);
  const votingService = new VotingService(db, radaAdapter);
  const crossRefService = new CrossReferenceService(db);

  // Set cost tracker on adapters
  radaAdapter.setCostTracker(costTracker);
  zakonAdapter.setCostTracker(costTracker);

  const mcpAPI = new MCPRadaAPI(
    deputyService,
    billService,
    legislationService,
    votingService,
    crossRefService,
    costTracker
  );

  return {
    db,
    radaAdapter,
    zakonAdapter,
    costTracker,
    deputyService,
    billService,
    legislationService,
    votingService,
    crossRefService,
    mcpAPI,
  };
}
