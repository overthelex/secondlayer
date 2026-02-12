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
import axios, { AxiosInstance } from 'axios';
import { BaseToolHandler, ToolResult, ToolDefinition as BaseToolDefinition, StreamEventCallback } from './base-tool-handler.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: any;
}

export class ToolRegistry {
  private routes: Map<string, ToolRoute>;
  private axiosClient: AxiosInstance;
  private handlers: BaseToolHandler[] = [];
  private handlerMap: Map<string, BaseToolHandler> = new Map();

  constructor() {
    this.routes = new Map();
    this.axiosClient = axios.create({
      timeout: 60000,
    });
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
   * Execute a local tool by name via the registered handler.
   * Returns null if no handler is registered for the tool.
   */
  async executeTool(name: string, args: any): Promise<ToolResult | null> {
    const handler = this.handlerMap.get(name);
    if (!handler) return null;
    return await handler.executeTool(name, args);
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

  // ========================= Route Management =========================

  private initializeRoutes(): void {
    // ========== Backend Tools - No prefix, local execution ==========
    const backendTools = [
      'classify_intent',
      'retrieve_legal_sources',
      'search_legal_precedents',
      'get_court_decision',
      'get_case_text',
      'get_case_documents_chain',
      'check_precedent_status',
      'count_cases_by_party',
      'load_full_texts',
      'bulk_ingest_court_decisions',
      'analyze_legal_patterns',
      'analyze_case_pattern',
      'get_similar_reasoning',
      'extract_document_sections',
      'compare_practice_pro_contra',
      'get_citation_graph',
      'search_procedural_norms',
      'search_supreme_court_practice',
      'find_similar_fact_pattern_cases',
      'find_relevant_law_articles',
      'calculate_procedural_deadlines',
      'build_procedural_checklist',
      'calculate_monetary_claims',
      'validate_response',
      'format_answer_pack',
      'get_legal_advice',
      'search_business_entities',
      'get_business_entity_details',
      'search_entity_beneficiaries',
      'lookup_by_edrpou',
      'search_legislation',
      'get_legislation_article',
      'get_legislation_section',
      'get_legislation_articles',
      'get_legislation_structure',
      'parse_document',
      'extract_key_clauses',
      'summarize_document',
      'compare_documents',
      'batch_process_documents',
      'store_document',
      'get_document',
      'list_documents',
      'semantic_search',
      'bulk_review_runner',
      'risk_scoring',
      'generate_dd_report',
    ];

    for (const tool of backendTools) {
      this.routes.set(tool, {
        toolName: tool,
        serviceName: tool,
        service: 'backend',
        local: true,
      });
    }

    // ========== RADA Tools (4 tools) - Prefix 'rada_', HTTP proxy ==========
    const radaTools = [
      { clientName: 'rada_search_parliament_bills', serviceName: 'search_parliament_bills' },
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

    // ========== OpenReyestr Tools (5 tools) - Prefix 'openreyestr_', HTTP proxy ==========
    const openreyestrTools = [
      { clientName: 'openreyestr_search_entities', serviceName: 'search_entities' },
      { clientName: 'openreyestr_get_entity_details', serviceName: 'get_entity_details' },
      { clientName: 'openreyestr_search_beneficiaries', serviceName: 'search_beneficiaries' },
      { clientName: 'openreyestr_get_by_edrpou', serviceName: 'get_by_edrpou' },
      { clientName: 'openreyestr_get_statistics', serviceName: 'get_statistics' },
    ];

    for (const tool of openreyestrTools) {
      this.routes.set(tool.clientName, {
        toolName: tool.clientName,
        serviceName: tool.serviceName,
        service: 'openreyestr',
        local: false,
      });
    }

    logger.info('Tool Registry initialized', {
      totalTools: this.routes.size,
      backend: backendTools.length,
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
      try {
        const response = await this.axiosClient.get(`${radaBaseUrl}/api/tools`, {
          headers: {
            Authorization: `Bearer ${radaApiKey}`,
          },
          timeout: 5000,
        });

        const radaTools = response.data.tools || [];
        logger.debug('Fetched RADA tools', { count: radaTools.length });

        // Prefix RADA tools with 'rada_'
        for (const tool of radaTools) {
          allTools.push({
            name: `rada_${tool.name}`,
            description: `[RADA] ${tool.description}`,
            inputSchema: tool.inputSchema,
          });
        }
      } catch (error: any) {
        logger.warn('Failed to fetch RADA tools', {
          error: error.message,
          baseUrl: radaBaseUrl,
        });
      }
    }

    // Fetch OpenReyestr tools if configured
    if (openreyestrBaseUrl && openreyestrApiKey) {
      try {
        const response = await this.axiosClient.get(`${openreyestrBaseUrl}/api/tools`, {
          headers: {
            Authorization: `Bearer ${openreyestrApiKey}`,
          },
          timeout: 5000,
        });

        const openreyestrTools = response.data.tools || [];
        logger.debug('Fetched OpenReyestr tools', { count: openreyestrTools.length });

        // Prefix OpenReyestr tools with 'openreyestr_'
        for (const tool of openreyestrTools) {
          allTools.push({
            name: `openreyestr_${tool.name}`,
            description: `[OpenReyestr] ${tool.description}`,
            inputSchema: tool.inputSchema,
          });
        }
      } catch (error: any) {
        logger.warn('Failed to fetch OpenReyestr tools', {
          error: error.message,
          baseUrl: openreyestrBaseUrl,
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
