/**
 * Who may reach the UK judgment corpus.
 *
 * The Find Case Law licence application (TNA ref CAS-349914-B9P5B8) answers
 * question 13 "Restricted access — only subscribers or research peers" and
 * question 14 "legal professionals and researchers". That answer is what buys the
 * 5-year transactional licence instead of a 1-year R&D licence whose outputs
 * cannot be given to third parties.
 *
 * It was not true when it was written: any authenticated user could mint an API
 * key and read judgments through `search_registry`. This module makes it true.
 *
 * ⚠ Judgments only. The uk_legislation* registries are Open Government Licence
 * v3.0 with commercial use permitted, so gating them would be a restriction we
 * invented rather than one we were given.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { logger } from '../utils/logger.js';

/**
 * Registries whose rows are Find Case Law records. Adding a registry here is the
 * only thing needed to bring it under the licence gate.
 */
export const LICENCE_GATED_REGISTRIES = new Set<string>(['uk_court_decisions']);

/**
 * Dedicated tools that read Find Case Law records, mapped to the registry they are
 * logged under. A tool over the judgments that is missing here is ungated, so the
 * test suite pins this map.
 */
export const LICENCE_GATED_TOOLS = new Map<string, string>([
  ['uk_search_judgments', 'uk_court_decisions'],
]);

/** What goes into the access log: search_registry nests its filters, a dedicated
 *  tool takes them as top-level arguments. */
export function judgmentFiltersOf(args: any): any {
  return args?.filters ?? args ?? null;
}

/** Free-mail hosts. A signal that routes an application to review — never a refusal:
 *  a sole practitioner or a barrister on a personal address is ordinary. */
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com', 'proton.me',
  'protonmail.com', 'gmx.com', 'mail.ru', 'ukr.net', 'yandex.ru',
]);

export function isFreeMailDomain(email: string | undefined | null): boolean {
  const d = (email || '').split('@')[1]?.toLowerCase();
  return d ? FREE_MAIL.has(d) : false;
}

export function emailDomain(email: string | undefined | null): string | null {
  return (email || '').split('@')[1]?.toLowerCase() || null;
}

/**
 * The registry a tool call is asking for, when that registry is licence-gated.
 * Returns null for everything else, so the guard costs one Set lookup on the
 * overwhelming majority of calls.
 */
export function gatedRegistryOf(toolName: string, args: any): string | null {
  const direct = LICENCE_GATED_TOOLS.get(toolName);
  if (direct) return direct;
  if (toolName !== 'search_registry') return null;
  const registry = args?.registry;
  return typeof registry === 'string' && LICENCE_GATED_REGISTRIES.has(registry)
    ? registry
    : null;
}

export interface AccessDecision {
  allowed: boolean;
  /** User-facing, in the language of the licence rather than of the database. */
  message?: string;
}

const DENIED_NO_RECORD: AccessDecision = {
  allowed: false,
  message:
    'Access to the UK judgments corpus (Find Case Law) is available only to practising ' +
    'lawyers, in-house legal teams and researchers. This is a condition of The National ' +
    'Archives licence, not our own restriction: the service is not offered to the general ' +
    'public or to litigants in person. To request access, apply via /api/uk-judgments/access ' +
    'with your organisation and role. UK legislation is available without this condition.',
};

const DENIED_PENDING: AccessDecision = {
  allowed: false,
  message:
    'We have received your request for access to the UK judgments corpus and have not ' +
    'decided it yet. We will let you know as soon as we do.',
};

const DENIED_EXPIRED: AccessDecision = {
  allowed: false,
  message:
    'Your access to the UK judgments corpus has lapsed: verification of professional ' +
    'standing is renewed every 12 months under The National Archives licence. Please ' +
    'apply again via /api/uk-judgments/access to confirm your organisation and role.',
};

/** How long a verified grant lasts before the person must be verified again. */
export const GRANT_VALIDITY_MONTHS = 12;

const DENIED_REFUSED: AccessDecision = {
  allowed: false,
  message:
    'Access to the UK judgments corpus is closed for this account. If this is a mistake, ' +
    'please contact us.',
};

/**
 * Decide whether this user may read judgments.
 *
 * Fails CLOSED. A database error here denies access rather than allowing it: a
 * licence commitment is exactly the place where a fallback that "keeps working"
 * quietly breaks the promise it was meant to keep.
 */
export async function checkJudgmentAccess(
  db: any,
  // JWT and OAuth hand back a string id, the HTTP layer a number. Accept both here
  // rather than casting at four call sites and getting one of them wrong.
  userId: string | number | undefined | null
): Promise<AccessDecision> {
  if (userId === undefined || userId === null || userId === '') return DENIED_NO_RECORD;
  try {
    const r = await db.query(
      'SELECT status, expires_at > now() AS live FROM uk_judgment_access WHERE user_id = $1',
      [userId]
    );
    const status = r.rows[0]?.status;
    // A grant without a live expiry is a lapsed one: NULL denies, so a grant written
    // by hand without a date cannot become permanent by accident.
    if (status === 'granted') return r.rows[0].live === true ? { allowed: true } : DENIED_EXPIRED;
    if (status === 'pending') return DENIED_PENDING;
    if (status === 'refused' || status === 'revoked') return DENIED_REFUSED;
    return DENIED_NO_RECORD;
  } catch (error: any) {
    logger.error('uk judgment access check failed — denying', {
      userId,
      error: error.message,
    });
    return DENIED_REFUSED;
  }
}

export interface AccessLogMeta {
  /** Default 'allowed'. Refusals are logged too: they are the evidence the gate works. */
  outcome?: 'allowed' | 'denied';
  tool?: string;
  /** 'mcp', 'rest', 'rest-stream', 'rest-batch'. */
  transport?: string;
}

/**
 * Principle 6 of the licence: access is logged. Best-effort — a failure to write
 * the log must not deny a user who is entitled to the data, which is the opposite
 * of the rule for the check above.
 */
export async function logJudgmentAccess(
  db: any,
  userId: string | number | undefined | null,
  registry: string,
  filters: any,
  meta: AccessLogMeta = {}
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO uk_judgment_access_log (user_id, registry, filters, outcome, tool, transport)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId ?? null, registry, filters ? JSON.stringify(filters) : null,
       meta.outcome ?? 'allowed', meta.tool ?? null, meta.transport ?? null]
    );
  } catch (error: any) {
    logger.warn('uk judgment access log write failed', { error: error.message });
  }
}

/**
 * Proof, carried on the async context, that THIS request passed checkJudgmentAccess.
 *
 * The check runs in the transports (MCP, HTTP, batch). Anything else that reaches
 * ToolRegistry.executeTool — the legacy /sse server, the workflow executor, a tool
 * calling another tool — never ran it, so the registry refuses a gated call unless
 * this marker is present. Fails closed: a new path is denied until it is gated.
 */
const judgmentAccess = new AsyncLocalStorage<{ granted: true }>();

/** Call right after an allowed checkJudgmentAccess, in the same request handler. */
export function markJudgmentAccessGranted(): void {
  judgmentAccess.enterWith({ granted: true });
}

export function hasJudgmentAccessMark(): boolean {
  return judgmentAccess.getStore()?.granted === true;
}

/** Test-only: run fn as if the transport had granted access. */
export function runWithJudgmentAccess<T>(fn: () => T): T {
  return judgmentAccess.run({ granted: true }, fn);
}
