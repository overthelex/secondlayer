/**
 * Tool Registry - Central mapping and dispatch for all MCP tools
 *
 * Manages:
 * - Local tool handlers (BaseToolHandler instances)
 * - Remote tool routes (RADA, OpenReyestr)
 * - Unified tool execution dispatch
 * - Tool definition aggregation
 */

import { ToolRoute, ServiceType } from '../types/gateway.js';
import { logger } from '../utils/logger.js';
import { BaseToolHandler, ToolResult, ToolDefinition as BaseToolDefinition, StreamEventCallback } from './base-tool-handler.js';
import { RemoteServiceClient } from '../services/remote-service-client.js';
import { gatedRegistryOf, hasJudgmentAccessMark } from '../services/uk-judgment-access.js';
import { checkToolArgs } from './tool-args-validator.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: any;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface RemoteServiceConfig {
  baseUrl: string;
  apiKey: string;
}

/** Per-tool timeout overrides (ms). Tools not listed use DEFAULT_TOOL_TIMEOUT_MS. */
const TOOL_TIMEOUT_OVERRIDES: Record<string, number> = {
  search_court_decisions: 120_000,
  ch_search_court_decisions: 120_000,
  get_case_documents_chain: 120_000,
  edrsr_court_decisions_by_court: 90_000,
  // Semantic candidate retrieval (qdrant/HNSW) + a "standard" LLM holding-classification
  // call, with a keyword-FTS fallback. Intermittent qdrant/Bedrock latency can push the
  // happy path past 60s; matches the other heavy search tools above.
  compare_practice_pro_contra: 120_000,
  find_similar_fact_pattern_cases: 120_000,
  edrsr_get_decision_dispositive: 15_000,
  build_legal_decision: 120_000,
  search_public_spending: 120_000,
  // ~20 registry sub-calls in parallel (40 s soft deadline each), then courts by name.
  get_company_dossier: 100_000,
  // Up to 60 instruments and 200 provisions, 3-4 queries per instrument.
  uk_check_citations: 120_000,
  analyze_data: 45_000,
  osint_search_credentials: 35_000,
  osint_search_ransomware_victims: 35_000,
  osint_search_forum_subjects: 35_000,
  osint_search_sanctions: 35_000,
  osint_search_interpol: 35_000,
  osint_search_worldbank_debarment: 35_000,
  osint_search_cve: 35_000,
  osint_check_ip_reputation: 35_000,
  osint_check_domain_reputation: 35_000,
  osint_search_corporate_registry: 35_000,
  osint_search_media_mentions: 35_000,
  osint_search_github_leaks: 35_000,
};
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

type RemoteService = 'rada' | 'openreyestr';
const REMOTE_SERVICES: Array<{ service: RemoteService; prefix: string; label: string }> = [
  { service: 'rada', prefix: 'rada_', label: 'RADA' },
  { service: 'openreyestr', prefix: 'openreyestr_', label: 'OpenReyestr' },
];
/** After a failed remote definitions fetch, don't retry for this long. */
const REMOTE_DEFS_RETRY_MS = 30_000;
/**
 * Upper bound a tool call waits for its service's schema before the argument check fails
 * open. RemoteServiceClient's own request timeout is 5 s; this is a backstop.
 */
const REMOTE_SCHEMA_WAIT_MS = 6_000;

/**
 * Find Case Law licence backstop: only a transport that ran checkJudgmentAccess may
 * reach the judgments. See services/uk-judgment-access.ts.
 */
function refuseUngatedJudgmentCall(name: string, args: any): ToolResult | null {
  if (!gatedRegistryOf(name, args) || hasJudgmentAccessMark()) return null;
  logger.warn('Gated UK judgment call without an access check — refused', { tool: name });
  return {
    content: [{ type: 'text', text: 'Доступ до судових рішень Великої Британії через цей канал не надається.' }],
    isError: true,
  };
}

export class ToolRegistry {
  private routes: Map<string, ToolRoute>;
  private handlers: BaseToolHandler[] = [];
  private handlerMap: Map<string, BaseToolHandler> = new Map();
  /**
   * Remote (rada_* / openreyestr_*) tool definitions, per service. Only a completed,
   * non-empty fetch is cached; a failed one is retried after REMOTE_DEFS_RETRY_MS, and
   * concurrent callers share the single in-flight request (LEXAI-2164).
   */
  private remoteDefsCache: Map<RemoteService, ToolDefinition[]> = new Map();
  private remoteDefsInFlight: Map<RemoteService, Promise<ToolDefinition[] | null>> = new Map();
  private remoteDefsFailedAt: Map<RemoteService, number> = new Map();
  private remoteClient: RemoteServiceClient;
  /** Post-processors for proxied tool results, keyed by client tool name. */
  private remoteResultTransforms: Map<string, (result: any) => Promise<any>> = new Map();

  constructor(remoteClient?: RemoteServiceClient) {
    this.routes = new Map();
    this.remoteClient = remoteClient || new RemoteServiceClient();
    this.initializeRoutes();
  }

  // ========================= Remote Result Transforms =========================

  /**
   * Register a post-processor for a proxied (remote) tool's result. Used when the
   * gateway owns data the remote service cannot reach (e.g. openreyestr_get_statistics
   * counting public organizations from the backend DB, LEXAI-2121).
   */
  registerRemoteResultTransform(toolName: string, transform: (result: any) => Promise<any>): void {
    this.remoteResultTransforms.set(toolName, transform);
  }

  /** Apply the registered transform for a proxied tool, or return the result unchanged. */
  async transformRemoteResult(toolName: string, result: any): Promise<any> {
    const transform = this.remoteResultTransforms.get(toolName);
    return transform ? transform(result) : result;
  }

  // ========================= Handler Registration =========================

  /**
   * Register a BaseToolHandler. Its tool definitions are indexed for fast lookup.
   */
  registerHandler(handler: BaseToolHandler): void {
    this.handlers.push(handler);
    for (const def of handler.getToolDefinitions()) {
      this.handlerMap.set(def.name, handler);
      // Ensure route exists for local tools
      if (!this.routes.has(def.name)) {
        this.routes.set(def.name, {
          toolName: def.name,
          serviceName: def.name,
          service: 'backend',
          local: true,
        });
      }
    }
    logger.debug('Registered tool handler', {
      tools: handler.getToolDefinitions().map(t => t.name),
    });
  }

  /**
   * Execute a tool by name — local handler first, then remote proxy fallback.
   * Returns null if no handler or route is registered for the tool.
   */
  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    const refused = refuseUngatedJudgmentCall(name, args);
    if (refused) return refused;
    // 1. Try local handler
    const handler = this.handlerMap.get(name);
    if (handler) {
      const timeoutMs = TOOL_TIMEOUT_OVERRIDES[name] ?? DEFAULT_TOOL_TIMEOUT_MS;
      return await Promise.race([
        handler.executeTool(name, args),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Tool "${name}" перевищив ліміт часу ${timeoutMs / 1000}с`)), timeoutMs)
        ),
      ]);
    }

    // 2. Try remote proxy for RADA / OpenReyestr tools
    const route = this.routes.get(name);
    if (route && !route.local) {
      return await this.executeRemoteTool(route, args);
    }

    return null;
  }

  /**
   * Input schema for a tool: local handler definition, else the cached remote
   * (rada_* / openreyestr_*) definition. Undefined when unknown.
   */
  async getToolInputSchema(name: string): Promise<any | undefined> {
    const handler = this.handlerMap.get(name);
    if (handler) {
      return handler.getToolDefinitions().find(d => d.name === name)?.inputSchema;
    }
    const route = this.routes.get(name);
    if (!route || route.local || route.service === 'backend') return undefined;
    // Only the service that owns the tool, bounded in time; fail open on timeout/failure.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), REMOTE_SCHEMA_WAIT_MS);
    });
    try {
      const defs = await Promise.race([this.loadRemoteDefinitions(route.service), timeout]);
      if (!defs) {
        // Logged once per failed fetch in loadRemoteDefinitions; per call only at debug.
        logger.debug('[ToolRegistry] Remote schema unavailable, argument check skipped', { tool: name, service: route.service });
        return undefined;
      }
      return defs.find(d => d.name === name)?.inputSchema;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Reject arguments that are not in the tool's inputSchema (LEXAI-2164). Returns an
   * error ToolResult to send to the client, or null when the call may proceed. Used by
   * the external transports; tools without a known/closed schema always pass.
   */
  async validateToolArgs(name: string, args: unknown, transport: string): Promise<ToolResult | null> {
    const schema = await this.getToolInputSchema(name);
    if (!schema) return null;
    return checkToolArgs(name, schema, args, transport);
  }

  /**
   * Execute a tool on a remote service via HTTP proxy.
   */
  private async executeRemoteTool(route: ToolRoute, args: any): Promise<any> {
    logger.info('[ToolRegistry] Proxying to remote service', {
      tool: route.toolName,
      service: route.service,
      serviceName: route.serviceName,
    });

    const responseData = await this.remoteClient.callRemoteTool({
      service: route.service,
      toolName: route.serviceName,
      args,
    });

    logger.info('[ToolRegistry] Remote call successful', {
      tool: route.toolName,
      service: route.service,
    });

    return this.transformRemoteResult(route.toolName, responseData?.result || responseData);
  }

  /**
   * Execute a streaming tool by name. Returns null if not supported.
   */
  async executeToolStream(name: string, args: any, callback: StreamEventCallback): Promise<ToolResult | null> {
    const refused = refuseUngatedJudgmentCall(name, args);
    if (refused) return refused;
    const handler = this.handlerMap.get(name);
    if (!handler || !handler.executeToolStream) return null;
    return await handler.executeToolStream(name, args, callback);
  }

  /**
   * Check if a handler supports streaming for a given tool.
   */
  supportsStreaming(name: string): boolean {
    const handler = this.handlerMap.get(name);
    return !!handler && typeof handler.executeToolStream === 'function';
  }

  /**
   * Get the handler for a given tool name.
   */
  getHandler(name: string): BaseToolHandler | undefined {
    return this.handlerMap.get(name);
  }

  /**
   * Get all local tool definitions from registered handlers.
   */
  getLocalToolDefinitions(): ToolDefinition[] {
    const seen = new Set<string>();
    const defs: ToolDefinition[] = [];
    for (const handler of this.handlers) {
      for (const def of handler.getToolDefinitions()) {
        if (!seen.has(def.name)) {
          seen.add(def.name);
          defs.push(def);
        }
      }
    }
    return defs;
  }

  /**
   * Get all tool definitions: local + remote (fetched in parallel and cached per service).
   * A service whose definitions are unavailable is simply absent from the list.
   */
  async getAllToolDefinitions(): Promise<ToolDefinition[]> {
    const local = this.getLocalToolDefinitions();
    const remote = await Promise.all(REMOTE_SERVICES.map(r => this.loadRemoteDefinitions(r.service)));
    return [...local, ...remote.flatMap(defs => defs ?? [])];
  }

  /**
   * Start fetching remote definitions in the background (called at startup) so the first
   * tool call does not pay for the fetch. Never throws.
   */
  prewarmRemoteToolDefinitions(): void {
    for (const r of REMOTE_SERVICES) {
      this.loadRemoteDefinitions(r.service).catch(() => undefined);
    }
  }

  /**
   * Definitions of one remote service: the cached ones, the shared in-flight fetch, or a
   * new fetch. Resolves to null when the service is not configured, the fetch failed, or a
   * recent failure is still inside its retry backoff. Never rejects.
   */
  private loadRemoteDefinitions(service: RemoteService): Promise<ToolDefinition[] | null> {
    const cached = this.remoteDefsCache.get(service);
    if (cached) return Promise.resolve(cached);
    const inFlight = this.remoteDefsInFlight.get(service);
    if (inFlight) return inFlight;
    const failedAt = this.remoteDefsFailedAt.get(service);
    if (failedAt !== undefined && Date.now() - failedAt < REMOTE_DEFS_RETRY_MS) {
      return Promise.resolve(null);
    }

    const promise = this.fetchRemoteServiceDefinitions(service)
      .catch((err: any) => {
        logger.warn('[ToolRegistry] Remote tool definitions fetch failed', { service, error: err?.message });
        return null;
      })
      .then(defs => {
        if (defs && defs.length > 0) {
          this.remoteDefsCache.set(service, defs);
          this.remoteDefsFailedAt.delete(service);
        } else {
          // Failed, empty (RemoteServiceClient returns [] on error) or not configured:
          // don't cache, retry after the backoff. Warn once per failed fetch (calls in the
          // backoff window log at debug only); an unconfigured service is not a failure.
          this.remoteDefsFailedAt.set(service, Date.now());
          const log = defs === null ? logger.debug.bind(logger) : logger.warn.bind(logger);
          log('[ToolRegistry] Remote tool definitions unavailable; argument check and tools/list skip this service until retry', {
            service,
            retryInMs: REMOTE_DEFS_RETRY_MS,
          });
        }
        return defs && defs.length > 0 ? defs : null;
      })
      .finally(() => {
        this.remoteDefsInFlight.delete(service);
      });
    this.remoteDefsInFlight.set(service, promise);
    return promise;
  }

  /** Fetch one remote service's definitions, prefixed. Null when the service is not configured. */
  private async fetchRemoteServiceDefinitions(service: RemoteService): Promise<ToolDefinition[] | null> {
    const meta = REMOTE_SERVICES.find(r => r.service === service)!;
    const config = this.remoteClient.getServiceConfig(service);
    if (!config.baseUrl || !config.apiKey) return null;
    const tools = await this.remoteClient.fetchRemoteToolDefinitions(config.baseUrl, config.apiKey);
    logger.info(`[ToolRegistry] Fetched ${meta.label} tool definitions`, { count: tools.length });
    return tools.map(tool => ({
      name: `${meta.prefix}${tool.name}`,
      description: `[${meta.label}] ${tool.description}`,
      inputSchema: tool.inputSchema,
    }));
  }


  // ========================= Route Management =========================

  private initializeRoutes(): void {
    // Backend tool routes are created dynamically by registerHandler().
    // Only remote (proxy) tools need hardcoded routes.

    // ========== RADA Tools (5 tools) - Prefix 'rada_', HTTP proxy ==========
    const radaTools = [
      { clientName: 'rada_search_parliament_bills', serviceName: 'search_parliament_bills' },
      { clientName: 'rada_search_bill_documents', serviceName: 'search_bill_documents' },
      { clientName: 'rada_get_deputy_info', serviceName: 'get_deputy_info' },
      { clientName: 'rada_search_legislation_text', serviceName: 'search_legislation_text' },
      { clientName: 'rada_analyze_voting_record', serviceName: 'analyze_voting_record' },
    ];

    for (const tool of radaTools) {
      this.routes.set(tool.clientName, {
        toolName: tool.clientName,
        serviceName: tool.serviceName,
        service: 'rada',
        local: false,
      });
    }

    // ========== OpenReyestr Tools - Prefix 'openreyestr_', HTTP proxy ==========
    // Excluded duplicates already served locally:
    //   search_legal_acts → local: search_edrnpa (opendata-tools.ts)
    //   search_court_experts → local: search_court_experts_registry (opendata-registries-tools.ts)
    //   search_vat_payers → local: search_vat_payers_registry (opendata-registries-tools.ts)
    const openreyestrTools = [
      { clientName: 'openreyestr_search_entities', serviceName: 'search_entities' },
      { clientName: 'openreyestr_get_entity_details', serviceName: 'get_entity_details' },
      { clientName: 'openreyestr_search_beneficiaries', serviceName: 'search_beneficiaries' },
      { clientName: 'openreyestr_get_by_edrpou', serviceName: 'get_by_edrpou' },
      { clientName: 'openreyestr_get_statistics', serviceName: 'get_statistics' },
      { clientName: 'openreyestr_search_notaries', serviceName: 'search_notaries' },
      { clientName: 'openreyestr_search_arbitration_managers', serviceName: 'search_arbitration_managers' },
      { clientName: 'openreyestr_search_debtors', serviceName: 'search_debtors' },
      { clientName: 'openreyestr_search_enforcement_proceedings', serviceName: 'search_enforcement_proceedings' },
      { clientName: 'openreyestr_search_bankruptcy_cases', serviceName: 'search_bankruptcy_cases' },
      { clientName: 'openreyestr_search_special_forms', serviceName: 'search_special_forms' },
      { clientName: 'openreyestr_search_forensic_methods', serviceName: 'search_forensic_methods' },
      { clientName: 'openreyestr_search_administrative_units', serviceName: 'search_administrative_units' },
      { clientName: 'openreyestr_search_streets', serviceName: 'search_streets' },
      { clientName: 'openreyestr_search_street_renamings', serviceName: 'search_street_renamings' },
      { clientName: 'openreyestr_search_single_tax_payers', serviceName: 'search_single_tax_payers' },
      { clientName: 'openreyestr_search_tax_debt', serviceName: 'search_tax_debt' },
      { clientName: 'openreyestr_search_esv_debt', serviceName: 'search_esv_debt' },
      { clientName: 'openreyestr_search_prozorro', serviceName: 'search_prozorro' },
      { clientName: 'openreyestr_get_data_freshness', serviceName: 'get_data_freshness' },
      { clientName: 'openreyestr_search_termination_started', serviceName: 'search_termination_started' },
      { clientName: 'openreyestr_search_rnbo_sanctions', serviceName: 'search_rnbo_sanctions' },
      { clientName: 'openreyestr_search_arma_seized_assets', serviceName: 'search_arma_seized_assets' },
      { clientName: 'openreyestr_search_nazk_declarations', serviceName: 'search_nazk_declarations' },
      { clientName: 'openreyestr_search_exchange_data', serviceName: 'search_exchange_data' },
      { clientName: 'openreyestr_search_me_datasets', serviceName: 'search_me_datasets' },
      { clientName: 'openreyestr_search_me_records', serviceName: 'search_me_records' },
    ];

    for (const tool of openreyestrTools) {
      this.routes.set(tool.clientName, {
        toolName: tool.clientName,
        serviceName: tool.serviceName,
        service: 'openreyestr',
        local: false,
      });
    }

    logger.info('Tool Registry remote routes initialized', {
      rada: radaTools.length,
      openreyestr: openreyestrTools.length,
    });
  }

  /**
   * Get routing information for a tool
   */
  getRoute(toolName: string): ToolRoute | undefined {
    return this.routes.get(toolName);
  }

  /**
   * Get all registered tools (fetches from remote services if enabled)
   */
  async getAllTools(
    backendTools: ToolDefinition[],
    radaBaseUrl?: string,
    radaApiKey?: string,
    openreyestrBaseUrl?: string,
    openreyestrApiKey?: string
  ): Promise<ToolDefinition[]> {
    const allTools: ToolDefinition[] = [...backendTools];

    // Fetch RADA tools if configured
    if (radaBaseUrl && radaApiKey) {
      const radaTools = await this.remoteClient.fetchRemoteToolDefinitions(radaBaseUrl, radaApiKey);
      logger.debug('Fetched RADA tools', { count: radaTools.length });

      for (const tool of radaTools) {
        allTools.push({
          name: `rada_${tool.name}`,
          description: `[RADA] ${tool.description}`,
          inputSchema: tool.inputSchema,
        });
      }
    }

    // Fetch OpenReyestr tools if configured
    if (openreyestrBaseUrl && openreyestrApiKey) {
      const openreyestrTools = await this.remoteClient.fetchRemoteToolDefinitions(openreyestrBaseUrl, openreyestrApiKey);
      logger.debug('Fetched OpenReyestr tools', { count: openreyestrTools.length });

      for (const tool of openreyestrTools) {
        allTools.push({
          name: `openreyestr_${tool.name}`,
          description: `[OpenReyestr] ${tool.description}`,
          inputSchema: tool.inputSchema,
        });
      }
    }

    return allTools;
  }

  /**
   * Get all tool names by service
   */
  getToolsByService(service: ServiceType): string[] {
    const tools: string[] = [];
    for (const [toolName, route] of this.routes.entries()) {
      if (route.service === service) {
        tools.push(toolName);
      }
    }
    return tools;
  }

  /**
   * Get count of tools per service
   */
  getToolCounts(): { backend: number; rada: number; openreyestr: number; total: number } {
    const counts = { backend: 0, rada: 0, openreyestr: 0 };
    for (const route of this.routes.values()) {
      counts[route.service]++;
    }
    return {
      ...counts,
      total: this.routes.size,
    };
  }
}
