#!/usr/bin/env node

/**
 * Check environment configuration
 * Run: node check-env.js
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const envPath = join(__dirname, '.env');
const envExamplePath = join(__dirname, '.env.example');

console.log('\n🔍 SecondLayer Frontend - Environment Check\n');
console.log('━'.repeat(50));

// Check .env file exists
if (!existsSync(envPath)) {
  console.log('❌ .env file NOT FOUND');
  console.log('   Create: cp .env.example .env');
  console.log('   Then edit .env and add your API key');
  process.exit(1);
}

console.log('✅ .env file exists');

// Read .env
const envContent = readFileSync(envPath, 'utf-8');
const lines = envContent.split('\n').filter(line => 
  line.trim() && !line.trim().startsWith('#')
);

const config = {};
lines.forEach(line => {
  const [key, ...valueParts] = line.split('=');
  config[key.trim()] = valueParts.join('=').trim();
});

console.log('\n📋 Current Configuration:\n');

// Check API URL
const apiUrl = config.VITE_API_URL;
if (apiUrl) {
  console.log(`✅ VITE_API_URL: ${apiUrl}`);
} else {
  console.log('⚠️  VITE_API_URL: NOT SET');
}

// Check API Key
const apiKey = config.VITE_SECONDARY_LAYER_KEY;
if (apiKey && apiKey.length > 0) {
  const masked = apiKey.substring(0, 8) + '***' + apiKey.substring(apiKey.length - 4);
  console.log(`✅ VITE_SECONDARY_LAYER_KEY: ${masked} (${apiKey.length} chars)`);
} else {
  console.log('❌ VITE_SECONDARY_LAYER_KEY: NOT SET OR EMPTY');
  console.log('   This is required for API authentication!');
  console.log('   Edit .env file and add your key.');
}

console.log('\n' + '━'.repeat(50));

// Final verdict
if (apiUrl && apiKey && apiKey.length > 0) {
  console.log('\n✅ Configuration looks good!');
  console.log('   You can run: npm run dev\n');
} else {
  console.log('\n⚠️  Configuration incomplete!');
  console.log('   Please edit .env file and add missing values.\n');
  console.log('Example .env content:');
  console.log('━'.repeat(50));
  if (existsSync(envExamplePath)) {
    console.log(readFileSync(envExamplePath, 'utf-8'));
  }
  console.log('━'.repeat(50));
  process.exit(1);
}

console.log('\n💡 Tips:');
console.log('   - After changing .env, restart dev server');
console.log('   - Check browser DevTools → Network → Headers');
console.log('   - Authorization header should be present\n');
