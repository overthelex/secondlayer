import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstApiKey, loadConfig } from '../config.js';

// LEXAI-2130: compose passes the openreyestr allow-list (OPENREYESTR_API_KEYS)
// as OPENREYESTR_API_KEY. With 3 keys the whole "k1,k2,k3" string was sent as
// the Bearer token and every openreyestr sync got 401 "Invalid API key".

test('firstApiKey returns a single key unchanged', () => {
  assert.equal(firstApiKey('abc'), 'abc');
});

test('firstApiKey takes the first entry of a comma-separated list', () => {
  assert.equal(firstApiKey('k1,k2,k3'), 'k1');
  assert.equal(firstApiKey(' k1 , k2'), 'k1');
});

test('firstApiKey skips empty entries and handles missing values', () => {
  assert.equal(firstApiKey(',,k2'), 'k2');
  assert.equal(firstApiKey(''), '');
  assert.equal(firstApiKey(undefined), '');
});

test('loadConfig never sends a comma-joined key list as a Bearer token', () => {
  const saved = { ...process.env };
  try {
    process.env.OPENREYESTR_API_KEY = 'key-a,key-b,key-c';
    process.env.BACKEND_API_KEY = 'backend-1,backend-2';
    const cfg = loadConfig();
    assert.equal(cfg.openreyestrApiKey, 'key-a');
    assert.equal(cfg.backendApiKey, 'backend-1');
  } finally {
    process.env = saved;
  }
});
