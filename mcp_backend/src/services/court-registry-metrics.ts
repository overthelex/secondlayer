/**
 * Prometheus metrics for court registry scraping (LEG-53).
 * Script does not expose HTTP /metrics; counters are for logging/debug. Pushgateway can be added later.
 */

import { Registry, Counter, Gauge } from 'prom-client';

const registry = new Registry();

export const courtRegistryScrapeTotal = new Counter({
  name: 'court_registry_scrape_total',
  help: 'Total documents scraped from court registry',
  labelNames: ['status'],
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
