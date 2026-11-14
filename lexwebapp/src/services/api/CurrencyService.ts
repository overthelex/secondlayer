/**
 * Currency Service
 * Fetches and caches USD->UAH exchange rate from backend
 */

import { BaseService } from '../base/BaseService';

export interface ExchangeRateInfo {
  rate: number;
  source: 'NBU' | 'cache' | 'default';
  lastUpdated: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes client-side cache

class CurrencyServiceClass extends BaseService {
  private cachedRate: ExchangeRateInfo | null = null;
  private lastFetchedAt = 0;

  /**
   * Get current USD->UAH rate (with client-side caching)
   */
  async getRate(): Promise<ExchangeRateInfo> {
    const now = Date.now();
    if (this.cachedRate && now - this.lastFetchedAt < CACHE_TTL_MS) {
      return this.cachedRate;
    }

    try {
      const response = await this.client.get<ExchangeRateInfo>('/api/currency/rate');
      this.cachedRate = response.data;
      this.lastFetchedAt = now;
      return response.data;
    } catch (error) {
      // If fetch fails, return cached value or default
      if (this.cachedRate) {
        return this.cachedRate;
      }
      return {
        rate: 45.43,
        source: 'default',
        lastUpdated: new Date().toISOString(),
      };
    }
  }

  /**
   * Convert USD to UAH using cached rate
   */
  async convertToUah(amountUsd: number): Promise<number> {
    const { rate } = await this.getRate();
    return Math.round(amountUsd * rate * 100) / 100;
  }

  /**
   * Format amount as UAH string
   */
  formatUah(amount: number): string {
    if (amount < 0.01 && amount > 0) return `${amount.toFixed(4)} \u20B4`;
    if (amount < 1) return `${amount.toFixed(2)} \u20B4`;
    return `${amount.toFixed(2)} \u20B4`;
  }
}

export const currencyService = new CurrencyServiceClass();
export { CurrencyServiceClass as CurrencyService };
