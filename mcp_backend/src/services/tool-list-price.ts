/**
 * List prices per tool call (tool_pricing.base_cost_usd × (1 + markup_percent / 100)).
 *
 * A usage-billed tool call is charged at least its list price: the tracked usage cost (LLM
 * tokens, embeddings, upstream services) when that is higher, the list price otherwise. Before
 * this, base_cost_usd was read only by the admin panel, so most legal.org.ua tools (DB lookups
 * with no LLM step) were charged $0.
 *
 * Not covered here: fixed-price tools (tool_pricing.fixed_price, billed by FixedPriceBilling)
 * and ai_chat, whose base_cost_usd is an average session cost, not a price; chat stays billed
 * by its actual token usage. The lookup is cached because it runs on every tool call.
 */

import { logger } from '../utils/logger.js';
import { Queryable } from './tool-fixed-price.js';

/** Tools whose tool_pricing row is a cost reference, not a per-call price. */
const NOT_LIST_PRICED = new Set(['ai_chat']);

const CACHE_TTL_MS = 60_000;

let cache: { loadedAt: number; prices: Map<string, number> } | null = null;

async function loadPrices(db: Queryable): Promise<Map<string, number>> {
  const result = await db.query(
    `SELECT tool_name, base_cost_usd, markup_percent
       FROM tool_pricing
      WHERE is_active = true AND fixed_price IS NULL AND base_cost_usd > 0`
  );
  const prices = new Map<string, number>();
  for (const row of result.rows) {
    if (NOT_LIST_PRICED.has(row.tool_name)) continue;
    const price = Number(row.base_cost_usd) * (1 + (Number(row.markup_percent) || 0) / 100);
    if (price > 0) prices.set(row.tool_name, price);
  }
  return prices;
}

/**
 * List price in USD for one call of a tool, or 0 if the tool has none. On a lookup failure it
 * returns the last known price (or 0) and logs, so a pricing-table problem degrades to plain
 * usage billing instead of blocking calls.
 */
export async function getToolListPriceUsd(db: Queryable, toolName: string): Promise<number> {
  const now = Date.now();
  if (!cache || now - cache.loadedAt > CACHE_TTL_MS) {
    try {
      cache = { loadedAt: now, prices: await loadPrices(db) };
    } catch (err: any) {
      logger.warn('[ToolListPrice] Failed to load list prices', { error: err.message });
      return cache?.prices.get(toolName) ?? 0;
    }
  }
  return cache.prices.get(toolName) ?? 0;
}

/** Test hook: forget cached prices. */
export function resetToolListPriceCache(): void {
  cache = null;
}
