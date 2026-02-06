/**
 * Gateway types for unified MCP tool routing
 */

export type ServiceType = 'backend' | 'rada' | 'openreyestr';

export interface ToolRoute {
  /** Client-facing tool name (e.g., 'rada_search_parliament_bills') */
  toolName: string;

  /** Service-specific tool name (without prefix, e.g., 'search_parliament_bills') */
  serviceName: string;

  /** Which service handles this tool */
  service: ServiceType;

  /** Execute locally in mcp_backend or proxy to remote service */
  local: boolean;
}

export interface ServiceConfig {
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

export interface RemoteToolCall {
  service: ServiceType;
  toolName: string;
  serviceName: string;
  args: any;
  requestId: string;
}

export interface GatewayConfig {
  enableUnifiedGateway: boolean;
  rada: ServiceConfig;
  openreyestr: ServiceConfig;
}
