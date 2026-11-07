import path from 'path';
import { applySchema } from '../schema';

function fakePool(calls: string[], recorded: Set<string>) {
  const client = {
    release: () => calls.push('RELEASE'),
    query: async (text: string, values?: unknown[]) => {
      calls.push(text);
      if (text.includes('SELECT filename FROM attorney_crm_schema_version')) {
        return { rows: [...recorded].map((filename) => ({ filename })), rowCount: recorded.size };
      }
      if (text.includes('INSERT INTO attorney_crm_schema_version')) recorded.add(String(values?.[0]));
      return { rows: [], rowCount: 0 };
    },
  };
  return { connect: async () => client, query: async () => { throw new Error('pool.query must not be used for the transaction'); } };
}

test('applies files in order, records them, skips recorded ones, always re-applies 001', async () => {
  const calls: string[] = [];
  const recorded = new Set(['002_crm_core.sql']);
  const applied = await applySchema(fakePool(calls, recorded) as any, path.join(__dirname, '../../sql'));
  expect(applied).toEqual(['001_practice_derivation.sql']);
  expect(calls.some((q) => q.includes('CREATE TABLE IF NOT EXISTS attorney_crm_schema_version'))).toBe(true);
  expect(calls.some((q) => q.includes('CREATE TABLE IF NOT EXISTS attorney_crm_users'))).toBe(false);
});

test('fresh database applies every file in lexical order inside transactions', async () => {
  const calls: string[] = [];
  const applied = await applySchema(fakePool(calls, new Set()) as any, path.join(__dirname, '../../sql'));
  expect(applied).toEqual(['001_practice_derivation.sql', '002_crm_core.sql']);
  const i1 = calls.findIndex((q) => q.includes('attorney_crm_practice_cases'));
  const i2 = calls.findIndex((q) => q.includes('attorney_crm_users'));
  expect(i1).toBeLessThan(i2);
  expect(calls.filter((q) => q === 'BEGIN').length).toBe(2);
  expect(calls.filter((q) => q === 'COMMIT').length).toBe(2);
  expect(calls[calls.length - 1]).toBe('RELEASE');
});
