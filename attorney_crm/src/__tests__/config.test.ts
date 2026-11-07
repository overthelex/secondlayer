import { loadConfig } from '../config';

test('defaults port to 3020 and reads the secret', () => {
  const c = loadConfig({ DATABASE_URL: 'postgres://x', ATTORNEY_CRM_SESSION_SECRET: 's' });
  expect(c.port).toBe(3020);
  expect(c.sessionSecret).toBe('s');
  expect(c.databaseUrl).toBe('postgres://x');
  expect(c.derivationLagDays).toBe(30);
  expect(c.derivationBatch).toBe(2000);
  expect(c.derivationEnabled).toBe(true);
});

test('reads overrides', () => {
  const c = loadConfig({
    DATABASE_URL: 'postgres://x', ATTORNEY_CRM_SESSION_SECRET: 's', PORT: '4000',
    ATTORNEY_CRM_DERIVATION_LAG_DAYS: '10', ATTORNEY_CRM_DERIVATION_BATCH: '500', ATTORNEY_CRM_DERIVATION: 'off',
  });
  expect(c.port).toBe(4000);
  expect(c.derivationLagDays).toBe(10);
  expect(c.derivationBatch).toBe(500);
  expect(c.derivationEnabled).toBe(false);
});

test('fails fast without the session secret', () => {
  expect(() => loadConfig({ DATABASE_URL: 'postgres://x' })).toThrow('ATTORNEY_CRM_SESSION_SECRET is required');
});

test('fails fast without DATABASE_URL', () => {
  expect(() => loadConfig({ ATTORNEY_CRM_SESSION_SECRET: 's' })).toThrow('DATABASE_URL is required');
});
