/**
 * Script to register OAuth 2.0 client for ChatGPT integration
 * Usage: npx tsx src/scripts/register-oauth-client.ts
 */

import { Database } from '../database/database.js';
import { OAuthService } from '../services/oauth-service.js';
import { logger } from '../utils/logger.js';
import dotenv from 'dotenv';

dotenv.config();

async function registerOAuthClient() {
  const db = new Database();
  const oauthService = new OAuthService(db);

  try {
    console.log('\n========================================');
    console.log('OAuth Client Registration');
    console.log('========================================\n');

    // Register ChatGPT client
    const client = await oauthService.registerClient({
      name: 'ChatGPT MCP Client',
      redirect_uris: [
        'https://chatgpt.com/aip/callback',
        'https://chat.openai.com/aip/callback',
        'http://localhost:3000/callback', // For testing
      ],
    });

    console.log('✅ OAuth Client registered successfully!\n');
    console.log('Client Details:');
    console.log('────────────────────────────────────────');
    console.log(`Client ID:     ${client.client_id}`);
    console.log(`Client Secret: ${client.client_secret}`);
    console.log(`Name:          ${client.name}`);
    console.log(`Redirect URIs: ${JSON.stringify(client.redirect_uris, null, 2)}`);
    console.log(`Created At:    ${client.created_at}`);
    console.log('────────────────────────────────────────\n');

    console.log('📝 ChatGPT Configuration:\n');
    console.log('1. Go to ChatGPT Settings → Apps → New App');
    console.log('2. Fill in the configuration:\n');
    console.log('   Name: SecondLayer Legal AI');
    console.log('   MCP Server URL: https://stage.legal.org.ua/sse');
    console.log('   Authentication: OAuth\n');
    console.log('   OAuth Settings:');
    console.log(`   - Client ID: ${client.client_id}`);
    console.log(`   - Client Secret: ${client.client_secret}`);
    console.log(`   - Authorization URL: https://stage.legal.org.ua/oauth/authorize`);
    console.log(`   - Token URL: https://stage.legal.org.ua/oauth/token`);
    console.log('   - Scopes: mcp\n');

    console.log('⚠️  IMPORTANT: Save these credentials securely!');
    console.log('The client secret cannot be retrieved later.\n');

    console.log('========================================\n');

    await db.close();
  } catch (error: any) {
    console.error('❌ Error registering OAuth client:', error.message);
    logger.error('Error in register-oauth-client script:', error);
    await db.close();
    process.exit(1);
  }
}

// Run the script
registerOAuthClient();
