import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { logger } from '../utils/logger';

/**
 * Simplified Prometheus metrics service for mcp_openreyestr.
 * Collects default Node.js metrics, HTTP request metrics, and PG pool stats.
 */
export class MetricsService {
  private registry: Registry;

  readonly httpRequestDuration: Histogram;
  readonly httpRequestsTotal: Counter;
  readonly pgPoolConnections: Gauge;

  constructor() {
    this.registry = new Registry();

    collectDefaultMetrics({ register: this.registry, prefix: 'nodejs_' });

    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds',
      labelNames: ['method', 'route', 'status_code'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.httpRequestsTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status_code'] as const,
      registers: [this.registry],
    });

    this.pgPoolConnections = new Gauge({
      name: 'pg_pool_connections',
      help: 'PostgreSQL connection pool status',
      labelNames: ['state'] as const,
      registers: [this.registry],
    });

    logger.info('[Metrics] MetricsService initialized');
  }

  normalizeRoute(path: string): string {
    return path
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':uuid')
      .replace(/\/api\/tools\/([^/]+)/, '/api/tools/:toolName')
      .replace(/\/\d+$/, '/:id');
  }

  updatePgPool(stats: { total: number; idle: number; waiting: number }): void {
    this.pgPoolConnections.set({ state: 'active' }, stats.total - stats.idle);
    this.pgPoolConnections.set({ state: 'idle' }, stats.idle);
    this.pgPoolConnections.set({ state: 'waiting' }, stats.waiting);
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }
}
