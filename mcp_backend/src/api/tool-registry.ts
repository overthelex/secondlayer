/**
 * Tool Registry - Central mapping of all 44 MCP tools to their respective services
 */

import { ToolRoute, ServiceType } from '../types/gateway.js';
import { logger } from '../utils/logger.js';
import axios, { AxiosInstance } from 'axios';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: any;
}

export class ToolRegistry {
  private routes: Map<string, ToolRoute>;
  private axiosClient: AxiosInstance;

  constructor() {
    this.routes = new Map();
    this.axiosClient = axios.create({
      timeout: 60000,
    });
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    // ========== Backend Tools (36 tools) - No prefix, local execution ==========
    const backendTools = [
      'classify_intent',
      'search_legal_precedents',
      'get_court_decision',
      'get_document_text',
      'semantic_search',
      'find_legal_patterns',
      'validate_citations',
      'packaged_lawyer_answer',
      'get_legal_advice',
      'search_by_category',
      'search_by_court',
      'search_by_judge',
      'search_by_date_range',
      'get_case_metadata',
      'get_related_cases',
      'analyze_judicial_reasoning',
      'extract_legal_principles',
      'compare_decisions',
      'track_precedent_evolution',
      'get_citation_network',
      'search_court_practice',
      'get_practice_document',
      'analyze_practice_patterns',
      'get_case_documents_chain',
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
      'get_judge_statistics',
      'analyze_court_trends',
      'store_document',
      'get_document',
      'list_documents',
      'semantic_search',
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
        // Continue without RADA tools
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
        // Continue without OpenReyestr tools
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
