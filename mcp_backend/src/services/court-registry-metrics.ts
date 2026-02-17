/**
 * Prometheus metrics for court registry scraping (LEG-53)
 */

import { Registry, Counter, Gauge, Histogram } from 'prom-client';

const registry = new Registry();

export const courtRegistryScrapeTotal = new Counter({
  name: 'court_registry_scrape_total',
  help: 'Total documents scraped from court registry',
  labelNames: ['status'],
  registers: [registry],
});

export const courtRegistryScrapeDuration = new Histogram({
  name: 'court_registry_scrape_duration_seconds',
  help: 'Scraping duration per document',
  labelNames: ['status'],
  buckets: [0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const courtRegistryScrapeSuccessRate = new Gauge({
  name: 'court_registry_scrape_success_rate',
  help: 'Success rate of last scrape run',
  registers: [registry],
});

export const courtRegistryCaptchaCount = new Counter({
  name: 'court_registry_captcha_total',
  help: 'Total CAPTCHAs encountered',
  registers: [registry],
});

export const courtRegistryBlockCount = new Counter({
  name: 'court_registry_block_total',
  help: 'Total access blocks encountered',
  registers: [registry],
});

export function getCourtRegistryMetricsRegistry(): Registry {
  return registry;
}
