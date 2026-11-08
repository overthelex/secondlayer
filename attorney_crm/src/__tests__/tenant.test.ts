import { loadTenant } from '../tenant';

test('default tenant is ua with Ukrainian strings and Kyiv time', () => {
  const t = loadTenant({});
  expect(t.id).toBe('ua');
  expect(t.timeZone).toBe('Europe/Kyiv');
  expect(t.strings.nav.today).toBe('Сьогодні');
  expect(t.brand.domain).toBe('legal.org.ua');
  expect(t.derivedPractices).toBe(true);
  expect(t.schema).toBeNull();
  expect(t.sqlFiles).toEqual(['001_practice_derivation.sql', '002_crm_core.sql', '003_ctid_backfill.sql', '004_contact_overrides.sql']);
});

test('unknown tenant fails fast', () => {
  expect(() => loadTenant({ ATTORNEY_CRM_TENANT: 'de' })).toThrow(/ATTORNEY_CRM_TENANT/);
});
