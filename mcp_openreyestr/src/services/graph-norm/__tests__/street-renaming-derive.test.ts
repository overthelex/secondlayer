import { normAddress } from '../address';
import { candidatePairs, RenamingAggregator, RenamingCandidate, sameStreetName } from '../street-renaming-derive';
import { buildStreetRenamingIndex, scopedRowsOf, STREET_RENAMINGS_SCOPED_SQL, STREET_RENAMINGS_SQL, StreetRenamingsCache } from '../street-renamings';

const KYIV = normAddress('м. Київ, вул. Тестова, 1').settlementKey as string;
const ob = (value: string, date: string) => ({ value, date });

describe('candidatePairs', () => {
  it('finds a street renamed under a company that stayed put', () => {
    const c = candidatePairs([
      ob('01001, м.Київ, Шевченківський район, ВУЛИЦЯ ТЕСТОВА, будинок 8/16, квартира 3', '2016-07-25'),
      ob('Україна, 01001, місто Київ, ВУЛИЦЯ ДОСЛІДНА, будинок 8/16, квартира 3', '2021-10-18'),
    ]);
    expect(c).toEqual([{
      settlementKey: KYIV, oldKey: 'вул|тестова', oldName: 'вулиця тестова', newKey: 'вул|дослидна', newName: 'вулиця дослідна',
      building: '8/16', date: '2021-10-18',
    }]);
  });

  it('reads the addresses in date order and accepts a flat on one side only', () => {
    const c = candidatePairs([
      ob('Україна, 01001, місто Київ, ВУЛИЦЯ ДОСЛІДНА, будинок 5', '2021-10-18'),
      ob('01001, м.Київ, ВУЛ. ТЕСТОВА, 5, КВ. 2', '2016-07-25'),
    ]);
    expect(c.map((x) => [x.oldKey, x.newKey])).toEqual([['вул|тестова', 'вул|дослидна']]);
  });

  it.each([
    ['another building', 'Україна, 01001, місто Київ, ВУЛИЦЯ ДОСЛІДНА, будинок 6, квартира 3'],
    ['another flat', 'Україна, 01001, місто Київ, ВУЛИЦЯ ДОСЛІДНА, будинок 5, квартира 4'],
    ['another settlement', 'Україна, 18000, місто Черкаси, ВУЛИЦЯ ДОСЛІДНА, будинок 5, квартира 3'],
    ['another corpus', 'Україна, 01001, місто Київ, ВУЛИЦЯ ДОСЛІДНА, будинок 5, корпус 2, квартира 3'],
    ['only the street type', 'Україна, 01001, місто Київ, ПРОСПЕКТ ТЕСТОВИЙ, будинок 5, квартира 3'],
    ['only the layout and spelling', 'Україна, 01001, місто Київ, вулиця Тєстова, будинок 5, квартира 3'],
    ['no building', 'Україна, 01001, місто Київ, ВУЛИЦЯ ДОСЛІДНА'],
    ['a typo', 'Україна, 01001, місто Київ, ВУЛИЦЯ ТЕСТТОВАЯ, будинок 5, квартира 3'],
    ['a note added to the name', 'Україна, 01001, місто Київ, ВУЛИЦЯ ТЕСТОВА ДРУГА (ПЕЧЕРСЬКИЙ Р-Н), будинок 5, квартира 3'],
  ])('ignores %s', (_label, next) => {
    expect(candidatePairs([ob('01001, м.Київ, ВУЛ. ТЕСТОВА, 5, КВ. 3', '2016-07-25'), ob(next, '2021-10-18')])).toEqual([]);
  });

  it('keys a village by its name and the first postcode digits, so a new postcode still matches', () => {
    const c = candidatePairs([
      ob('11400, Тестова обл., селище міського типу Дослідне, ВУЛИЦЯ ТЕСТОВА, будинок 2-А', '2016-07-25'),
      ob('Україна, 11401, селище міського типу Дослідне, ВУЛИЦЯ ДОСЛІДНА, будинок 2-А', '2017-06-02'),
      ob('Україна, 11501, селище міського типу Дослідне, ВУЛИЦЯ НОВА, будинок 2-А', '2018-09-22'), // another place
    ]);
    expect(c.map((x) => `${x.settlementKey}#${x.oldKey}>${x.newKey}`)).toEqual(['UA-18|н|дослидне|114#вул|тестова>вул|дослидна']);
    const idx = buildStreetRenamingIndex([{ currentName: 'вулиця дослідна', oldNames: ['вулиця тестова'], settlementKey: c[0].settlementKey }]);
    expect(normAddress('Україна, 11409, селище міського типу Дослідне, ВУЛИЦЯ ТЕСТОВА, будинок 9', { streetRenamings: idx }).street).toBe('дослідна');
    expect(normAddress('Україна, 11509, селище міського типу Дослідне, ВУЛИЦЯ ТЕСТОВА, будинок 9', { streetRenamings: idx }).street).toBe('тестова');
  });

  it('compares consecutive values only and counts a pair once per company', () => {
    const c = candidatePairs([
      ob('м. Київ, вул. Тестова, 5', '2016-07-25'),
      ob('м. Київ, вул. Дослідна, 5', '2017-06-02'),
      ob('м. Київ, вул. Тестова, 5', '2018-09-22'),   // a correction back and forth
      ob('м. Київ, вул. Дослідна, 5', '2021-10-18'),
      ob('м. Київ, вул. Нова, 5', '2024-03-01'),       // a newer source (Prozorro)
    ]);
    expect(c.map((x) => `${x.oldKey}>${x.newKey}`)).toEqual([
      'вул|тестова>вул|дослидна', 'вул|дослидна>вул|тестова', 'вул|дослидна>вул|нова',
    ]);
  });
});

describe('sameStreetName', () => {
  it.each([
    ['новокостянтинивска', 'новоконстянтинивска', true],
    ['тестова', 'тестовий', true],
    ['хмелницкого', 'хмелницкого шевченкивский', true],
    ['кирова', 'кирила', false],
    ['першого травня', '1 травня', true],
    ['1 го травня', '1 травня', true],
    ['1 травня', 'героив майдану', false],
    ['перемоги', 'берестейский', false],
    ['лениная', 'соборна', false],
  ])('%s / %s -> %s', (a, b, same) => expect(sameStreetName(a, b)).toBe(same));
});

// ---------------------------------------------------------------- aggregation

let n = 0;
const cand = (old: string, cur: string, building: string, settlementKey = KYIV, date = '2021-10-18'): RenamingCandidate[] => {
  n++;
  return [{ settlementKey, oldKey: `вул|${old}`, oldName: `вулиця ${old}`, newKey: `вул|${cur}`, newName: `вулиця ${cur}`, building, date }];
};

describe('RenamingAggregator.filter', () => {
  it('keeps a pair seen at >= 3 companies in >= 2 buildings', () => {
    const a = new RenamingAggregator();
    a.add(cand('тестова', 'дослидна', '1'));
    a.add(cand('тестова', 'дослидна', '1', KYIV, '2017-06-02'));
    a.add(cand('тестова', 'дослидна', '7'));
    const { rows, stats } = a.filter();
    expect(rows).toEqual([{
      settlementKey: KYIV, oldKey: 'вул|тестова', oldName: 'вулиця тестова', currentKey: 'вул|дослидна', currentName: 'вулиця дослидна',
      companies: 3, buildings: 2, share: 1, firstSeen: '2017-06-02', lastSeen: '2021-10-18',
    }]);
    expect(stats).toMatchObject({ oldNames: 1, pairs: 1, kept: 1 });
  });

  it('drops a pair with too few companies or a single building (moves within one block)', () => {
    const a = new RenamingAggregator();
    for (let i = 0; i < 2; i++) a.add(cand('тестова', 'дослидна', String(i)));
    for (let i = 0; i < 5; i++) a.add(cand('стара', 'нова', '9'));
    expect(a.filter().rows).toEqual([]);
    expect(a.filter().stats.belowSupport).toBe(2);
    expect(a.filter({ minCompanies: 2, minBuildings: 1 }).rows).toHaveLength(2);
  });

  it('drops an old name split between new names unless one has >= 80%', () => {
    const a = new RenamingAggregator();
    for (let i = 0; i < 4; i++) a.add(cand('тестова', 'дослидна', String(i)));
    for (let i = 0; i < 3; i++) a.add(cand('тестова', 'инша', String(i)));
    for (let i = 0; i < 9; i++) a.add(cand('стара', 'нова', String(i)));
    a.add(cand('стара', 'инша', '1'));
    const { rows, stats } = a.filter();
    expect(rows.map((r) => `${r.oldKey}>${r.currentKey}:${r.share}`)).toEqual(['вул|стара>вул|нова:0.9']);
    expect(stats.ambiguous).toBe(1);
  });

  it('keeps the clearly stronger direction of A -> B / B -> A, or neither', () => {
    const a = new RenamingAggregator();
    for (let i = 0; i < 10; i++) a.add(cand('стара', 'нова', String(i)));
    for (let i = 0; i < 3; i++) a.add(cand('нова', 'стара', String(i)));   // 10:3 -> 77% < 80%: neither
    for (let i = 0; i < 20; i++) a.add(cand('перша', 'друга', String(i)));
    for (let i = 0; i < 3; i++) a.add(cand('друга', 'перша', String(i)));  // 20:3 -> 87%
    const { rows, stats } = a.filter();
    expect(rows.map((r) => `${r.oldKey}>${r.currentKey}`)).toEqual(['вул|перша>вул|друга']);
    expect(stats.reverse).toBe(3); // one dropped from 20:3, both of 10:3
  });

  it('follows a chain to the latest name', () => {
    const a = new RenamingAggregator();
    for (let i = 0; i < 3; i++) a.add(cand('перша', 'друга', String(i), KYIV, '2016-09-02'));
    for (let i = 0; i < 3; i++) a.add(cand('друга', 'третя', String(i), KYIV, '2024-01-01'));
    const { rows, stats } = a.filter();
    expect(rows.map((r) => `${r.oldKey}>${r.currentKey}`).sort()).toEqual(['вул|друга>вул|третя', 'вул|перша>вул|третя']);
    expect(stats.chained).toBe(1);
  });

  it('counts pairs per settlement', () => {
    const a = new RenamingAggregator();
    const OTHER = 'UA-71|м|черкаси';
    for (let i = 0; i < 3; i++) a.add(cand('тестова', 'дослидна', String(i)));
    for (let i = 0; i < 3; i++) a.add(cand('тестова', 'инша', String(i), OTHER));
    expect(a.filter().rows.map((r) => `${r.settlementKey}:${r.currentKey}`)).toEqual([`${KYIV}:вул|дослидна`, `${OTHER}:вул|инша`]);
    expect(n).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- runtime: scoped rows

describe('scoped renamings at runtime', () => {
  const scopedRows = [
    { settlement_key: KYIV, old_name_sample: 'вулиця тестова', current_name_sample: 'вулиця дослідна' },
  ];

  it('applies a renaming in its settlement only (golden)', () => {
    const idx = buildStreetRenamingIndex(scopedRowsOf(scopedRows));
    const opt = { streetRenamings: idx };
    const oldKyiv = normAddress('01001, м.Київ, ВУЛ. ТЕСТОВА, 5, КВ. 3', opt);
    const nowKyiv = normAddress('Україна, 01001, місто Київ, ВУЛИЦЯ ДОСЛІДНА, будинок 5, квартира 3', opt);
    expect(oldKyiv.addressKey).toBe(nowKyiv.addressKey);
    expect(oldKyiv.streetRenamedFrom).toBe('вулиця тестова');
    const cherkasy = normAddress('Україна, 18000, місто Черкаси, ВУЛИЦЯ ТЕСТОВА, будинок 5', opt);
    expect(cherkasy.street).toBe('тестова');
    expect(cherkasy.streetRenamedFrom).toBeNull();
    expect(cherkasy.addressKey).toBe(normAddress('Україна, 18000, місто Черкаси, ВУЛИЦЯ ТЕСТОВА, будинок 5').addressKey);
  });

  const fakeDb = (scoped: any[] | Error) => {
    const calls: string[] = [];
    return {
      calls,
      async query(sql: string) {
        calls.push(sql);
        if (sql === STREET_RENAMINGS_SCOPED_SQL) {
          if (scoped instanceof Error) throw scoped;
          return { rows: scoped };
        }
        return { rows: [{ current_name: 'вулиця Інша', old_names: ['вулиця Тестова'] }] };
      },
    };
  };

  it('loads street_renamings_scoped by default and leaves the global OSM table out', async () => {
    const db = fakeDb(scopedRows);
    const idx = await new StreetRenamingsCache(db).get();
    expect(db.calls).toEqual([STREET_RENAMINGS_SCOPED_SQL]);
    expect(idx.stats).toMatchObject({ scoped: 1, global: 0 });
    expect(normAddress('м. Київ, вул. Тестова, 5', { streetRenamings: idx }).street).toBe('дослідна');
    expect(normAddress('м. Черкаси, вул. Тестова, 5', { streetRenamings: idx }).street).toBe('тестова');
  });

  it('prefers a scoped row over the global table when both are on', async () => {
    const db = fakeDb(scopedRows);
    const idx = await new StreetRenamingsCache(db, { global: true }).get();
    expect(db.calls).toEqual([STREET_RENAMINGS_SCOPED_SQL, STREET_RENAMINGS_SQL]);
    expect(normAddress('м. Київ, вул. Тестова, 5', { streetRenamings: idx }).street).toBe('дослідна');
    expect(normAddress('м. Черкаси, вул. Тестова, 5', { streetRenamings: idx }).street).toBe('інша');
  });

  it('works before migration 029 is applied', async () => {
    const err = Object.assign(new Error('relation "street_renamings_scoped" does not exist'), { code: '42P01' });
    const idx = await new StreetRenamingsCache(fakeDb(err), { extraRows: () => scopedRowsOf(scopedRows) }).get();
    expect(idx.stats.scoped).toBe(1);
    await expect(new StreetRenamingsCache(fakeDb(new Error('boom'))).get()).rejects.toThrow('boom');
  });
});
