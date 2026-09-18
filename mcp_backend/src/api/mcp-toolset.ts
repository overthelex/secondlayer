/**
 * Deployment-level MCP toolset gate.
 *
 * `MCP_TOOLSET` narrows which tools every MCP transport advertises AND accepts:
 * the Streamable HTTP endpoints (/api/v1/mcp, /api/v2/mcp), the SSE transports
 * (/sse, /v1/sse) and the unauthenticated GET /mcp discovery listing.
 *
 *   unset or 'all' — no narrowing (serves the full registry / curated set)
 *   'ch'           — Swiss tools only, i.e. names starting with 'ch_'
 *   'uk'           — UK tools only, i.e. names starting with 'uk_'
 *   'ua'           — everything except the Swiss and UK tools (mcp.legal.org.ua)
 *
 * Several may be combined with commas: 'ch,uk' is what mcp.lawrider.ch serves, since that
 * deployment holds both corpora. A tool passes if ANY of the listed values admits it.
 *
 * 'ua' is a complement rather than its own prefix, because the Ukrainian tools carry no
 * shared prefix: search_*, get_*, openreyestr_*, rada_*. No tool name outside the Swiss
 * or UK corpora starts with 'ch_' or 'uk_', so the values partition the registry.
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
const UK_PREFIX = 'uk_';

let warnedUnknown: string | null = null;

function admits(value: string, name: string): boolean | null {
  if (value === 'all') return true;
  if (value === 'ch') return name.startsWith(CH_PREFIX);
  if (value === 'uk') return name.startsWith(UK_PREFIX);
  if (value === 'ua') return !name.startsWith(CH_PREFIX) && !name.startsWith(UK_PREFIX);
  return null;
}

export function isToolInToolset(name: string): boolean {
  const toolset = (process.env.MCP_TOOLSET || '').trim().toLowerCase();
  if (!toolset || toolset === 'all') return true;

  const values = toolset.split(',').map((v) => v.trim()).filter(Boolean);
  let sawKnown = false;
  let allowed = false;
  for (const value of values) {
    const verdict = admits(value, name);
    if (verdict === null) continue;          // unknown member, reported below
    sawKnown = true;
    if (verdict) allowed = true;
  }
  // Fail closed on a value we do not recognise at all: a typo in the compose file must
  // not quietly re-expose a corpus the deployment is not meant to serve. A LIST with one
  // bad member still honours its good members — dropping every tool because someone
  // added a stray comma would be its own outage.
  if (!sawKnown) {
    if (warnedUnknown !== toolset) {
      warnedUnknown = toolset;
      logger.error('[MCP] Unknown MCP_TOOLSET value — serving NO tools (fail closed)', { toolset });
    }
    return false;
  }
  return allowed;
}

/** Filter helper for tool-definition lists; keeps call sites one-line. */
export function filterToolsByToolset<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((t) => isToolInToolset(t.name));
}
