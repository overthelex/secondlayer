/**
 * Who may call which tool from outside the process.
 *
 * Every external door into the ToolRegistry (REST /api/tools/*, MCP /v1/mcp, /v1/sse,
 * /v2/mcp, legacy /sse) asks this module before executing. In-process callers (chat
 * pipeline, workflow executor) call the registry directly and are not affected.
 *
 * Three rules:
 *  1. Operator tools (imports, A/B experiments, workflow memory, Nextcloud, bulk ingest,
 *     on-demand vectorisation, credential-leak OSINT) are admin-only on every door.
 *     `nextcloud_upload` reads an arbitrary container path, so a non-admin caller could
 *     otherwise ship `/proc/self/environ` to Nextcloud and share it publicly.
 *  2. A database API key (`sl_...`) is a client credential for the public product, so it
 *     reaches only the curated v2 set (V2_TOOL_NAMES), whichever door it comes through.
 *  3. Vault tools always run as the caller: the `userId` argument is overwritten, never
 *     taken from the request (IDOR otherwise: any document by id, or another account's
 *     tags via auto_tag_vault_documents).
 *
 * Name checks are anchored whitelists/prefixes on the single tool name, never substring
 * matches over a joined list.
 */
import { V2_TOOL_NAMES } from './curated-mcp-tools.js';

const ADMIN_ONLY_TOOLS = new Set<string>([
  'start_import',
  'cancel_import',
  'get_import_status',
  'list_import_sources',
  'bulk_ingest_court_decisions',
  'bulk_ingest_court_sessions',
  'vectorize_edrsr_results',
  'search_credentials',
  'search_github_leaks',
  'osint_search_credentials',
  'osint_search_github_leaks',
]);

const ADMIN_ONLY_PREFIXES = ['nextcloud_', 'ab_', 'workflow_memory_'];

/** Tools whose `userId` argument selects whose vault is touched. */
export const VAULT_TOOLS = new Set<string>([
  'store_document',
  'get_document',
  'list_documents',
  'semantic_search',
  'list_folders',
  'delete_document',
  'update_document',
  'auto_tag_vault_documents',
]);

export function isAdminOnlyTool(name: string): boolean {
  return ADMIN_ONLY_TOOLS.has(name) || ADMIN_ONLY_PREFIXES.some((p) => name.startsWith(p));
}

export interface ToolCaller {
  /** users.is_admin or role 'administrator'. */
  isAdmin: boolean;
  /** True when authenticated with a database API key (sl_...), not JWT/OAuth/legacy env key. */
  viaDbApiKey: boolean;
}

export type ToolAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: 'admin_only' | 'api_key_scope'; message: string };

export function checkToolAccess(name: string, caller: ToolCaller): ToolAccessDecision {
  if (caller.isAdmin) return { allowed: true };
  if (isAdminOnlyTool(name)) {
    return { allowed: false, reason: 'admin_only', message: `Інструмент '${name}' недоступний для цього облікового запису.` };
  }
  if (caller.viaDbApiKey && !V2_TOOL_NAMES.has(name)) {
    return { allowed: false, reason: 'api_key_scope', message: `Інструмент '${name}' недоступний для API-ключа. Доступні інструменти: tools/list на /api/v2/mcp.` };
  }
  return { allowed: true };
}

/**
 * Bind vault tools to the caller. Without a caller (legacy env key) the configured
 * DEFAULT_VAULT_USER_ID is used, else the nil UUID, which owns nothing. Never empty:
 * get_document treats a falsy userId as "no owner check".
 */
export const NO_VAULT_OWNER = '00000000-0000-0000-0000-000000000000';

export function scopeVaultArgs<T extends Record<string, any>>(name: string, args: T, userId: string | undefined | null): T {
  if (!VAULT_TOOLS.has(name)) return args;
  return { ...args, userId: userId || process.env.DEFAULT_VAULT_USER_ID || NO_VAULT_OWNER };
}

/** Admin flag for a user id, cached briefly: MCP sessions carry only the id. */
const adminCache = new Map<string, { isAdmin: boolean; at: number }>();
const ADMIN_CACHE_MS = 60_000;

export async function isAdminUser(
  db: { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> },
  userId: string | undefined | null
): Promise<boolean> {
  if (!userId) return false;
  const hit = adminCache.get(userId);
  if (hit && Date.now() - hit.at < ADMIN_CACHE_MS) return hit.isAdmin;
  try {
    const r = await db.query(
      `SELECT (COALESCE(is_admin, false) OR role = 'administrator') AS admin FROM users WHERE id = $1`,
      [userId]
    );
    const isAdmin = Boolean(r.rows[0]?.admin);
    adminCache.set(userId, { isAdmin, at: Date.now() });
    return isAdmin;
  } catch {
    return false; // fail closed: an unknown caller is not an admin
  }
}
