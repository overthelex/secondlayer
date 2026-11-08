import { loadTenant, setTenant } from '../tenant';
import '../tenant/pl';
import { renderAdvocatesPage } from '../views/advocates';
import { mapPracticeTag, nraLabelToCode, PL_PRACTICES } from '../tenant/pl-practices';

const pl = loadTenant({ ATTORNEY_CRM_TENANT: 'pl' });
beforeEach(() => setTenant(pl));
afterEach(() => setTenant(loadTenant({})));

test('pl tenant basics', () => {
  expect(pl.lang).toBe('en');
  expect(pl.timeZone).toBe('Europe/Warsaw');
  expect(pl.schema).toBe('attorney_crm_pl');
  expect(pl.sqlFiles).toEqual(['002_crm_core.sql', '004_contact_overrides.sql', '005_suppression.sql', 'pl/001_pl_lawyers.sql']);
  expect(pl.derivedPractices).toBe(false);
  expect(PL_PRACTICES).toHaveLength(27);
  expect(mapPracticeTag('zamówienia publiczne')).toBe('public_procurement');
  expect(mapPracticeTag('coś innego')).toBeNull();
  expect(nraLabelToCode('Prawo i postępowanie karne ')).toBe('criminal');
  expect(pl.practiceLabel('civil')).toBe('Civil law and procedure');
});

test('renders "No public contact" when phone and email are null, and the profession column', () => {
  const row = {
    sourceId: 'radca:WR-4293', fullName: 'ABBATELLI Wioletta', familyName: 'ABBATELLI', firstName: 'Wioletta', patronymic: '', status: 'active',
    statusDescription: null, email: null, phone: null, workAddress: null, city: 'WROCŁAW', region: 'OIRP WROCŁAW', orgForms: null, raName: null,
    certificateNum: 'WR-4293', certificateDate: null, decisionNum: null, decisionDate: null, authorityName: null, stage: 'new', nextContactAt: null,
    manualPractices: [], lastContact: null, kindCases: 0, kinds: [], profession: 'radca', declaredPractices: ['civil'], practiceTagsRaw: ['cywilne'],
    profileUrl: null, directoryUrl: null,
  } as any;
  const page = renderAdvocatesPage({ rows: [row], total: 1, page: 1, pageSize: 50, filters: {}, cities: [], regions: [], user: { id: 1, email: 'x', displayName: '' } as any });
  expect(page).toContain('No public contact');
  expect(page).toContain('Radca prawny');
  expect(page).toContain('Civil law and procedure');
  expect(page).not.toContain('Справ');
  expect(page).not.toContain('>Cases<');
  expect(page).toContain('<html lang="en">');
  expect(page).toContain('logo-lawrider.png');
});
