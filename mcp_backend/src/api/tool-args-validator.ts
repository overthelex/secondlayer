/**
 * Unknown tool argument rejection (LEXAI-2164).
 *
 * A tool argument that is not in the tool's inputSchema used to be dropped silently, so
 * `openreyestr_search_debtors {name: 'НАФТОГАЗ'}` ran with no filter at all and returned
 * the newest unrelated rows as if they were the answer. This module rejects such calls
 * with a Ukrainian message that lists the valid arguments, the same way search_registry
 * already rejects unknown filter fields, so the model can correct itself.
 *
 * It is applied at the external transports (MCP /v1, /v2, /sse and REST /api/tools),
 * not inside ToolRegistry.executeTool: internal callers (chat pipeline, workflows,
 * handlers re-entering themselves) legitimately pass internal arguments.
 */

import { logger } from '../utils/logger.js';
import type { ToolResult } from './base-tool-handler.js';

/**
 * Arguments accepted for every tool even when the schema does not list them:
 *  - anything starting with `_` (MCP `_meta`, internal flags such as `_skip_fts_leg`,
 *    `_fallback_from`, `_military_label`);
 *  - reasoning budget hints that clients send to any tool (mcp-query-api reads
 *    `budget || reasoning_budget`).
 */
const ALWAYS_ALLOWED = new Set(['budget', 'reasoning_budget']);

function isAlwaysAllowed(key: string): boolean {
  return key.startsWith('_') || ALWAYS_ALLOWED.has(key);
}

/**
 * Collect the argument names a JSON schema accepts. Returns null when the schema does
 * not constrain argument names (no schema, additionalProperties true or a schema,
 * patternProperties, or no properties at all) — such tools are never rejected.
 */
export function allowedArgNames(schema: any): Set<string> | null {
  if (!schema || typeof schema !== 'object') return null;
  const names = new Set<string>();
  const visit = (s: any): boolean => {
    if (!s || typeof s !== 'object') return true;
    if (s.additionalProperties === true || (s.additionalProperties && typeof s.additionalProperties === 'object')) {
      return false;
    }
    if (s.patternProperties && Object.keys(s.patternProperties).length > 0) return false;
    if (s.properties && typeof s.properties === 'object') {
      for (const k of Object.keys(s.properties)) names.add(k);
    }
    for (const comb of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(s[comb])) {
        for (const sub of s[comb]) if (!visit(sub)) return false;
      }
    }
    return true;
  };
  if (!visit(schema)) return null;
  return names.size > 0 ? names : null;
}

/** Names of arguments in `args` that `schema` does not accept (empty when none / unconstrained). */
export function findUnknownArgs(schema: any, args: unknown): string[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  const allowed = allowedArgNames(schema);
  if (!allowed) return [];
  return Object.keys(args as Record<string, unknown>).filter(k => !allowed.has(k) && !isAlwaysAllowed(k));
}

function describeArgs(schema: any): string {
  const props: Record<string, any> = {};
  const collect = (s: any) => {
    if (!s || typeof s !== 'object') return;
    if (s.properties) Object.assign(props, s.properties);
    for (const comb of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(s[comb])) s[comb].forEach(collect);
  };
  collect(schema);
  const required = new Set<string>(Array.isArray(schema?.required) ? schema.required : []);
  return Object.entries(props)
    .map(([name, p]) => {
      const desc = typeof p?.description === 'string' ? ` — ${p.description.split('\n')[0]}` : '';
      return `  • ${name}${required.has(name) ? ' (обов\'язковий)' : ''}${desc}`;
    })
    .join('\n');
}

/** Ukrainian error text for a call with unknown arguments. */
export function unknownArgsMessage(toolName: string, unknown: string[], schema: any): string {
  return `Невідомі параметри інструмента ${toolName}: ${unknown.join(', ')}. ` +
    `Ці параметри не підтримуються і не були б застосовані до пошуку.\n\nДоступні параметри:\n${describeArgs(schema)}`;
}

/** Strict mode is on unless TOOL_ARGS_STRICT=false (then unknown args are only logged). */
function strictMode(): boolean {
  return String(process.env.TOOL_ARGS_STRICT ?? 'true').toLowerCase() !== 'false';
}

/**
 * Validate `args` against `schema`. Returns a ToolResult error to send back to the client,
 * or null when the call may proceed. Rejections (and, in non-strict mode, would-be
 * rejections) are logged.
 */
export function checkToolArgs(
  toolName: string,
  schema: any,
  args: unknown,
  transport: string,
): ToolResult | null {
  const unknown = findUnknownArgs(schema, args);
  if (unknown.length === 0) return null;
  const strict = strictMode();
  logger.warn('[ToolArgs] Unknown tool arguments', {
    tool: toolName,
    unknown,
    transport,
    action: strict ? 'rejected' : 'logged',
  });
  if (!strict) return null;
  return {
    content: [{ type: 'text', text: unknownArgsMessage(toolName, unknown, schema) }],
    isError: true,
  };
}
