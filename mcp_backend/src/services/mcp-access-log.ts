/**
 * Caller identity for the MCP audit trail (migration 244).
 *
 * Tool calls are recorded in cost_tracking (now with client_ip / user_agent / session);
 * session opens and refused authentications go to mcp_access_log. Both exist so that a
 * key used from many networks, or used for bulk extraction, is visible after the fact.
 */
import { isIP } from 'net';
import { logger } from '../utils/logger.js';

type HeaderBag = Record<string, string | string[] | undefined> | Headers | undefined;

export interface McpCallerInfo {
  clientIp: string | null;
  userAgent: string | null;
}

function header(headers: HeaderBag, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined;
  }
  const raw = (headers as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Strip an IPv4-mapped IPv6 prefix and return the address only if Postgres INET will take it. */
function validIp(candidate: string | undefined): string | null {
  if (!candidate) return null;
  const ip = candidate.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  return isIP(ip) ? ip : null;
}

/**
 * Real client IP behind Cloudflare → nginx: CF-Connecting-IP is set by Cloudflare and
 * cannot be forged through it; X-Forwarded-For's first hop and X-Real-IP are fallbacks
 * for requests that reach nginx directly.
 */
export function callerFromHeaders(headers: HeaderBag, fallbackIp?: string): McpCallerInfo {
  const xff = header(headers, 'x-forwarded-for')?.split(',')[0];
  const clientIp =
    validIp(header(headers, 'cf-connecting-ip')) ??
    validIp(xff) ??
    validIp(header(headers, 'x-real-ip')) ??
    validIp(fallbackIp);
  const ua = header(headers, 'user-agent');
  return { clientIp, userAgent: ua ? ua.slice(0, 512) : null };
}

export interface McpAccessEvent {
  transport: string;
  /**
   * tool_denied: an authenticated caller asked for a tool outside its scope (tool-access-policy).
   * endpoint_denied: a client API key (sl_...) used anywhere but /api/v2/mcp.
   */
  outcome: 'session_opened' | 'missing_auth' | 'invalid_api_key' | 'rate_limited' | 'auth_failed'
    | 'tool_denied' | 'endpoint_denied';
  authMethod?: 'api_key' | 'oauth' | 'jwt' | 'legacy_key';
  userId?: string;
  apiKeyId?: string;
  /** Raw bearer token: only its first 12 characters are stored. */
  token?: string;
  mcpSessionId?: string;
  caller: McpCallerInfo;
  detail?: string;
}

/** Fire-and-forget insert; an audit write must never fail the request it describes. */
export function logMcpAccess(db: { query: (sql: string, params: unknown[]) => Promise<unknown> }, e: McpAccessEvent): void {
  db.query(
    `INSERT INTO mcp_access_log
       (transport, outcome, auth_method, user_id, api_key_id, key_prefix, mcp_session_id,
        client_ip, user_agent, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::inet, $9, $10)`,
    [
      // transport/auth_method are VARCHAR(16), outcome VARCHAR(32): an over-long value
      // would fail the INSERT and silently lose the audit row
      e.transport.slice(0, 16),
      e.outcome.slice(0, 32),
      e.authMethod ? e.authMethod.slice(0, 16) : null,
      e.userId ?? null,
      e.apiKeyId ?? null,
      e.token ? e.token.slice(0, 12) : null,
      e.mcpSessionId ?? null,
      e.caller.clientIp,
      e.caller.userAgent,
      e.detail ? e.detail.slice(0, 500) : null,
    ]
  ).catch((err: Error) => {
    logger.warn('[MCP audit] Failed to write mcp_access_log', { outcome: e.outcome, error: err.message });
  });
}
