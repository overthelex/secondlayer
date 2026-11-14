/**
 * Redis HTML cache for the public SEO pages. Every Redis call is bounded by a
 * short timeout: a slow or reconnecting Redis degrades to rendering from the
 * database, never to a hanging page.
 */
import { getRedisClient } from '../../utils/redis-client.js';

const REDIS_TIMEOUT_MS = 300;

type Cache = { get(k: string): Promise<string | null>; set(k: string, v: string, o: { EX: number }): Promise<unknown> };

function withTimeout<T>(p: Promise<T>, ms = REDIS_TIMEOUT_MS): Promise<T | null> {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
  });
}

async function cache(): Promise<Cache | null> {
  const c = (await withTimeout(getRedisClient() as Promise<unknown>)) as (Cache & { isReady?: boolean }) | null;
  return c && c.isReady !== false ? c : null;
}

export async function cachedHtml(key: string, ttlS: number, build: () => Promise<string | null>): Promise<string | null> {
  const c = await cache();
  if (c) {
    const hit = await withTimeout(c.get(key));
    if (hit) return hit;
  }
  const html = await build();
  if (html && c) void withTimeout(c.set(key, html, { EX: ttlS }));
  return html;
}
