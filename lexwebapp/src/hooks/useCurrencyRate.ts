/**
 * Hook for getting USD->UAH exchange rate
 * Fetches rate from backend, caches client-side for 5 minutes
 */

import { useState, useEffect, useCallback } from 'react';
import { currencyService, ExchangeRateInfo } from '../services/api/CurrencyService';

const DEFAULT_RATE = 45.43;

interface UseCurrencyRateReturn {
  rate: number;
  isLoading: boolean;
  source: ExchangeRateInfo['source'];
  /** Convert USD amount to UAH */
  toUah: (usd: number) => number;
  /** Format a USD amount as UAH string with symbol */
  formatUah: (usd: number) => string;
  /** Format a UAH amount with symbol (no conversion) */
  formatUahDirect: (uah: number) => string;
}

export function useCurrencyRate(): UseCurrencyRateReturn {
  const [rate, setRate] = useState(DEFAULT_RATE);
  const [isLoading, setIsLoading] = useState(true);
  const [source, setSource] = useState<ExchangeRateInfo['source']>('default');

  useEffect(() => {
    let cancelled = false;

    currencyService.getRate().then((info) => {
      if (!cancelled) {
        setRate(info.rate);
        setSource(info.source);
        setIsLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, []);

  const toUah = useCallback(
    (usd: number) => Math.round(usd * rate * 100) / 100,
    [rate]
  );

  const formatUah = useCallback(
    (usd: number) => {
      const uah = Math.round(usd * rate * 100) / 100;
      if (uah < 0.01 && uah > 0) return `${uah.toFixed(4)} \u20B4`;
      if (uah < 1 && uah > 0) return `${uah.toFixed(2)} \u20B4`;
      return `${uah.toFixed(2)} \u20B4`;
    },
    [rate]
  );

  const formatUahDirect = useCallback(
    (uah: number) => {
      if (uah < 0.01 && uah > 0) return `${uah.toFixed(4)} \u20B4`;
      if (uah < 1 && uah > 0) return `${uah.toFixed(2)} \u20B4`;
      return `${uah.toFixed(2)} \u20B4`;
    },
    []
  );

  return { rate, isLoading, source, toUah, formatUah, formatUahDirect };
}
