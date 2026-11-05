/**
 * A database API key (`sl_...`) is a client credential for the public product: it reaches
 * MCP on /api/v2/mcp and nothing else. Mount this right after `dualAuth` on every REST
 * surface that accepts API keys for operator or service-to-service use (worker heartbeats,
 * internal stats, the tool catalogue, the substrate API).
 *
 * Passed through: JWT users, admin users, and legacy env keys (no user attached), which is
 * how the EC2 workers and internal services authenticate. Refused: a DB key of a non-admin
 * user, with a 403 and an `endpoint_denied` row in mcp_access_log for the security alarm.
 */
import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from './dual-auth.js';
import { isAdminUser } from '../api/tool-access-policy.js';
import { callerFromHeaders, logMcpAccess } from '../services/mcp-access-log.js';
import { logger } from '../utils/logger.js';

type Db = { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> };

export function createClientKeyGuard(db: Db) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const viaDbApiKey = req.authType === 'apikey' && Boolean(req.user);
    if (!viaDbApiKey) { next(); return; }

    const user = req.user as any;
    const isAdmin = user.is_admin === true || user.role === 'administrator' || await isAdminUser(db, user.id);
    if (isAdmin) { next(); return; }

    const path = req.originalUrl.split('?')[0].slice(0, 200);
    logger.warn('[ClientKeyGuard] API key refused off v2', { userId: user.id, path });
    logMcpAccess(db, {
      transport: 'rest',
      outcome: 'endpoint_denied',
      authMethod: 'api_key',
      userId: user.id,
      token: (req as any).clientKey,
      caller: callerFromHeaders(req.headers as any, req.ip),
      detail: `api key on ${path}`,
    });
    res.status(403).json({
      success: false,
      error: 'Forbidden',
      code: 'API_KEY_V2_ONLY',
      message: 'API-ключ дійсний лише для MCP на /api/v2/mcp.',
    });
  };
}
