/**
 * Prometheus Query Service
 * HTTP client for querying Prometheus /api/v1/query and /api/v1/query_range
 */

import { logger } from '../utils/logger.js';

export interface PrometheusInstantResult {
  metric: Record<string, string>;
  value: [number, string]; // [timestamp, value]
}

export interface PrometheusRangeResult {
  metric: Record<string, string>;
  values: [number, string][]; // [[timestamp, value], ...]
}

export class PrometheusService {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.PROMETHEUS_URL || 'http://prometheus-local:9090';
  }

  /**
   * Execute an instant query (single point in time)
   */
  async queryInstant(promql: string): Promise<PrometheusInstantResult[]> {
    try {
      const url = `${this.baseUrl}/api/v1/query`;
      const params = new URLSearchParams({ query: promql });
      const response = await fetch(`${url}?${params}`, {
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(`Prometheus HTTP ${response.status}: ${response.statusText}`);
      }

      const body = await response.json() as { status: string; error?: string; data?: { result: PrometheusInstantResult[] } };
      if (body.status !== 'success') {
        throw new Error(`Prometheus query error: ${body.error || 'unknown'}`);
      }

      return body.data?.result || [];
    } catch (error: any) {
      logger.warn('Prometheus instant query failed', { promql, error: error.message });
      return [];
    }
  }

  /**
   * Execute a range query (time series)
   */
  async queryRange(
    promql: string,
    start: number,
    end: number,
    step: string
  ): Promise<PrometheusRangeResult[]> {
    try {
      const url = `${this.baseUrl}/api/v1/query_range`;
      const params = new URLSearchParams({
        query: promql,
        start: start.toString(),
        end: end.toString(),
        step,
      });
      const response = await fetch(`${url}?${params}`, {
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        throw new Error(`Prometheus HTTP ${response.status}: ${response.statusText}`);
      }

      const body = await response.json() as { status: string; error?: string; data?: { result: PrometheusRangeResult[] } };
      if (body.status !== 'success') {
        throw new Error(`Prometheus range query error: ${body.error || 'unknown'}`);
      }

      return body.data?.result || [];
    } catch (error: any) {
      logger.warn('Prometheus range query failed', { promql, error: error.message });
      return [];
    }
  }

  /**
   * Check if Prometheus is reachable
   */
  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/-/healthy`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
