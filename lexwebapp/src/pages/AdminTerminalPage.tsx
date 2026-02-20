/**
 * Admin Terminal Page
 * Provides a real interactive bash terminal for admins (AWS CloudShell style)
 * Uses xterm.js over WebSocket + PTY on the backend
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

const STATUS_COLORS: Record<ConnectionStatus, string> = {
  connecting: 'bg-yellow-400',
  connected: 'bg-green-400',
  disconnected: 'bg-gray-400',
  error: 'bg-red-500',
};

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connecting: 'Підключення...',
  connected: 'Підключено',
  disconnected: 'Відключено',
  error: 'Помилка',
};

export function AdminTerminalPage() {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');

  const connect = useCallback(() => {
    // Clean up existing WS
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    const token = localStorage.getItem('auth_token');
    if (!token) {
      setStatus('error');
      termRef.current?.writeln('\r\n\x1b[31mError: No auth token found. Please log in again.\x1b[0m');
      return;
    }

    const apiUrl = import.meta.env.VITE_API_URL || 'https://stage.legal.org.ua';
    // Convert http(s):// to ws(s)://
    const wsUrl = apiUrl.replace(/^http/, 'ws') + '/api/admin/terminal?token=' + encodeURIComponent(token);

    setStatus('connecting');
    termRef.current?.writeln('\r\n\x1b[33mConnecting to terminal...\x1b[0m\r\n');

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      // Send initial resize
      if (fitAddonRef.current && termRef.current) {
        fitAddonRef.current.fit();
        ws.send(JSON.stringify({
          type: 'resize',
          cols: termRef.current.cols,
          rows: termRef.current.rows,
        }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output') {
          termRef.current?.write(msg.data);
        } else if (msg.type === 'exit') {
          termRef.current?.writeln(`\r\n\x1b[33mProcess exited with code ${msg.exitCode}\x1b[0m`);
          setStatus('disconnected');
        } else if (msg.type === 'error') {
          termRef.current?.writeln(`\r\n\x1b[31mError: ${msg.data}\x1b[0m`);
          setStatus('error');
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      setStatus((prev) => prev === 'connected' ? 'disconnected' : prev);
    };

    ws.onerror = () => {
      setStatus('error');
      termRef.current?.writeln('\r\n\x1b[31mWebSocket connection error\x1b[0m');
    };
  }, []);

  // Initialize terminal
  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", "Menlo", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#e6edf3',
        cursorAccent: '#0d1117',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
        selectionBackground: '#264f78',
      },
      scrollback: 5000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(terminalRef.current);

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Fit after a tick
    setTimeout(() => fitAddon.fit(), 0);

    // Forward terminal input to WebSocket
    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Auto-connect
    connect();

    return () => {
      wsRef.current?.close();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle container resize
  useEffect(() => {
    const container = terminalRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      if (fitAddonRef.current && termRef.current) {
        fitAddonRef.current.fit();
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'resize',
            cols: termRef.current.cols,
            rows: termRef.current.rows,
          }));
        }
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const handleReconnect = () => {
    termRef.current?.clear();
    connect();
  };

  return (
    <div className="flex flex-col h-full bg-[#0d1117]">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-[#161b22] border-b border-[#30363d] shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-[#ff5f56]" />
            <div className="w-3 h-3 rounded-full bg-[#ffbd2e]" />
            <div className="w-3 h-3 rounded-full bg-[#27c93f]" />
          </div>
          <span className="text-[#8b949e] text-sm font-mono">bash — Admin Terminal</span>
        </div>
        <div className="flex items-center gap-3">
          {/* Status indicator */}
          <div className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full ${STATUS_COLORS[status]} ${status === 'connecting' ? 'animate-pulse' : ''}`} />
            <span className="text-[#8b949e] text-xs">{STATUS_LABELS[status]}</span>
          </div>
          {/* Reconnect button */}
          <button
            onClick={handleReconnect}
            className="text-xs px-3 py-1 rounded bg-[#21262d] text-[#c9d1d9] hover:bg-[#30363d] border border-[#30363d] hover:border-[#8b949e] transition-colors"
          >
            Reconnect
          </button>
        </div>
      </div>

      {/* Terminal container */}
      <div
        ref={terminalRef}
        className="flex-1 overflow-hidden"
        style={{ padding: '8px' }}
      />
    </div>
  );
}
