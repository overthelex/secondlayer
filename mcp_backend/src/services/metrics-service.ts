import client, { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { logger } from '../utils/logger.js';

/**
 * Prometheus metrics service for mcp_backend.
 * Collects default Node.js metrics, HTTP request metrics, PG pool stats,
 * BullMQ upload queue metrics, external API call metrics, and cost tracking.
 */
export class MetricsService {
  private registry: Registry;

  // HTTP metrics
  readonly httpRequestDuration: Histogram;
  readonly httpRequestsTotal: Counter;

  // PG pool metrics
  readonly pgPoolConnections: Gauge;

  // Upload / BullMQ metrics
  readonly bullmqJobs: Gauge;
  readonly uploadQueueDepth: Gauge;
  readonly uploadProcessingActive: Gauge;
  readonly uploadProcessingDuration: Histogram;

  // External API metrics
  readonly externalApiCallsTotal: Counter;
  readonly externalApiDuration: Histogram;

  // CPU adaptive concurrency metrics
  readonly cpuAdaptiveConcurrency: Gauge;
  readonly cpuLoadAverage: Gauge;
  readonly cpuCoresAvailable: Gauge;

  // Cost metrics
  readonly costTrackingTotalUsd: Counter;

  constructor() {
    this.registry = new Registry();

    // Default Node.js metrics (CPU, memory, GC, event loop lag)
    collectDefaultMetrics({ register: this.registry, prefix: 'nodejs_' });

    // --- HTTP ---
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

    // --- PG Pool ---
    this.pgPoolConnections = new Gauge({
      name: 'pg_pool_connections',
      help: 'PostgreSQL connection pool status',
      labelNames: ['state'] as const,
      registers: [this.registry],
    });

    // --- BullMQ / Upload ---
    this.bullmqJobs = new Gauge({
      name: 'bullmq_jobs',
      help: 'BullMQ job counts by status',
      labelNames: ['status'] as const,
      registers: [this.registry],
    });

    this.uploadQueueDepth = new Gauge({
      name: 'upload_queue_depth',
      help: 'Current upload queue depth (waiting + active)',
      registers: [this.registry],
    });

    this.uploadProcessingActive = new Gauge({
      name: 'upload_processing_active',
      help: 'Number of actively processing uploads',
      registers: [this.registry],
    });

    this.uploadProcessingDuration = new Histogram({
      name: 'upload_processing_duration_seconds',
      help: 'Upload file processing duration in seconds',
      labelNames: ['status'] as const,
      buckets: [1, 5, 10, 30, 60, 120, 300],
      registers: [this.registry],
    });

    // --- External API ---
    this.externalApiCallsTotal = new Counter({
      name: 'external_api_calls_total',
      help: 'Total external API calls',
      labelNames: ['service', 'status'] as const,
      registers: [this.registry],
    });

    this.externalApiDuration = new Histogram({
      name: 'external_api_duration_seconds',
      help: 'External API call duration in seconds',
      labelNames: ['service'] as const,
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    // --- CPU Adaptive Concurrency ---
    this.cpuAdaptiveConcurrency = new Gauge({
      name: 'cpu_adaptive_concurrency',
      help: 'Current BullMQ worker concurrency setting',
      registers: [this.registry],
    });

    this.cpuLoadAverage = new Gauge({
      name: 'cpu_load_average',
      help: '1-minute CPU load average',
      registers: [this.registry],
    });

    this.cpuCoresAvailable = new Gauge({
      name: 'cpu_cores_available',
      help: 'Total CPU cores available',
      registers: [this.registry],
    });

    // --- Cost ---
    this.costTrackingTotalUsd = new Counter({
      name: 'cost_tracking_total_usd',
      help: 'Total cost tracked in USD',
      labelNames: ['tool_name'] as const,
      registers: [this.registry],
    });

    // Pre-initialize external API counters so Prometheus always has these series
    // (counters don't appear until first .inc() otherwise)
    for (const svc of ['openai', 'anthropic', 'zakononline', 'rada']) {
      this.externalApiCallsTotal.inc({ service: svc, status: 'success' }, 0);
    }

    logger.info('[Metrics] MetricsService initialized');
  }

  /**
   * Normalize route for Prometheus labels to prevent high cardinality.
   * /api/tools/search_court_decisions → /api/tools/:toolName
   * /api/upload/abc-123/chunk → /api/upload/:uploadId/chunk
   * UUIDs → :uuid
   */
  normalizeRoute(path: string): string {
    return path
      // UUID pattern
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':uuid')
      // Tool name after /api/tools/
      .replace(/\/api\/tools\/([^/]+)/, '/api/tools/:toolName')
      // Upload ID after /api/upload/
      .replace(/\/api\/upload\/([^/]+)/, '/api/upload/:uploadId')
      // Matter/client IDs
      .replace(/\/api\/matters\/([^/]+)/, '/api/matters/:id')
      // Admin user IDs
      .replace(/\/api\/admin\/users\/([^/]+)/, '/api/admin/users/:userId')
      // Conversation IDs
      .replace(/\/api\/conversations\/([^/]+)/, '/api/conversations/:id')
      // Template IDs
      .replace(/\/api\/templates\/([^/]+)/, '/api/templates/:id')
      // Invoice numbers
      .replace(/\/api\/billing\/invoices\/([^/]+)/, '/api/billing/invoices/:invoiceNumber')
      // Generic numeric IDs at end of path
      .replace(/\/\d+$/, '/:id');
  }

  /**
   * Update PG pool gauges from pool stats callback.
   */
  updatePgPool(stats: { total: number; idle: number; waiting: number }): void {
    this.pgPoolConnections.set({ state: 'active' }, stats.total - stats.idle);
    this.pgPoolConnections.set({ state: 'idle' }, stats.idle);
    this.pgPoolConnections.set({ state: 'waiting' }, stats.waiting);
  }

  /**
   * Update BullMQ job gauges from queue metrics.
   */
  updateUploadQueue(metrics: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }): void {
    this.bullmqJobs.set({ status: 'waiting' }, metrics.waiting);
    this.bullmqJobs.set({ status: 'active' }, metrics.active);
    this.bullmqJobs.set({ status: 'completed' }, metrics.completed);
    this.bullmqJobs.set({ status: 'failed' }, metrics.failed);
    this.bullmqJobs.set({ status: 'delayed' }, metrics.delayed);
    this.uploadQueueDepth.set(metrics.waiting + metrics.active);
    this.uploadProcessingActive.set(metrics.active);
  }

  /**
   * Update CPU adaptive concurrency gauges.
   */
  updateCpuAdaptive(metrics: { concurrency: number; loadAverage: number; cpuCores: number }): void {
    this.cpuAdaptiveConcurrency.set(metrics.concurrency);
    this.cpuLoadAverage.set(metrics.loadAverage);
    this.cpuCoresAvailable.set(metrics.cpuCores);
  }

  /**
   * Returns Prometheus text format metrics string.
   */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Returns the content type for Prometheus metrics.
   */
  getContentType(): string {
    return this.registry.contentType;
  }
}
