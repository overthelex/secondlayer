/**
 * Per-account limits on MCP tool calls (table mcp_usage_limits, migration 229).
 *
 * The API-key limits in api_keys are checked once, when an MCP session is initialised, so
 * every tool call inside an open session, and every OAuth session, ran unthrottled. These
 * limits are checked on each tools/call against the user, whatever the credential, session
 * or transport:
 *   • max_concurrent    — tool calls running at the same time (in-process; one backend);
 *   • per_minute / per_hour / per_day — tool calls in fixed windows (Redis, memory fallback);
 *   • doc_fetch_per_day — full court-decision texts per day, counted in documents, so one
 *     load_full_texts with 1000 doc_ids spends 1000, not 1.
 * Past warn_ratio of a daily quota the result carries a warning; at the quota calls are
 * refused until the UTC day rolls over. A user without a row is not limited here.
 */

import type { ICachePort } from '../domain/ports/index.js';
import { logger } from '../utils/logger.js';
import { Queryable } from './tool-fixed-price.js';

export interface McpUsageLimits {
  maxConcurrent: number | null;
  perMinute: number | null;
  perHour: number | null;
  perDay: number | null;
  docFetchPerDay: number | null;
  warnRatio: number;
}

export type McpLimitDecision =
  | { allowed: true; warning?: string; release: () => void }
  | { allowed: false; message: string };

/** Tools that return full court-decision texts, and how many documents a call fetches. */
export function documentsFetched(toolName: string, args: Record<string, any>): number {
  switch (toolName) {
    case 'get_court_decision':
    case 'get_case_documents_chain':
      return 1;
    case 'load_full_texts': {
      const ids = Array.isArray(args.doc_ids) ? args.doc_ids.length : 0;
      const max = Number(args.max_docs);
      return Math.max(1, Number.isFinite(max) && max > 0 ? Math.min(ids, max) : ids);
    }
    default:
      return 0;
  }
}

let cache: ICachePort | null = null;

/** Set the cache port for the window counters. Call from the composition root. */
export function setMcpUsageLimitCache(port: ICachePort): void {
  cache = port;
}

const memoryCounters = new Map<string, { count: number; expiresAt: number }>();

async function increment(key: string, ttlSeconds: number, by: number): Promise<number> {
  if (cache) {
    try {
      return await cache.increment(key, ttlSeconds, by);
    } catch (err: any) {
      logger.warn('[McpUsageLimits] Cache increment failed, using memory', { error: err.message });
    }
  }
  const now = Date.now();
  const entry = memoryCounters.get(key);
  if (entry && entry.expiresAt > now) {
    entry.count += by;
    return entry.count;
  }
  memoryCounters.set(key, { count: by, expiresAt: now + ttlSeconds * 1000 });
  return by;
}

const LIMITS_TTL_MS = 60_000;
let limitsCache: { loadedAt: number; byUser: Map<string, McpUsageLimits> } | null = null;

const intOrNull = (v: any): number | null => (v === null || v === undefined ? null : Number(v));

async function loadLimits(db: Queryable): Promise<Map<string, McpUsageLimits>> {
  const result = await db.query(
    `SELECT user_id, max_concurrent, per_minute, per_hour, per_day, doc_fetch_per_day, warn_ratio
       FROM mcp_usage_limits`
  );
  const byUser = new Map<string, McpUsageLimits>();
  for (const row of result.rows) {
    byUser.set(String(row.user_id), {
      maxConcurrent: intOrNull(row.max_concurrent),
      perMinute: intOrNull(row.per_minute),
      perHour: intOrNull(row.per_hour),
      perDay: intOrNull(row.per_day),
      docFetchPerDay: intOrNull(row.doc_fetch_per_day),
      warnRatio: Number(row.warn_ratio) || 0.8,
    });
  }
  return byUser;
}

/** Limits for a user, or null if the user has none. A table problem means "no limits". */
export async function getMcpUsageLimits(db: Queryable, userId: string): Promise<McpUsageLimits | null> {
  const now = Date.now();
  if (!limitsCache || now - limitsCache.loadedAt > LIMITS_TTL_MS) {
    try {
      limitsCache = { loadedAt: now, byUser: await loadLimits(db) };
    } catch (err: any) {
      logger.warn('[McpUsageLimits] Failed to load limits', { error: err.message });
      return limitsCache?.byUser.get(userId) ?? null;
    }
  }
  return limitsCache.byUser.get(userId) ?? null;
}

const inFlight = new Map<string, number>();

function secondsToNext(windowSeconds: number, nowMs: number): number {
  return windowSeconds - (Math.floor(nowMs / 1000) % windowSeconds);
}

/**
 * Check and count one tool call. On allowed, the caller must call release() when the tool
 * finishes (success or error) to free its concurrency slot.
 */
export async function acquireMcpCall(
  db: Queryable,
  userId: string,
  toolName: string,
  args: Record<string, any>,
  nowMs: number = Date.now()
): Promise<McpLimitDecision> {
  const limits = await getMcpUsageLimits(db, userId);
  if (!limits) return { allowed: true, release: () => {} };

  const running = inFlight.get(userId) ?? 0;
  if (limits.maxConcurrent !== null && running >= limits.maxConcurrent) {
    logger.warn('[McpUsageLimits] Concurrency limit', { userId, toolName, running });
    return {
      allowed: false,
      message: `Error: перевищено ліміт одночасних запитів (${limits.maxConcurrent}). Дочекайтеся завершення попередніх викликів і повторіть.`,
    };
  }

  const minute = Math.floor(nowMs / 60_000);
  const hour = Math.floor(nowMs / 3_600_000);
  const day = Math.floor(nowMs / 86_400_000);
  const windows: Array<[number | null, string, number, string]> = [
    [limits.perMinute, `mcplim:${userId}:m:${minute}`, 60, 'на хвилину'],
    [limits.perHour, `mcplim:${userId}:h:${hour}`, 3600, 'на годину'],
    [limits.perDay, `mcplim:${userId}:d:${day}`, 86400, 'на добу'],
  ];

  let warning: string | undefined;
  for (const [limit, key, seconds, label] of windows) {
    if (limit === null) continue;
    const count = await increment(key, seconds, 1);
    if (count > limit) {
      const wait = secondsToNext(seconds, nowMs);
      logger.warn('[McpUsageLimits] Rate limit', { userId, toolName, window: label, count, limit });
      return {
        allowed: false,
        message: `Error: перевищено ліміт ${limit} запитів ${label}. Наступні запити будуть доступні через ${wait} с.`,
      };
    }
    if (seconds === 86400 && count >= Math.ceil(limit * limits.warnRatio)) {
      warning = `Увага: використано ${count} з ${limit} запитів на добу. Після вичерпання ліміту доступ буде заблоковано до 00:00 UTC.`;
    }
  }

  const docs = documentsFetched(toolName, args);
  if (docs > 0 && limits.docFetchPerDay !== null) {
    const count = await increment(`mcplim:${userId}:docs:${day}`, 86400, docs);
    if (count > limits.docFetchPerDay) {
      logger.warn('[McpUsageLimits] Document quota', { userId, toolName, docs, count, limit: limits.docFetchPerDay });
      return {
        allowed: false,
        message: `Error: перевищено ліміт ${limits.docFetchPerDay} повних текстів судових рішень на добу (запит на ${docs}). Ліміт оновиться о 00:00 UTC.`,
      };
    }
    if (count >= Math.ceil(limits.docFetchPerDay * limits.warnRatio)) {
      warning = `Увага: отримано ${count} з ${limits.docFetchPerDay} повних текстів рішень на добу. Після вичерпання ліміту отримання текстів буде заблоковано до 00:00 UTC.`;
    }
  }

  inFlight.set(userId, running + 1);
  let released = false;
  return {
    allowed: true,
    warning,
    release: () => {
      if (released) return;
      released = true;
      const n = (inFlight.get(userId) ?? 1) - 1;
      if (n <= 0) inFlight.delete(userId);
      else inFlight.set(userId, n);
    },
  };
}

/** Test hook: forget cached limits, counters and in-flight calls. */
export function resetMcpUsageLimits(): void {
  limitsCache = null;
  memoryCounters.clear();
  inFlight.clear();
  cache = null;
}

/**
 * Express middleware for the REST tool routes (/api/tools/:toolName, /:toolName/stream,
 * /batch): the same per-account limits as MCP, so an API key cannot sidestep them over REST.
 * Put it after authentication. Answers 429 on refusal; frees the slots when the response ends.
 */
export function mcpUsageLimitMiddleware(db: Queryable) {
  return async (req: any, res: any, next: any) => {
    const userId: string | undefined = req.user?.id;
    if (!userId) return next();

    const calls: Array<{ name: string; args: Record<string, any> }> = Array.isArray(req.body?.calls)
      ? req.body.calls.map((c: any) => ({ name: String(c?.name), args: c?.arguments || {} }))
      : [{ name: String(req.params?.toolName), args: req.body?.arguments || req.body || {} }];

    const releases: Array<() => void> = [];
    const releaseAll = () => releases.splice(0).forEach((r) => r());
    try {
      for (const call of calls) {
        const decision = await acquireMcpCall(db, userId, call.name, call.args);
        if (!decision.allowed) {
          releaseAll();
          return res.status(429).json({ error: 'Rate limit exceeded', code: 'RATE_LIMIT_EXCEEDED', message: decision.message });
        }
        releases.push(decision.release);
        if (decision.warning) res.setHeader('X-Usage-Warning', encodeURIComponent(decision.warning));
      }
    } catch (err: any) {
      releaseAll();
      logger.warn('[McpUsageLimits] REST limit check failed, allowing call', { error: err.message });
      return next();
    }
    res.on('finish', releaseAll);
    res.on('close', releaseAll);
    next();
  };
}
