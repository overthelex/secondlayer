import { buildUpsert, extractTenderData, parseArgs, retryDelayMs, toUnixSeconds, TENDER_COLUMNS } from '../lib/prozorro-feed';

const tender = {
  id: '65f4edf21203491e928a18449e57dac4',
  tenderID: 'UA-2024-12-18-024616-a',
  title: 'Вишня морожена',
  status: 'complete',
  procurementMethod: 'open',
  procurementMethodType: 'aboveThreshold',
  procuringEntity: {
    name: 'Ужгородська початкова школа',
    identifier: { scheme: 'UA-EDR', id: '26530480' },
    address: { region: 'Закарпатська область' },
  },
  value: { currency: 'UAH', amount: 253750.0 },
  items: [{ classification: { id: '15330000-0', description: 'Оброблені фрукти та овочі' } }],
  dateCreated: '2024-12-18T23:50:03.362941+02:00',
  dateModified: '2025-01-14T19:54:16.668086+02:00',
  tenderPeriod: { startDate: '2024-12-18T23:50:03.362941+02:00', endDate: '2024-12-26T00:00:00+02:00' },
  awardCriteria: 'lowestCost',
};

describe('extractTenderData', () => {
  it('maps the API tender to table columns, keeping wall-time timestamps', () => {
    const r = extractTenderData(tender)!;
    expect(r.tender_id).toBe(tender.id);
    expect(r.tender_number).toBe('UA-2024-12-18-024616-a');
    expect(r.buyer_edrpou).toBe('26530480');
    expect(r.buyer_region).toBe('Закарпатська область');
    expect(r.amount).toBe(253750);
    expect(r.cpv_code).toBe('15330000-0');
    expect(r.date_modified).toBe('2025-01-14T19:54:16.668086+02:00');
    expect(r.tender_start).toBe('2024-12-18');
    expect(r.tender_end).toBe('2024-12-26');
    expect(Object.keys(r).sort()).toEqual([...TENDER_COLUMNS].sort());
  });

  it('rejects input without an id and drops amounts that overflow NUMERIC(15,2)', () => {
    expect(extractTenderData(null)).toBeNull();
    expect(extractTenderData({ title: 'x' })).toBeNull();
    expect(extractTenderData({ ...tender, value: { amount: 1e14 } })!.amount).toBeNull();
    expect(extractTenderData({ id: 'a' })!.currency).toBe('UAH');
  });

  it('falls back to identifier.legalName for the buyer', () => {
    const r = extractTenderData({ id: 'a', procuringEntity: { identifier: { id: '1', legalName: 'ТОВ А' } } })!;
    expect(r.buyer_name).toBe('ТОВ А');
  });
});

describe('buildUpsert', () => {
  it('builds one ON CONFLICT upsert that never deletes and never regresses date_modified', () => {
    const q = buildUpsert([extractTenderData(tender)!])!;
    expect(q.text).toMatch(/^INSERT INTO prozorro_tenders/);
    expect(q.text).toContain('ON CONFLICT (tender_id) DO UPDATE');
    expect(q.text).toContain('EXCLUDED.date_modified >= prozorro_tenders.date_modified');
    expect(q.text).not.toMatch(/DELETE|TRUNCATE/i);
    expect(q.values).toHaveLength(TENDER_COLUMNS.length);
  });

  it('keeps only the newest version of a tender repeated in one batch', () => {
    const older = extractTenderData({ ...tender, status: 'active', dateModified: '2025-01-10T00:00:00+02:00' })!;
    const newer = extractTenderData(tender)!;
    const q = buildUpsert([newer, older])!;
    expect(q.values).toHaveLength(TENDER_COLUMNS.length);
    expect(q.values[TENDER_COLUMNS.indexOf('status')]).toBe('complete');
  });

  it('returns null for an empty batch', () => {
    expect(buildUpsert([])).toBeNull();
  });
});

describe('parseArgs / toUnixSeconds / retryDelayMs', () => {
  it('parses flags and keeps legacy ones working', () => {
    const a = parseArgs(['--from=2025-01-14T17:54:00Z', '--until=1736900000', '--limit=50', '--dry-run', '--resume']);
    expect(a).toMatchObject({ from: '2025-01-14T17:54:00Z', until: '1736900000', limit: 50, dryRun: true });
    expect(parseArgs(['--year=2024']).from).toBe('2024-01-01T00:00:00Z');
    expect(() => parseArgs(['--bogus'])).toThrow();
  });

  it('reads zone-less ISO as UTC, like the ProZorro feed', () => {
    expect(toUnixSeconds('1736877256')).toBe(1736877256);
    expect(toUnixSeconds('2025-01-14T17:54:16')).toBe(1736877256);
    expect(toUnixSeconds('2025-01-14T19:54:16+02:00')).toBe(1736877256);
  });

  it('honours Retry-After, else backs off exponentially with a cap', () => {
    expect(retryDelayMs(0, '7')).toBe(7000);
    expect(retryDelayMs(0, new Date(1_000_000 + 30_000).toUTCString(), 1_000_000)).toBe(30_000);
    expect(retryDelayMs(0, null)).toBe(2000);
    expect(retryDelayMs(3, null)).toBe(16000);
    expect(retryDelayMs(20, null)).toBe(120_000);
  });
});
