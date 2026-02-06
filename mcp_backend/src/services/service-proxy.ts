/**
 * Service Proxy - HTTP client for proxying requests to remote MCP services (RADA, OpenReyestr)
 */

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { logger } from '../utils/logger.js';
import { CostTracker } from './cost-tracker.js';
import { ServiceType } from '../types/gateway.js';

export interface ServiceProxyConfig {
  baseUrl: string;
  apiKey: string;
}

export class ServiceProxy {
  private axiosClient: AxiosInstance;

  constructor(private costTracker: CostTracker) {
    this.axiosClient = axios.create({
      timeout: 60000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Call a remote MCP service (RADA or OpenReyestr)
   */
  async callRemoteService(params: {
    service: ServiceType;
    serviceName: string; // Without prefix
    args: any;
    requestId: string;
    acceptHeader?: string; // For SSE support
  }): Promise<any> {
    const { service, serviceName, args, requestId, acceptHeader } = params;

    const config = this.getServiceConfig(service);

    if (!config.baseUrl || !config.apiKey) {
      throw new Error(`Service ${service} is not configured (missing URL or API key)`);
    }

    const url = `${config.baseUrl}/api/tools/${serviceName}`;

    logger.info('[ServiceProxy] Calling remote service', {
      service,
      tool: serviceName,
      url,
      requestId,
      streaming: acceptHeader?.includes('event-stream'),
    });

    try {
      // Make HTTP request to remote service
      const response: AxiosResponse = await this.axiosClient.post(
        url,
        { arguments: args },
        {
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            Accept: acceptHeader || 'application/json',
            'X-Parent-Request-ID': requestId,
          },
          responseType: acceptHeader?.includes('event-stream') ? 'stream' : 'json',
        }
      );

      // For streaming responses, return the raw stream
      if (acceptHeader?.includes('event-stream')) {
        return response.data;
      }

      // Extract cost tracking from response
      if (response.data?.cost_tracking?.actual_cost) {
        await this.recordRemoteServiceCost({
          requestId,
          service,
          toolName: serviceName,
          costData: response.data.cost_tracking.actual_cost,
        });
      }

      logger.info('[ServiceProxy] Remote call successful', {
        service,
        tool: serviceName,
        requestId,
        statusCode: response.status,
      });

      return response.data;
    } catch (error: any) {
      logger.error('[ServiceProxy] Remote call failed', {
        service,
        tool: serviceName,
        requestId,
        error: error.message,
        status: error.response?.status,
        data: error.response?.data,
      });

      // Re-throw with more context
      throw new Error(
        `Remote service call failed (${service}/${serviceName}): ${error.message}`
      );
    }
  }

  /**
   * Record cost from remote service call
   */
  private async recordRemoteServiceCost(params: {
    requestId: string;
    service: ServiceType;
    toolName: string;
    costData: any;
  }): Promise<void> {
    const { requestId, service, toolName, costData } = params;

    // Only record costs for remote services (not backend)
    if (service === 'backend') {
      return;
    }

    try {
      // Extract total cost from remote service's cost breakdown
      const totalCostUsd =
        costData.totals?.cost_usd ||
        costData.total_cost_usd ||
        0;

      if (totalCostUsd > 0) {
        await this.costTracker.recordRemoteServiceCall({
          requestId,
          service: service as 'rada' | 'openreyestr', // Safe cast since we checked above
          toolName,
          costUsd: totalCostUsd,
          details: costData,
        });

        logger.debug('[ServiceProxy] Remote service cost recorded', {
          requestId,
          service,
          tool: toolName,
          costUsd: totalCostUsd.toFixed(6),
        });
      }
    } catch (error: any) {
      logger.error('[ServiceProxy] Failed to record remote service cost', {
        requestId,
        service,
        toolName,
        error: error.message,
      });
      // Don't throw - cost tracking failure should not break the request
    }
  }

  /**
   * Get service configuration from environment variables
   */
  private getServiceConfig(service: ServiceType): ServiceProxyConfig {
    const configs: Record<ServiceType, ServiceProxyConfig> = {
      backend: {
        baseUrl: '',
        apiKey: '',
      },
      rada: {
        baseUrl: process.env.RADA_MCP_URL || 'http://rada-mcp-app-stage:3001',
        apiKey: process.env.RADA_API_KEY || '',
      },
      openreyestr: {
        baseUrl: process.env.OPENREYESTR_MCP_URL || 'http://app-openreyestr-stage:3005',
        apiKey: process.env.OPENREYESTR_API_KEY || '',
      },
    };

    return configs[service];
  }

  /**
   * Check if a service is configured and available
   */
  isServiceAvailable(service: ServiceType): boolean {
    if (service === 'backend') {
      return true; // Backend is always available
    }

    const config = this.getServiceConfig(service);
    return !!(config.baseUrl && config.apiKey);
  }

  /**
   * Get list of available services
   */
  getAvailableServices(): ServiceType[] {
    const services: ServiceType[] = ['backend'];

    if (this.isServiceAvailable('rada')) {
      services.push('rada');
    }

    if (this.isServiceAvailable('openreyestr')) {
      services.push('openreyestr');
    }

    return services;
  }
}
