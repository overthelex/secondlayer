import { buildContractsUpsert, CONTRACT_COLUMNS, extractContracts, normalizePhone } from '../lib/prozorro-feed';
import { cursorKey, parseBackfillArgs } from '../backfill-prozorro-contracts';

const supplier = {
  name: 'ТОВ "КОМПАНІЯ МАСШТАБ БУД"',
  identifier: { scheme: 'UA-EDR', id: '41633007', legalName: 'ТОВ "КОМПАНІЯ МАСШТАБ БУД"' },
  address: { region: 'Кіровоградська область', locality: 'м. Кропивницький', streetAddress: 'вул. Велика Перспективна, 1' },
  contactPoint: { email: 'Info@Masshtab.UA ', telephone: '097 700-92-63' },
  scale: 'micro',
};

// ≈2025+ form: the tender's contract is a stub, the supplier sits on the award.
const stubTender = {
  id: 'cedf53a96e924b17b03f2db57895f870',
  dateModified: '2026-10-02T10:00:00.000000+03:00',
  awards: [
    { id: 'aw-cancelled', status: 'cancelled', suppliers: [{ identifier: { id: '11111111' }, name: 'Інший' }] },
    { id: 'aw1', status: 'active', lotID: 'lot1', suppliers: [supplier] },
  ],
  contracts: [
    { id: '87f98ef86f764259a92c7a21882e9ee6', awardID: 'aw1', contractID: 'UA-2026-09-03-004034-a-a1', status: 'active',
      date: '2026-09-30T08:31:00+03:00', value: { amount: 2707774.0, currency: 'UAH', valueAddedTaxIncluded: false, amountNet: 2707774.0 } },
  ],
};

// ≤2024 form: the contract carries suppliers, dateSigned and period itself.
const fullTender = {
  id: 't-2022',
  dateModified: '2022-01-01T08:20:11.957580+02:00',
  awards: [{ id: 'ea32', suppliers: [{ identifier: { id: '99999999' }, name: 'Не той' }] }],
  contracts: [{
    id: 'c98b', awardID: 'ea32', contractID: 'UA-2021-12-17-018752-c-a1', contractNumber: '1', status: 'active',
    dateSigned: '2022-01-01T00:00:00+02:00',
    period: { startDate: '2022-01-01T00:00:00+02:00', endDate: '2022-12-31T23:59:59+02:00' },
    suppliers: [{ name: 'ТОВ "ДЕЛЬТА-98"', identifier: { scheme: 'UA-EDR', id: '30287372' }, contactPoint: { telephone: '+380977009263' } }],
    value: { amount: 157890.0, currency: 'UAH', valueAddedTaxIncluded: true, amountNet: 131575.0 },
  }],
};

describe('extractContracts (LEXAI-2227)', () => {
  it('resolves the supplier of a stub contract through its awardID', () => {
    const [c] = extractContracts(stubTender);
    expect(c.contract_id).toBe('87f98ef86f764259a92c7a21882e9ee6');
    expect(c.tender_id).toBe(stubTender.id);
    expect(c.supplier_edrpou).toBe('41633007');
    expect(c.supplier_name).toBe('ТОВ "КОМПАНІЯ МАСШТАБ БУД"');
    expect(c.supplier_locality).toBe('м. Кропивницький');
    expect(c.supplier_email).toBe('info@masshtab.ua');
    expect(c.supplier_phone).toBe('380977009263');
    expect(c.lot_id).toBe('lot1');
    expect(c.amount).toBe(2707774);
    expect(c.vat_included).toBe(false);
    expect(c.date_signed).toBeNull();
    expect(c.tender_date_modified).toBe(stubTender.dateModified);
    expect(Object.keys(c).sort()).toEqual([...CONTRACT_COLUMNS].sort());
  });

  it("prefers the contract's own suppliers over the award's", () => {
    const [c] = extractContracts(fullTender);
    expect(c.supplier_edrpou).toBe('30287372');
    expect(c.date_signed).toBe('2022-01-01T00:00:00+02:00');
    expect(c.period_start).toBe('2022-01-01');
    expect(c.period_end).toBe('2022-12-31');
    expect(c.contract_number).toBe('1');
    expect(c.supplier_phone).toBe('380977009263'); // same phone as the stub tender's supplier
  });

  it('returns nothing for tenders without contracts and skips malformed entries', () => {
    expect(extractContracts(null)).toEqual([]);
    expect(extractContracts({ id: 'x' })).toEqual([]);
    expect(extractContracts({ id: 'x', contracts: [null, { awardID: 'a' }] })).toEqual([]);
    const [c] = extractContracts({ id: 'x', contracts: [{ id: 'c', awardID: 'missing', value: { amount: 1e14 } }] });
    expect(c.supplier_edrpou).toBeNull();
    expect(c.supplier_count).toBe(0);
    expect(c.amount).toBeNull();
  });
});

describe('normalizePhone', () => {
  it.each([
    ['+380 97 700-92-63', '380977009263'],
    ['0977009263', '380977009263'],
    ['(044) 123-45-67', '380441234567'],
    ['12345', null],
    ['+380000000000', null],
    ['000000000', null],
    ['0999999999', null],
    ['044 000-00-00', null],
    ['+380 67 179-81-93', '380671798193'],
    ['', null],
  ])('%s → %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });
  it('ignores non-strings', () => expect(normalizePhone(undefined)).toBeNull());
});

describe('buildContractsUpsert', () => {
  it('upserts on contract_id, never regresses, and keeps fuller fields from an older version', () => {
    const q = buildContractsUpsert([...extractContracts(stubTender), ...extractContracts(fullTender)])!;
    expect(q.text).toMatch(/^INSERT INTO prozorro_contracts/);
    expect(q.text).toContain('ON CONFLICT (contract_id) DO UPDATE');
    expect(q.text).toContain('EXCLUDED.tender_date_modified >= prozorro_contracts.tender_date_modified');
    expect(q.text).toContain('date_signed = COALESCE(EXCLUDED.date_signed, prozorro_contracts.date_signed)');
    expect(q.text).toContain('status = EXCLUDED.status');
    expect(q.text).not.toMatch(/DELETE|TRUNCATE/i);
    expect(q.values).toHaveLength(2 * CONTRACT_COLUMNS.length);
  });

  it('keeps the newest version of a contract repeated in one batch', () => {
    const [c] = extractContracts(stubTender);
    const older = { ...c, status: 'pending', tender_date_modified: '2026-09-01T00:00:00+03:00' };
    const q = buildContractsUpsert([c, older])!;
    expect(q.values).toHaveLength(CONTRACT_COLUMNS.length);
    expect(q.values[CONTRACT_COLUMNS.indexOf('status')]).toBe('active');
  });

  it('returns null for an empty batch', () => expect(buildContractsUpsert([])).toBeNull());
});

describe('backfill args', () => {
  it('parses filters and derives a per-filter cursor key', () => {
    const a = parseBackfillArgs(['--cpv=45', '--since=2021-01-01', '--limit=200', '--dry-run']);
    expect(a).toMatchObject({ cpv: '45', since: '2021-01-01', limit: 200, dryRun: true });
    expect(cursorKey(a)).toBe('contracts_backfill:cpv=45:since=2021-01-01');
    expect(cursorKey(parseBackfillArgs([]))).toBe('contracts_backfill:cpv=*:since=*');
  });
  it('rejects malformed filters', () => {
    expect(() => parseBackfillArgs(['--cpv=45%'])).toThrow();
    expect(() => parseBackfillArgs(['--since=2021'])).toThrow();
    expect(() => parseBackfillArgs(['--bogus'])).toThrow();
  });
});

describe('pgSafe (NUL bytes from ProZorro)', () => {
  it('strips NUL from text and \\u0000 from jsonb values', () => {
    const { pgSafe } = require('../lib/prozorro-feed');
    expect(pgSafe('ТОВ\u0000 АЛЬФА')).toBe('ТОВ АЛЬФА');
    expect(pgSafe({ a: 'x\u0000y', b: [1] })).toEqual({ a: 'xy', b: [1] });
    expect(pgSafe(5)).toBe(5);
    expect(pgSafe(null)).toBeNull();
    const d = new Date(0);
    expect(pgSafe(d)).toBe(d);
  });
});

describe('edrCode', () => {
  it('drops the zero padding of a 10-digit ЄДРПОУ only for UA-EDR', () => {
    const { edrCode } = require('../lib/prozorro-feed');
    expect(edrCode('0023227605', 'UA-EDR')).toBe('23227605');
    expect(edrCode('0023227605', undefined)).toBe('23227605');
    expect(edrCode('2819204155', 'UA-EDR')).toBe('2819204155'); // РНОКПП ФОП
    expect(edrCode('0012345678', 'PL-KRS')).toBe('0012345678');
    expect(edrCode(null, 'UA-EDR')).toBeNull();
  });
});

describe('normalizeEmail', () => {
  it('keeps real addresses and drops filler', () => {
    const { normalizeEmail } = require('../lib/prozorro-feed');
    expect(normalizeEmail(' Kovalchuk_1018@UKR.NET ')).toBe('kovalchuk_1018@ukr.net');
    expect(normalizeEmail('----------@ukr.net')).toBeNull();
    expect(normalizeEmail('0504441122@ukr.net')).toBe('0504441122@ukr.net');
    expect(normalizeEmail('abc@localhost')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});
