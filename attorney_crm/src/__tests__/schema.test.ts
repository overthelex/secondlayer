import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { applySchema } from '../schema';

const sqlDir = path.join(__dirname, '../../sql');
const sha = (f: string) => createHash('sha256').update(fs.readFileSync(path.join(sqlDir, f), 'utf8')).digest('hex');

// Records what the pool saw; `recorded` maps filename → stored sha256 (null = recorded without one).
function fakePool(calls: string[], recorded: Map<string, string | null>) {
  const client = {
    release: () => calls.push('RELEASE'),
    query: async (text: string, values?: unknown[]) => {
      calls.push(text);
      if (text.includes('SELECT filename, sha256 FROM attorney_crm_schema_version')) {
        const rows = [...recorded].map(([filename, sha256]) => ({ filename, sha256 }));
        return { rows, rowCount: rows.length };
      }
      if (text.includes('INSERT INTO attorney_crm_schema_version')) recorded.set(String(values?.[0]), String(values?.[1]));
      return { rows: [], rowCount: 0 };
    },
  };
  return { connect: async () => client, query: async () => { throw new Error('pool.query must not be used for the transaction'); } };
}

test('applies unrecorded files and skips recorded ones whose content hash matches', async () => {
  const calls: string[] = [];
  const recorded = new Map([['001_practice_derivation.sql', sha('001_practice_derivation.sql')], ['003_ctid_backfill.sql', sha('003_ctid_backfill.sql')], ['004_contact_overrides.sql', sha('004_contact_overrides.sql')]]);
  const applied = await applySchema(fakePool(calls, recorded) as any, sqlDir);
  expect(applied).toEqual(['002_crm_core.sql']);
  expect(calls.some((q) => q.includes('CREATE TABLE IF NOT EXISTS attorney_crm_schema_version'))).toBe(true);
  expect(calls.some((q) => q.includes('attorney_crm_practice_cases'))).toBe(false);
  expect(calls.some((q) => q.includes('lock_timeout'))).toBe(true);
  expect(recorded.get('002_crm_core.sql')).toBe(sha('002_crm_core.sql'));
});

test('re-applies a recorded file whose content changed or was recorded without a hash', async () => {
  const calls: string[] = [];
  const recorded = new Map<string, string | null>([['001_practice_derivation.sql', 'stale'], ['002_crm_core.sql', null], ['003_ctid_backfill.sql', sha('003_ctid_backfill.sql')], ['004_contact_overrides.sql', sha('004_contact_overrides.sql')]]);
  expect(await applySchema(fakePool(calls, recorded) as any, sqlDir)).toEqual(['001_practice_derivation.sql', '002_crm_core.sql']);
});

test('nothing runs when every hash matches', async () => {
  const calls: string[] = [];
  const recorded = new Map([['001_practice_derivation.sql', sha('001_practice_derivation.sql')], ['002_crm_core.sql', sha('002_crm_core.sql')], ['003_ctid_backfill.sql', sha('003_ctid_backfill.sql')], ['004_contact_overrides.sql', sha('004_contact_overrides.sql')]]);
  expect(await applySchema(fakePool(calls, recorded) as any, sqlDir)).toEqual([]);
  expect(calls.filter((q) => q === 'BEGIN')).toHaveLength(0);
});

test('fresh database applies every file in lexical order inside transactions on one client', async () => {
  const calls: string[] = [];
  const applied = await applySchema(fakePool(calls, new Map()) as any, sqlDir);
  expect(applied).toEqual(['001_practice_derivation.sql', '002_crm_core.sql', '003_ctid_backfill.sql', '004_contact_overrides.sql']);
  const i1 = calls.findIndex((q) => q.includes('attorney_crm_practice_cases'));
  const i2 = calls.findIndex((q) => q.includes('attorney_crm_users'));
  expect(i1).toBeLessThan(i2);
  expect(calls.filter((q) => q === 'BEGIN').length).toBe(4);
  expect(calls.filter((q) => q === 'COMMIT').length).toBe(4);
  expect(calls[calls.length - 1]).toBe('RELEASE');
});

test('pl tenant applies 002, 004 and pl/001 only, inside the schema', async () => {
  const calls: string[] = [];
  const applied = await applySchema(fakePool(calls, new Map()) as any, sqlDir, ['002_crm_core.sql', '004_contact_overrides.sql', 'pl/001_pl_lawyers.sql'], 'attorney_crm_pl');
  expect(applied).toEqual(['002_crm_core.sql', '004_contact_overrides.sql', 'pl/001_pl_lawyers.sql']);
  expect(calls[0]).toBe('CREATE SCHEMA IF NOT EXISTS attorney_crm_pl');
  expect(calls.some((c) => c.includes('edrsr_'))).toBe(false);
  expect(calls.some((c) => c.includes('CREATE TABLE IF NOT EXISTS public.pl_lawyers'))).toBe(true);
});
