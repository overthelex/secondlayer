#!/usr/bin/env node

/**
 * Minimal SecondLayer MCP STDIO Launcher
 * Suppresses ALL console output to avoid EPIPE errors
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Redirect console to /dev/null to suppress all output
const devNull = fs.openSync('/dev/null', 'w');
console.log = () => {};
console.error = () => {};
console.warn = () => {};
console.info = () => {};
console.debug = () => {};

// Get package directory
const packageDir = path.join(__dirname, '..');
const envFile = path.join(packageDir, '.env');

// Load .env file
if (fs.existsSync(envFile)) {
  const envContent = fs.readFileSync(envFile, 'utf8');
  envContent.split('\n').forEach(line => {
    if (line.trim() && !line.trim().startsWith('#')) {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        process.env[key.trim()] = valueParts.join('=').trim();
      }
    }
  });
}

// Force silent mode
process.env.LOG_LEVEL = 'silent';
process.env.MCP_STDIO_MODE = 'true';
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

// Start MCP server with stdin/stdout for MCP protocol
const mcpServer = path.join(packageDir, 'dist', 'index.js');

const child = spawn('node', [mcpServer], {
  stdio: ['pipe', 'pipe', devNull], // stderr to /dev/null
  env: process.env
});

// Forward MCP protocol I/O
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);

// Handle process lifecycle
child.on('error', () => process.exit(1));
child.on('exit', (code) => process.exit(code || 0));

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
