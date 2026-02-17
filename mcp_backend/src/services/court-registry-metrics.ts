/**
 * Simple counters for court registry scraping (LEG-53).
 * No prom-client dependency — the scraper is a standalone script
 * that does not expose /metrics. Values are used for logging and alerts only.
 */

class SimpleCounter {
  private value = 0;
  inc(_labels?: Record<string, string>): void {
    this.value++;
  }
  get(): number {
    return this.value;
  }
}

class SimpleGauge {
  private value = 0;
  set(v: number): void {
    this.value = v;
  }
  get(): number {
    return this.value;
  }
}

export const courtRegistryScrapeTotal = new SimpleCounter();
export const courtRegistryScrapeSuccessRate = new SimpleGauge();
export const courtRegistryCaptchaCount = new SimpleCounter();
export const courtRegistryBlockCount = new SimpleCounter();
