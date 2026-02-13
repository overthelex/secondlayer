import os from 'os';
import { logger } from '../utils/logger.js';

export interface CpuAdaptiveMetrics {
  concurrency: number;
  loadAverage: number;
  cpuCores: number;
}

export type ConcurrencyChangeCallback = (newConcurrency: number) => void;
export type MetricsCallback = (metrics: CpuAdaptiveMetrics) => void;

const POLL_INTERVAL_MS = 5000; // 5 seconds
const SMOOTHING_THRESHOLD = 2;  // Only adjust if diff >= 2

/**
 * Dynamically adjusts BullMQ worker concurrency based on real-time CPU load.
 *
 * Algorithm:
 *   freeCpuRatio = max(0, 1 - loadAvg / cpuCount)
 *   optimal = clamp(floor(freeCpuRatio * cpuCount * workersPerCore), min, max)
 *
 * Embedding and Qdrant ops are I/O-bound, so WORKERS_PER_CORE > 1 is safe.
 */
export class CpuAdaptiveManager {
  private interval: ReturnType<typeof setInterval> | null = null;
  private currentConcurrency: number;
  private onConcurrencyChange: ConcurrencyChangeCallback;
  private metricsCallback: MetricsCallback | null = null;

  private readonly minConcurrency: number;
  private readonly maxConcurrency: number;
  private readonly workersPerCore: number;
  private readonly cpuCount: number;

  constructor(
    initialConcurrency: number,
    onConcurrencyChange: ConcurrencyChangeCallback
  ) {
    this.onConcurrencyChange = onConcurrencyChange;
    this.cpuCount = os.cpus().length;

    this.workersPerCore = parseInt(process.env.WORKERS_PER_CORE || '4', 10);
    this.minConcurrency = parseInt(process.env.MIN_CONCURRENT_PROCESSING || '2', 10);
    this.maxConcurrency = parseInt(process.env.MAX_CONCURRENT_PROCESSING || '50', 10);
    this.currentConcurrency = initialConcurrency;

    logger.info('[CpuAdaptive] Initialized', {
      cpuCores: this.cpuCount,
      workersPerCore: this.workersPerCore,
      minConcurrency: this.minConcurrency,
      maxConcurrency: this.maxConcurrency,
      initialConcurrency,
    });
  }

  /**
   * Start polling CPU load and adjusting concurrency.
   */
  start(): void {
    if (this.interval) return;

    this.interval = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    // Run once immediately
    this.tick();

    logger.info('[CpuAdaptive] Started polling', { intervalMs: POLL_INTERVAL_MS });
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('[CpuAdaptive] Stopped polling');
    }
  }

  /**
   * Register a callback to receive CPU adaptive metrics (for Prometheus).
   */
  setMetricsCallback(callback: MetricsCallback): void {
    this.metricsCallback = callback;
  }

  /**
   * Get current state for diagnostics.
   */
  getState(): CpuAdaptiveMetrics {
    return {
      concurrency: this.currentConcurrency,
      loadAverage: os.loadavg()[0],
      cpuCores: this.cpuCount,
    };
  }

  private tick(): void {
    const loadAvg = os.loadavg()[0]; // 1-minute load average
    const freeCpuRatio = Math.max(0, 1 - (loadAvg / this.cpuCount));
    const optimal = this.clamp(
      Math.floor(freeCpuRatio * this.cpuCount * this.workersPerCore),
      this.minConcurrency,
      this.maxConcurrency
    );

    // Emit metrics regardless of concurrency change
    if (this.metricsCallback) {
      this.metricsCallback({
        concurrency: this.currentConcurrency,
        loadAverage: loadAvg,
        cpuCores: this.cpuCount,
      });
    }

    // Only adjust if difference exceeds smoothing threshold
    const diff = Math.abs(optimal - this.currentConcurrency);
    if (diff < SMOOTHING_THRESHOLD) return;

    const previous = this.currentConcurrency;
    this.currentConcurrency = optimal;
    this.onConcurrencyChange(optimal);

    logger.info('[CpuAdaptive] Concurrency adjusted', {
      previous,
      current: optimal,
      loadAvg: loadAvg.toFixed(2),
      freeCpuRatio: freeCpuRatio.toFixed(2),
      cpuCores: this.cpuCount,
    });
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}
