/**
 * Admin Terminal WebSocket Route
 * Provides a real PTY bash terminal for admins over WebSocket (AWS CloudShell style)
 */

import { IncomingMessage } from 'http';
import { Server as WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import jwt from 'jsonwebtoken';
import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';
import type { Server as HttpServer } from 'http';

const MAX_SESSIONS_PER_ADMIN = 2;

// Track active sessions per admin
const activeSessions = new Map<string, Set<WebSocket>>();

const SENSITIVE_ENV_VARS = [
  'OPENAI_API_KEY',
  'SECONDARY_LAYER_KEYS',
  'ZAKONONLINE_API_TOKEN',
  'JWT_SECRET',
  'POSTGRES_PASSWORD',
  'REDIS_PASSWORD',
  'STRIPE_SECRET_KEY',
  'ANTHROPIC_API_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'FONDY_SECRET_KEY',
];

function buildPtyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!SENSITIVE_ENV_VARS.includes(key) && value !== undefined) {
      env[key] = value;
    }
  }
  // Ensure sensible terminal defaults
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

async function verifyAdminFromToken(
  token: string,
  db: Database
): Promise<{ id: string; email: string } | null> {
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;

    const decoded = jwt.verify(token, secret) as any;
    const userId = decoded?.id || decoded?.userId || decoded?.sub;
    if (!userId) return null;

    const result = await db.query(
      'SELECT id, email, is_admin, role FROM users WHERE id = $1',
      [userId]
    );
    const user = result.rows[0];
    if (!user) return null;
    if (!user.is_admin && user.role !== 'administrator') return null;

    return { id: String(user.id), email: user.email };
  } catch {
    return null;
  }
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

export function attachTerminalWebSocket(httpServer: HttpServer, db: Database): void {
  const wss = new WebSocketServer({ noServer: true });

  // Upgrade only for /api/admin/terminal
  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    if (url.pathname !== '/api/admin/terminal') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const ip = getClientIp(req);
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
      ws.send(JSON.stringify({ type: 'error', data: 'Authentication required' }));
      ws.close(4001, 'No token');
      return;
    }

    const admin = await verifyAdminFromToken(token, db);
    if (!admin) {
      ws.send(JSON.stringify({ type: 'error', data: 'Admin access required' }));
      ws.close(4003, 'Forbidden');
      logger.warn('Terminal: rejected non-admin WebSocket connection', { ip });
      return;
    }

    // Enforce session limit
    if (!activeSessions.has(admin.id)) {
      activeSessions.set(admin.id, new Set());
    }
    const sessions = activeSessions.get(admin.id)!;
    if (sessions.size >= MAX_SESSIONS_PER_ADMIN) {
      ws.send(JSON.stringify({ type: 'error', data: `Max ${MAX_SESSIONS_PER_ADMIN} terminal sessions allowed` }));
      ws.close(4029, 'Too many sessions');
      return;
    }

    sessions.add(ws);
    logger.info('Terminal: admin session opened', { adminId: admin.id, email: admin.email, ip });

    const cwd = process.env.TERMINAL_CWD || '/home/vovkes/SecondLayer';

    // Spawn PTY
    const ptyProcess = pty.spawn('bash', [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: buildPtyEnv(),
    });

    // PTY output → WebSocket
    ptyProcess.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data }));
      }
    });

    // PTY exit → notify client
    ptyProcess.onExit(({ exitCode }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', exitCode }));
        ws.close();
      }
    });

    // WebSocket message → PTY input or resize
    ws.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'input' && typeof msg.data === 'string') {
          ptyProcess.write(msg.data);
        } else if (msg.type === 'resize') {
          const cols = Math.max(1, Math.min(500, parseInt(msg.cols, 10) || 80));
          const rows = Math.max(1, Math.min(200, parseInt(msg.rows, 10) || 24));
          ptyProcess.resize(cols, rows);
        }
      } catch {
        // ignore malformed messages
      }
    });

    // Cleanup on disconnect
    ws.on('close', () => {
      sessions.delete(ws);
      if (sessions.size === 0) activeSessions.delete(admin.id);
      try { ptyProcess.kill(); } catch { /* already dead */ }
      logger.info('Terminal: admin session closed', { adminId: admin.id, email: admin.email, ip });
    });

    ws.on('error', (err) => {
      logger.error('Terminal: WebSocket error', { adminId: admin.id, error: err.message });
    });
  });

  logger.info('Terminal: WebSocket server attached at /api/admin/terminal');
}
