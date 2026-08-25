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

export class ToolRegistry {
  private routes: Map<string, ToolRoute>;
  private handlers: BaseToolHandler[] = [];
  private handlerMap: Map<string, BaseToolHandler> = new Map();
  private remoteToolDefs: ToolDefinition[] = [];
  private remoteToolDefsLoaded = false;
  private remoteClient: RemoteServiceClient;

  constructor(remoteClient?: RemoteServiceClient) {
    this.routes = new Map();
    this.remoteClient = remoteClient || new RemoteServiceClient();
    this.initializeRoutes();
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

    return responseData?.result || responseData;
  }

  /**
   * Execute a streaming tool by name. Returns null if not supported.
   */
  async executeToolStream(name: string, args: any, callback: StreamEventCallback): Promise<ToolResult | null> {
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
   * Get all tool definitions: local + remote (fetched and cached).
   * Remote tool defs are fetched once on first call, then cached.
   */
  async getAllToolDefinitions(): Promise<ToolDefinition[]> {
    const local = this.getLocalToolDefinitions();

    if (!this.remoteToolDefsLoaded) {
      await this.fetchRemoteToolDefinitions();
    }

    return [...local, ...this.remoteToolDefs];
  }

  /**
   * Fetch tool definitions from remote services (RADA, OpenReyestr) and cache them.
   */
  private async fetchRemoteToolDefinitions(): Promise<void> {
    this.remoteToolDefsLoaded = true;
    const defs: ToolDefinition[] = [];

    // Fetch RADA tools
    const radaConfig = this.remoteClient.getServiceConfig('rada');
    if (radaConfig.baseUrl && radaConfig.apiKey) {
      const tools = await this.remoteClient.fetchRemoteToolDefinitions(radaConfig.baseUrl, radaConfig.apiKey);
      for (const tool of tools) {
        defs.push({
          name: `rada_${tool.name}`,
          description: `[RADA] ${tool.description}`,
          inputSchema: tool.inputSchema,
        });
      }
      logger.info('[ToolRegistry] Fetched RADA tool definitions', { count: tools.length });
    }

    // Fetch OpenReyestr tools
    const orConfig = this.remoteClient.getServiceConfig('openreyestr');
    if (orConfig.baseUrl && orConfig.apiKey) {
      const tools = await this.remoteClient.fetchRemoteToolDefinitions(orConfig.baseUrl, orConfig.apiKey);
      for (const tool of tools) {
        defs.push({
          name: `openreyestr_${tool.name}`,
          description: `[OpenReyestr] ${tool.description}`,
          inputSchema: tool.inputSchema,
        });
      }
      logger.info('[ToolRegistry] Fetched OpenReyestr tool definitions', { count: tools.length });
    }

    this.remoteToolDefs = defs;
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
