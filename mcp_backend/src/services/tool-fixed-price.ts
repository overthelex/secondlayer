/**
 * Fixed per-call tool prices (tool_pricing.fixed_price / fixed_price_currency, migration 223).
 *
 * A tool with a fixed price is charged exactly that amount per successful call, in the
 * price's own currency, with no tier or tool markup. Every other tool keeps the variable
 * path (LLM tokens + upstream calls + markup in chargeUser). The lookup is cached because it
 * runs twice on every MCP tool call (pre-flight and charge).
 */

import { logger } from '../utils/logger.js';

export type BillingCurrency = 'USD' | 'GBP';

export interface FixedToolPrice {
  amount: number;
  currency: BillingCurrency;
}

/** The slice of the db handle this module uses; both Database and a pg PoolClient fit. */
export interface Queryable {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

const CACHE_TTL_MS = 60_000;

let cache: { loadedAt: number; prices: Map<string, FixedToolPrice> } | null = null;

async function loadPrices(db: Queryable): Promise<Map<string, FixedToolPrice>> {
  const result = await db.query(
    `SELECT tool_name, fixed_price, fixed_price_currency
       FROM tool_pricing
      WHERE is_active = true AND fixed_price IS NOT NULL AND fixed_price_currency IS NOT NULL`
  );
  const prices = new Map<string, FixedToolPrice>();
  for (const row of result.rows) {
    prices.set(row.tool_name, {
      amount: Number(row.fixed_price),
      currency: String(row.fixed_price_currency).trim().toUpperCase() as BillingCurrency,
    });
  }
  return prices;
}

/**
 * Fixed price for a tool, or null if the tool is billed by usage. On a lookup failure it
 * returns null and logs, so a pricing-table problem degrades to the old (usage) path instead
 * of blocking calls.
 */
export async function getFixedToolPrice(db: Queryable, toolName: string): Promise<FixedToolPrice | null> {
  const now = Date.now();
  if (!cache || now - cache.loadedAt > CACHE_TTL_MS) {
    try {
      cache = { loadedAt: now, prices: await loadPrices(db) };
    } catch (err: any) {
      logger.warn('[ToolFixedPrice] Failed to load fixed prices', { error: err.message });
      return cache?.prices.get(toolName) ?? null;
    }
  }
  return cache.prices.get(toolName) ?? null;
}

export function formatMoney(amount: number, currency: string): string {
  const symbol = currency === 'GBP' ? '£' : currency === 'USD' ? '$' : `${currency} `;
  return `${symbol}${amount.toFixed(2)}`;
}

/** Test hook: forget cached prices. */
export function resetFixedToolPriceCache(): void {
  cache = null;
}
