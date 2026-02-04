#!/usr/bin/env node

/**
 * SecondLayer MCP Launcher
 * Loads configuration from .env file and starts MCP server
 * Redirects logs to stderr to avoid conflicts with STDIO protocol
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Get package directory
const packageDir = path.join(__dirname, '..');
const envFile = path.join(packageDir, '.env');

// Load .env file if exists
if (fs.existsSync(envFile)) {
  const envContent = fs.readFileSync(envFile, 'utf8');
  const envVars = {};

  envContent.split('\n').forEach(line => {
    // Skip comments and empty lines
    if (line.trim() && !line.trim().startsWith('#')) {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        envVars[key.trim()] = valueParts.join('=').trim();
      }
    }
  });

  // Merge with existing env
  Object.assign(process.env, envVars);
}

// Force silent logging for MCP STDIO mode
process.env.LOG_LEVEL = 'silent';
process.env.MCP_STDIO_MODE = 'true';

// Start MCP server
const mcpServer = path.join(packageDir, 'dist', 'index.js');

// Spawn with proper stdio handling
// stdin: pipe (for MCP input)
// stdout: pipe (for MCP output only)
// stderr: inherit (for logs)
const child = spawn('node', [mcpServer], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env
});

// Forward stdin/stdout for MCP protocol
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);

// Handle errors
child.on('error', (error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code || 0);
});

// Handle parent process signals
process.on('SIGINT', () => {
  child.kill('SIGINT');
});

process.on('SIGTERM', () => {
  child.kill('SIGTERM');
});
