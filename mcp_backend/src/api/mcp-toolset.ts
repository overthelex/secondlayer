/**
 * Deployment-level MCP toolset gate.
 *
 * `MCP_TOOLSET` narrows which tools every MCP transport advertises AND accepts:
 * the Streamable HTTP endpoints (/api/v1/mcp, /api/v2/mcp), the SSE transports
 * (/sse, /v1/sse) and the unauthenticated GET /mcp discovery listing.
 *
 *   unset or 'all' — no narrowing (serves the full registry / curated set)
 *   'ch'           — Swiss tools only, i.e. names starting with 'ch_' (mcp.lawrider.ch)
 *   'ua'           — everything except the Swiss tools (mcp.legal.org.ua)
 *
 * 'ua' is the complement of 'ch' rather than its own prefix, because the Ukrainian
 * tools carry no shared prefix: search_*, get_*, openreyestr_*, rada_*. No tool name
 * outside the Swiss corpus starts with 'ch_', so the two values partition the registry.
 *
 * Any other value fails closed (no tools at all) with an error log: a typo in the
 * compose file must not quietly re-expose a corpus the deployment is not meant to
 * serve. The env var is read on every call, not at module load, so tests can vary it.
 *
 * This gate is jurisdictional (which deployment serves which corpus). It is
 * independent of the per-user Find Case Law licence gate in
 * services/uk-judgment-access.ts, and of the curated-v2 whitelist in
 * curated-mcp-tools.ts — all applicable filters intersect.
 */

import { logger } from '../utils/logger.js';

const CH_PREFIX = 'ch_';

let warnedUnknown: string | null = null;

export function isToolInToolset(name: string): boolean {
  const toolset = (process.env.MCP_TOOLSET || '').trim().toLowerCase();
  if (!toolset || toolset === 'all') return true;
  if (toolset === 'ch') return name.startsWith(CH_PREFIX);
  if (toolset === 'ua') return !name.startsWith(CH_PREFIX);
  if (warnedUnknown !== toolset) {
    warnedUnknown = toolset;
    logger.error('[MCP] Unknown MCP_TOOLSET value — serving NO tools (fail closed)', { toolset });
  }
  return false;
}

/** Filter helper for tool-definition lists; keeps call sites one-line. */
export function filterToolsByToolset<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((t) => isToolInToolset(t.name));
}
