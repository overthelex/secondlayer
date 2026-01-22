#!/usr/bin/env ts-node

import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(__dirname, '../.env.production') });

/**
 * Generate JWT Token for MCP Client Authentication
 *
 * Usage:
 *   ts-node scripts/generate-jwt-token.ts [clientId] [expiresIn]
 *
 * Arguments:
 *   clientId    - Identifier for the client (default: "remote-client")
 *   expiresIn   - Token expiration (default: "365d" = 1 year)
 *                 Examples: "7d", "30d", "1y", "never"
 */

function generateToken(clientId: string, expiresIn: string): string {
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    console.error('❌ Error: JWT_SECRET not found in .env.production');
    console.error('Please add JWT_SECRET to your .env.production file');
    process.exit(1);
  }

  const payload = {
    sub: clientId,
    iat: Math.floor(Date.now() / 1000),
  };

  const options: jwt.SignOptions = {
    issuer: 'secondlayer-mcp',
  };

  // Add expiration unless "never" is specified
  if (expiresIn !== 'never') {
    options.expiresIn = expiresIn;
  }

  const token = jwt.sign(payload, jwtSecret, options);

  return token;
}

function main() {
  const args = process.argv.slice(2);
  const clientId = args[0] || 'remote-client';
  const expiresIn = args[1] || '365d';

  console.log('');
  console.log('🔑 SecondLayer MCP - JWT Token Generator');
  console.log('=========================================');
  console.log('');

  try {
    const token = generateToken(clientId, expiresIn);

    console.log(`Client ID:      ${clientId}`);
    console.log(`Expires In:     ${expiresIn === 'never' ? 'Never' : expiresIn}`);
    console.log('');
    console.log('🎫 Generated Token:');
    console.log('');
    console.log(token);
    console.log('');
    console.log('📋 MCP Client Configuration:');
    console.log('');
    console.log('{');
    console.log('  "mcpServers": {');
    console.log('    "SecondLayerMCP": {');
    console.log('      "url": "https://mcp.legal.org.ua/v1/sse",');
    console.log('      "headers": {');
    console.log(`        "Authorization": "Bearer ${token}"`);
    console.log('      }');
    console.log('    }');
    console.log('  }');
    console.log('}');
    console.log('');
    console.log('✅ Copy the configuration above to your MCP client config');
    console.log('');

    // Decode and show token details
    const decoded = jwt.decode(token) as any;
    if (decoded) {
      console.log('🔍 Token Details:');
      console.log(`   Subject (sub):  ${decoded.sub}`);
      console.log(`   Issued At (iat): ${new Date(decoded.iat * 1000).toISOString()}`);
      if (decoded.exp) {
        console.log(`   Expires At (exp): ${new Date(decoded.exp * 1000).toISOString()}`);
      } else {
        console.log('   Expires At (exp): Never');
      }
      console.log(`   Issuer (iss):    ${decoded.iss || 'N/A'}`);
      console.log('');
    }
  } catch (error: any) {
    console.error('❌ Error generating token:', error.message);
    process.exit(1);
  }
}

main();
