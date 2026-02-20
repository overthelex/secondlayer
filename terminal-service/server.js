'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const PORT = parseInt(process.env.TERMINAL_PORT || '3010', 10);
const CWD = process.env.TERMINAL_CWD || '/workspace/mcp_backend';
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '10', 10);

let activeSessions = 0;

// Build env for bash: pass all container env vars through
function buildEnv() {
  const env = Object.assign({}, process.env);
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

const httpServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', sessions: activeSessions, maxSessions: MAX_SESSIONS }));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  if (activeSessions >= MAX_SESSIONS) {
    ws.send(JSON.stringify({ type: 'error', data: `Max ${MAX_SESSIONS} sessions reached` }));
    ws.close(4029, 'Too many sessions');
    return;
  }

  activeSessions++;
  console.log(`[terminal-service] Session opened. Active: ${activeSessions}`);

  let cols = 120;
  let rows = 30;

  const ptyProcess = pty.spawn('bash', [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: CWD,
    env: buildEnv(),
  });

  ptyProcess.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'output', data }));
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', exitCode }));
      ws.close();
    }
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input' && typeof msg.data === 'string') {
        ptyProcess.write(msg.data);
      } else if (msg.type === 'resize') {
        const newCols = Math.max(1, Math.min(500, parseInt(msg.cols, 10) || 80));
        const newRows = Math.max(1, Math.min(200, parseInt(msg.rows, 10) || 24));
        ptyProcess.resize(newCols, newRows);
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on('close', () => {
    activeSessions--;
    console.log(`[terminal-service] Session closed. Active: ${activeSessions}`);
    try { ptyProcess.kill(); } catch { /* already dead */ }
  });

  ws.on('error', (err) => {
    console.error('[terminal-service] WebSocket error:', err.message);
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[terminal-service] Terminal service on port ${PORT}`);
  console.log(`[terminal-service] Default CWD: ${CWD}, Max sessions: ${MAX_SESSIONS}`);
});
