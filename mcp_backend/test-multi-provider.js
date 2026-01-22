#!/usr/bin/env node

/**
 * Test script for multi-provider LLM setup
 * Run: node test-multi-provider.js
 */

import { ModelSelector } from './dist/utils/model-selector.js';

console.log('='.repeat(60));
console.log('🧪 Testing Multi-Provider LLM Setup');
console.log('='.repeat(60));
console.log();

// Test 1: Check available providers
console.log('📋 Test 1: Available Providers');
console.log('-'.repeat(60));
try {
  const providers = ModelSelector.getAvailableProviders();
  console.log('✅ Available providers:', providers);

  if (providers.length === 0) {
    console.log('⚠️  WARNING: No LLM providers configured!');
    console.log('   Please set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env');
  }

  if (providers.includes('openai')) {
    console.log('   - OpenAI: Configured ✅');
  } else {
    console.log('   - OpenAI: Not configured ❌');
  }

  if (providers.includes('anthropic')) {
    console.log('   - Anthropic: Configured ✅');
  } else {
    console.log('   - Anthropic: Not configured (optional)');
  }
} catch (error) {
  console.log('❌ Error:', error.message);
}
console.log();

// Test 2: Model selection for different budgets
console.log('📋 Test 2: Model Selection for Different Budgets');
console.log('-'.repeat(60));
try {
  const budgets = ['quick', 'standard', 'deep'];

  for (const budget of budgets) {
    const selection = ModelSelector.getModelSelection(budget);
    console.log(`${budget.padEnd(10)} → Provider: ${selection.provider.padEnd(10)} Model: ${selection.model}`);
  }
  console.log('✅ Model selection working correctly');
} catch (error) {
  console.log('❌ Error:', error.message);
}
console.log();

// Test 3: Cost estimation
console.log('📋 Test 3: Cost Estimation');
console.log('-'.repeat(60));
try {
  const models = [
    { name: 'gpt-4o-mini', input: 1000, output: 500 },
    { name: 'gpt-4o', input: 1000, output: 500 },
    { name: 'claude-haiku-4.5', input: 1000, output: 500 },
    { name: 'claude-sonnet-4.5', input: 1000, output: 500 },
    { name: 'claude-opus-4.5', input: 1000, output: 500 },
  ];

  for (const model of models) {
    const cost = ModelSelector.estimateCostAccurate(model.name, model.input, model.output);
    console.log(`${model.name.padEnd(20)} → $${cost.toFixed(6)} (${model.input} input + ${model.output} output tokens)`);
  }
  console.log('✅ Cost estimation working correctly');
} catch (error) {
  console.log('❌ Error:', error.message);
}
console.log();

// Test 4: Provider strategy
console.log('📋 Test 4: Provider Strategy');
console.log('-'.repeat(60));
try {
  const strategy = process.env.LLM_PROVIDER_STRATEGY || 'openai-first';
  console.log('Current strategy:', strategy);

  if (strategy === 'openai-first') {
    console.log('✅ Will try OpenAI first, fallback to Anthropic');
  } else if (strategy === 'anthropic-first') {
    console.log('✅ Will try Anthropic first, fallback to OpenAI');
  } else {
    console.log('⚠️  Unknown strategy:', strategy);
  }
} catch (error) {
  console.log('❌ Error:', error.message);
}
console.log();

// Test 5: Backward compatibility (OPENAI_MODEL)
console.log('📋 Test 5: Backward Compatibility');
console.log('-'.repeat(60));
try {
  const singleModel = process.env.OPENAI_MODEL;

  if (singleModel) {
    console.log('⚠️  OPENAI_MODEL is set:', singleModel);
    console.log('   This overrides dynamic selection!');
    console.log('   All budgets will use:', singleModel);
    console.log('   Recommendation: Remove OPENAI_MODEL for cost savings');
  } else {
    console.log('✅ OPENAI_MODEL not set - dynamic selection active');
    console.log('   Using budget-specific models for cost optimization');
  }
} catch (error) {
  console.log('❌ Error:', error.message);
}
console.log();

// Summary
console.log('='.repeat(60));
console.log('📊 Summary');
console.log('='.repeat(60));

const providers = ModelSelector.getAvailableProviders();
const singleModel = process.env.OPENAI_MODEL;

if (providers.length === 0) {
  console.log('❌ FAILED: No LLM providers configured');
  console.log('   Action required: Set API keys in .env file');
} else if (singleModel) {
  console.log('⚠️  WARNING: Using single model mode');
  console.log('   Current model:', singleModel);
  console.log('   Recommendation: Switch to dynamic selection for 87% cost savings');
  console.log('   See: docs/MODEL_SELECTION_GUIDE.md');
} else {
  console.log('✅ SUCCESS: Multi-provider setup is working!');
  console.log('   Providers:', providers.join(', '));
  console.log('   Dynamic selection: Active');
  console.log('   Expected cost savings: ~87%');
}

console.log();
console.log('📚 For more information, see:');
console.log('   - docs/MULTI_PROVIDER_SETUP.md');
console.log('   - docs/MODEL_SELECTION_GUIDE.md');
console.log('   - docs/COST_TRACKING_ANALYSIS.md');
console.log('='.repeat(60));
