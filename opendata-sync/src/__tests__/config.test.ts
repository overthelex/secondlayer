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

// LEXAI-2301: the Cyprus DRCOR register loads monthly through a script baked into this image.
test('cy_drcor: monthly script source runs load_drcor.py', async () => {
  const { ALL_SOURCES } = await import('../config.js');
  const cron = (await import('node-cron')).default;
  const s = ALL_SOURCES.find((x) => x.name === 'cy_drcor');
  assert.ok(s && s.enabled && s.target === 'script');
  assert.ok(cron.validate(s.cron));
  assert.deepEqual(s.command, ['python3', '-I', '/app/scripts/load_drcor.py']);
});

// The ДСА case-status history loader runs as a script inside this container; the old HTTP
// source points to a dataset data.gov.ua no longer serves and must stay disabled.
test('court case status: history script enabled, broken start_import source disabled', async () => {
  const { ALL_SOURCES } = await import('../config.js');
  const cron = (await import('node-cron')).default;
  const history = ALL_SOURCES.find((s) => s.name === 'court_case_status_history');
  assert.ok(history && history.enabled && history.target === 'script');
  assert.ok(history.command?.some((a) => a.endsWith('load_case_status.py')));
  assert.ok(cron.validate(history.cron));
  assert.equal(ALL_SOURCES.find((s) => s.name === 'court_case_status')?.enabled, false);
});

// LEXAI-2299: EU / UK / OFAC sanctions lists load daily through a script baked into this image.
test('intl sanctions: daily script source runs load_sanctions.py for all lists', async () => {
  const { ALL_SOURCES } = await import('../config.js');
  const cron = (await import('node-cron')).default;
  const s = ALL_SOURCES.find((x) => x.name === 'intl_sanctions');
  assert.ok(s && s.enabled && s.target === 'script');
  assert.ok(cron.validate(s.cron));
  assert.deepEqual(s.command, ['python3', '-I', '/app/scripts/load_sanctions.py', '--list', 'all']);
});

// LEXAI-2300: the ICIJ Offshore Leaks archive is checked monthly by a script baked into this image.
test('icij offshore leaks: monthly script source runs load_icij.py', async () => {
  const { ALL_SOURCES } = await import('../config.js');
  const cron = (await import('node-cron')).default;
  const s = ALL_SOURCES.find((x) => x.name === 'icij_offshore_leaks');
  assert.ok(s && s.enabled && s.target === 'script');
  assert.ok(cron.validate(s.cron));
  assert.match(s.cron, /^\d+ \d+ \d+ \* \*$/);
  assert.deepEqual(s.command, ['python3', '-I', '/app/scripts/load_icij.py']);
});
