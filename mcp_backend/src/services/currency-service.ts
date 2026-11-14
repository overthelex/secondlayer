/**
 * CurrencyService
 * Fetches USD->UAH exchange rate from NBU (National Bank of Ukraine) public API.
 * Caches rate in Redis with 24-hour TTL (NBU updates rate once daily).
 * Falls back to last-known rate or default (~45.43 UAH, NBU 14.11.2026) if API unavailable.
 */

import { logger } from '../utils/logger.js';
import { getRedisClient } from '../utils/redis-client.js';

const REDIS_KEY = 'exchange_rate:NBU_USD_UAH';
const REDIS_TTL_SECONDS = 86400; // 24 hours
const DEFAULT_RATE = 45.43;
const NBU_API_URL = 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&json';

export interface ExchangeRateInfo {
  rate: number;
  source: 'NBU' | 'cache' | 'default';
  lastUpdated: string;
}

interface NBUResponse {
  r030: number;
  txt: string;
  rate: number;
  cc: string;
  exchangedate: string;
}

export class CurrencyService {
  private lastKnownRate: number = DEFAULT_RATE;
  private lastFetchedAt: string = new Date().toISOString();

  /**
   * Get current USD->UAH rate.
   * Priority: Redis cache -> NBU API -> last-known -> default.
   */
  async getUsdToUahRate(): Promise<ExchangeRateInfo> {
    // 1. Try Redis cache
    try {
      const redis = await getRedisClient();
      if (redis) {
        const cached = await redis.get(REDIS_KEY);
        if (cached) {
          const parsed = JSON.parse(cached);
          this.lastKnownRate = parsed.rate;
          this.lastFetchedAt = parsed.lastUpdated;
          return {
            rate: parsed.rate,
            source: 'cache',
            lastUpdated: parsed.lastUpdated,
          };
        }
      }
    } catch (err) {
      logger.warn('[CurrencyService] Redis read failed', { error: (err as Error).message });
    }

    // 2. Fetch from NBU API
    try {
      const rate = await this.fetchFromNBU();
      const now = new Date().toISOString();

      this.lastKnownRate = rate;
      this.lastFetchedAt = now;

      // Cache in Redis
      try {
        const redis = await getRedisClient();
        if (redis) {
          await redis.set(
            REDIS_KEY,
            JSON.stringify({ rate, lastUpdated: now }),
            { EX: REDIS_TTL_SECONDS }
          );
        }
      } catch (err) {
        logger.warn('[CurrencyService] Redis write failed', { error: (err as Error).message });
      }

      return {
        rate,
        source: 'NBU',
        lastUpdated: now,
      };
    } catch (err) {
      logger.warn('[CurrencyService] NBU API failed, using fallback', {
        error: (err as Error).message,
        fallbackRate: this.lastKnownRate,
      });
    }

    // 3. Fall back to last-known or default
    return {
      rate: this.lastKnownRate,
      source: 'default',
      lastUpdated: this.lastFetchedAt,
    };
  }

  /**
   * Convert USD amount to UAH.
   */
  async convertUsdToUah(amountUsd: number): Promise<{ amountUah: number; rate: number }> {
    const { rate } = await this.getUsdToUahRate();
    return {
      amountUah: Math.round(amountUsd * rate * 100) / 100,
      rate,
    };
  }

  /**
   * Convert UAH amount to USD.
   */
  async convertUahToUsd(amountUah: number): Promise<{ amountUsd: number; rate: number }> {
    const { rate } = await this.getUsdToUahRate();
    return {
      amountUsd: Math.round((amountUah / rate) * 100) / 100,
      rate,
    };
  }

  /**
   * Refresh the exchange rate from NBU API and update cache.
   * Can be called by a cron/scheduled task.
   */
  async refreshRate(): Promise<void> {
    logger.info('[CurrencyService] Refreshing NBU exchange rate...');
    try {
      const rate = await this.fetchFromNBU();
      const now = new Date().toISOString();

      this.lastKnownRate = rate;
      this.lastFetchedAt = now;

      // Update Redis cache
      try {
        const redis = await getRedisClient();
        if (redis) {
          await redis.set(
            REDIS_KEY,
            JSON.stringify({ rate, lastUpdated: now }),
            { EX: REDIS_TTL_SECONDS }
          );
        }
      } catch (err) {
        logger.warn('[CurrencyService] Redis write failed during refresh', { error: (err as Error).message });
      }

      logger.info('[CurrencyService] NBU rate refreshed successfully', { rate });
    } catch (err) {
      logger.error('[CurrencyService] Failed to refresh NBU rate', { error: (err as Error).message });
    }
  }

  /**
   * Fetch USD->UAH rate from NBU (National Bank of Ukraine) API.
   * Response: [{"r030":840,"txt":"Долар США","rate":41.2538,"cc":"USD","exchangedate":"08.03.2026"}]
   */
  private async fetchFromNBU(): Promise<number> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(NBU_API_URL, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`NBU API returned ${response.status}`);
      }

      const data = await response.json() as NBUResponse[];

      if (!Array.isArray(data) || data.length === 0) {
        throw new Error('Empty or invalid response from NBU API');
      }

      const rate = data[0].rate;
      if (!rate || rate <= 0) {
        throw new Error('Invalid rate value from NBU API');
      }

      logger.info('[CurrencyService] Fetched USD/UAH rate from NBU', { rate });
      return rate;
    } finally {
      clearTimeout(timeout);
    }
  }
}
