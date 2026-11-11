/**
 * Private MCP toolsets: tools that exist only for the accounts granted them.
 *
 * A private toolset is advertised in tools/list and callable over MCP only when BOTH:
 *   1. the deployment configures it (its env var points at a mounted folder), and
 *   2. the calling user has a row in private_tool_grants for that toolset.
 * Admins get no bypass: a private archive is visible to its grantees only.
 *
 * Private tools are deliberately kept OUT of the ToolRegistry. The chat pipeline,
 * workflow executor and REST /api/tools/* all execute through the registry, so they
 * cannot list or call these tools by any name. The only door is buildMcpServer in
 * routes/mcp-sse-routes.ts, which asks this module per user.
 *
 * Grants are data, not code: the repository is public, so who holds a grant never
 * appears here. Grant on the box:
 *   INSERT INTO private_tool_grants (user_id, toolset) SELECT id, 'gorenichi' FROM users WHERE email = '…';
 */
import { existsSync } from 'fs';
import { logger } from '../../utils/logger.js';
import type { ToolDefinition } from '../base-tool-handler.js';
import { PrivateDocsToolset, PrivateToolResult } from './private-docs-toolset.js';
import { CaseToolset, CaseToolsetDeps } from './case-toolset.js';

type Queryable = { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> };

/** What every private toolset offers to buildMcpServer. */
export interface PrivateToolset {
  readonly id: string;
  toolNames(): string[];
  getToolDefinitions(): ToolDefinition[];
  execute(name: string, args: Record<string, any>): Promise<PrivateToolResult>;
}

/** Toolsets known to the code, keyed by id; each enabled only when its folder is mounted. */
const KNOWN: Array<{ id: string; env: string; label: string; kind: 'docs' | 'cases' }> = [
  { id: 'gorenichi', env: 'GORENICHI_DOCS_ROOT', label: 'Гореничі', kind: 'docs' },
  { id: 'cases', env: 'CASES_DOCS_ROOT', label: 'Справи', kind: 'cases' },
];

let configured: Map<string, PrivateToolset> | null = null;
let privateToolDeps: CaseToolsetDeps | null = null;

/** Wire OCR / LLM / legislation for the cases toolset; call before the first tools/list. */
export function setPrivateToolDeps(deps: CaseToolsetDeps | null): void {
  privateToolDeps = deps;
}

export function configuredToolsets(): Map<string, PrivateToolset> {
  if (configured) return configured;
  configured = new Map();
  for (const k of KNOWN) {
    const root = (process.env[k.env] || '').trim();
    if (!root) continue;
    if (!existsSync(root)) {
      logger.warn('[PrivateTools] Folder not mounted, toolset disabled', { toolset: k.id, env: k.env });
      continue;
    }
    const docs = new PrivateDocsToolset(k.id, root, k.label);
    if (k.kind === 'cases') {
      if (!privateToolDeps) logger.warn('[PrivateTools] Cases toolset has no OCR/LLM deps; upload and analysis tools will refuse', { toolset: k.id });
      configured.set(k.id, new CaseToolset(docs, privateToolDeps));
    } else {
      configured.set(k.id, docs);
    }
  }
  return configured;
}

/** Test hook. */
export function setConfiguredToolsetsForTest(map: Map<string, PrivateToolset> | null): void {
  configured = map;
  grantCache.clear();
}

/** True when the name belongs to ANY known private toolset, configured here or not. */
export function isPrivateToolName(name: string): boolean {
  return KNOWN.some((k) => name.startsWith(`${k.id}_`));
}

const grantCache = new Map<string, { toolsets: Set<string>; at: number }>();
const GRANT_CACHE_MS = 60_000;

/** Toolset ids granted to the user and configured on this deployment. Fails closed. */
export async function grantedToolsets(db: Queryable, userId: string | undefined | null): Promise<PrivateToolset[]> {
  const all = configuredToolsets();
  if (!userId || all.size === 0) return [];
  let hit = grantCache.get(userId);
  if (!hit || Date.now() - hit.at >= GRANT_CACHE_MS) {
    let ids = new Set<string>();
    try {
      const r = await db.query(
        `SELECT toolset FROM private_tool_grants WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );
      ids = new Set(r.rows.map((row) => String(row.toolset)));
    } catch (e: any) {
      logger.warn('[PrivateTools] Grant lookup failed, treating as no grant', { error: e.message });
    }
    hit = { toolsets: ids, at: Date.now() };
    grantCache.set(userId, hit);
  }
  return [...hit.toolsets].map((id) => all.get(id)).filter((t): t is PrivateToolset => Boolean(t));
}

export async function privateToolDefinitionsFor(db: Queryable, userId: string | undefined | null): Promise<ToolDefinition[]> {
  return (await grantedToolsets(db, userId)).flatMap((t) => t.getToolDefinitions());
}

/**
 * Run a private tool for the user, or return null when the user may not see it.
 * Callers answer null exactly like an unknown tool, so the toolset's existence is not leaked.
 */
export async function executePrivateTool(
  db: Queryable,
  userId: string | undefined | null,
  name: string,
  args: Record<string, any>
): Promise<PrivateToolResult | null> {
  const toolset = (await grantedToolsets(db, userId)).find((t) => t.toolNames().includes(name));
  if (!toolset) return null;
  return toolset.execute(name, args);
}
