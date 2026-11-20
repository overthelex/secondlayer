import { normAddress } from '../address';
import {
  dominantPostcode, formerNameUntil, FORMER_NAME_KEY, OsmArea, OsmPlace, OsmRenamingAggregator, OsmSettlementIndex, osmPairs, readStreetName, settlementKind,
} from '../osm-street-renamings';
import { buildStreetRenamingIndex, renamingSettlementKey, scopedRowsOf } from '../street-renamings';

// synthetic fixtures: an oblast, a city boundary, a village polygon, a village known only by its node
const OBLAST: OsmArea = { id: 1, km2: 20000, tags: { boundary: 'administrative', admin_level: '4', 'ISO3166-2': 'UA-71', name: 'Черкаська область' } };
const KYIV: OsmArea = { id: 9, km2: 840, tags: { boundary: 'administrative', admin_level: '4', 'ISO3166-2': 'UA-30', name: 'Київ', place: 'city' } };
const CITY: OsmArea = { id: 2, km2: 70, tags: { boundary: 'administrative', admin_level: '9', name: 'Тестоград', 'name:uk': 'Тестоград' } };
const KYIV_OBLAST: OsmArea = { id: 8, km2: 28000, tags: { boundary: 'administrative', admin_level: '4', 'ISO3166-2': 'UA-32', name: 'Київська область' } };
const UNNAMED: OsmArea = { id: 6, km2: 1, tags: { boundary: 'administrative', admin_level: '9' } };
const VILLAGE: OsmArea = { id: 3, km2: 4, tags: { place: 'village', name: 'Тестове' }, pc5: { 20101: 5, 20102: 3, 18000: 1 } };
const SUBURB: OsmArea = { id: 4, km2: 2, tags: { place: 'suburb', name: 'Підтестове' } };
const HROMADA: OsmArea = { id: 5, km2: 300, tags: { boundary: 'administrative', admin_level: '7', name: 'Тестівська громада' } };
const places: OsmPlace[] = [
  { id: 100, lon: 30, lat: 49, areas: [1, 2], tags: { place: 'town', name: 'Тестоград', 'name:prefix': 'місто' } },
  { id: 101, lon: 30, lat: 49, areas: [1, 3], tags: { place: 'village', name: 'Тестове' } },
  { id: 102, lon: 30, lat: 49, areas: [1], tags: { place: 'village', name: 'Вузлове', 'addr:postcode': '20333' } },
  { id: 103, lon: 30, lat: 49, areas: [1], tags: { place: 'village', name: 'Безіндексне' } },
  { id: 104, lon: 30, lat: 49, areas: [1, 2], tags: { place: 'village', name: 'Смт Тест', 'name:prefix': 'селище міського типу' } },
];
const idx = new OsmSettlementIndex([OBLAST, KYIV, KYIV_OBLAST, CITY, VILLAGE, SUBURB, HROMADA, UNNAMED], places, { settlementAdminLevels: ['9'] });

describe('settlementKind / dominantPostcode', () => {
  it('reads name:prefix before the place tag', () => {
    expect(settlementKind({ place: 'town', 'name:prefix': 'селище міського типу' })).toBe('н');
    expect(settlementKind({ place: 'village', 'name:prefix': 'місто' })).toBe('м');
    expect(settlementKind({ place: 'town' })).toBe('м');
    expect(settlementKind({ place: 'hamlet' })).toBe('н');
    expect(settlementKind({ place: 'suburb' })).toBeNull();
  });

  it('needs one dominant 3-digit prefix', () => {
    expect(dominantPostcode({ 20101: 5, 20102: 3, 18000: 1 })).toBe('20101');
    expect(dominantPostcode({ 20101: 1, 18000: 1 })).toBeNull();
    expect(dominantPostcode({ 20101: 1 })).toBeNull(); // too few
    expect(dominantPostcode(undefined)).toBeNull();
  });
});

describe('OsmSettlementIndex', () => {
  it('keys a city like the ЄДР address parser does', () => {
    const { settlement } = idx.settlementOf({ areas: [1, 5, 2] });
    const edr = normAddress('Україна, 20300, Черкаська обл., місто Тестоград, вулиця Тестова, будинок 1').settlementKey as string;
    expect(settlement?.key).toBe(renamingSettlementKey(edr));
    expect(settlement?.how).toBe('area');
  });

  it('keys a village with the first three postcode digits of the addresses inside it', () => {
    const { settlement } = idx.settlementOf({ areas: [1, 2, 3] }); // the smallest area wins
    const edr = normAddress('Україна, 20105, Черкаська обл., село Тестове, вулиця Тестова, будинок 1').settlementKey as string;
    expect(settlement?.key).toBe(renamingSettlementKey(edr));
    expect(settlement?.key).toBe('UA-71|н|тестове|201');
  });

  it('ignores suburbs, hromada boundaries and unnamed polygons', () => {
    expect(idx.settlementOf({ areas: [1, 4, 5, 6, 2] }).settlement?.name).toBe('тестоград');
    expect(idx.settlementOf({ areas: [1, 5] }).settlement).toBeNull();
  });

  it('admin boundaries without place=* count only for the given levels', () => {
    const plain = new OsmSettlementIndex([OBLAST, CITY], []);
    expect(plain.settlementOf({ areas: [1, 2] }).reason).toBe('no_settlement');
  });

  it('falls back to the nearest place node within its radius', () => {
    expect(idx.settlementOf({ areas: [1], near: [[102, 900]] }).settlement?.key).toBe('UA-71|н|вузлове|203');
    expect(idx.settlementOf({ areas: [1], near: [[102, 2500]] }).reason).toBe('no_settlement');
    expect(idx.settlementOf({ areas: [1], near: [[103, 100]] }).reason).toBe('village_no_postcode');
  });

  it('Kyiv: the city is its own oblast', () => {
    const { settlement } = idx.settlementOf({ areas: [8, 9] }); // the enclave: the smaller oblast-level area
    expect(settlement?.key).toBe(normAddress('м. Київ, вул. Тестова, 1').settlementKey);
  });

  it('a postcode from another oblast is not used', () => {
    const i2 = new OsmSettlementIndex([OBLAST], [{ id: 1, lon: 0, lat: 0, areas: [1], tags: { place: 'village', name: 'Х', postal_code: '01001' } }]);
    expect(i2.settlementOf({ areas: [1], near: [[1, 10]] }).reason).toBe('village_no_postcode');
  });
});

describe('former-name tags', () => {
  it.each([
    ['old_name', true], ['old_name:uk', true], ['old_name:ru', true], ['was:name', true],
    ['old_name:uk:1936-2016', true], ['old_name:-2023-12-18', true], ['old_name:uk:--2022-09-27', true], ['old_name:2016:uk', true],
    ['old_name:en', false], ['old_name:uk-Latn', false], ['old_name:pl:-2016', false], ['not:name', false],
    ['name:etymology', false], ['old_name:etymology:wikidata', false], ['old_name:1936-2016:etymology:wikidata', false],
  ])('%s -> %s', (k, ok) => expect(FORMER_NAME_KEY.test(k)).toBe(ok));

  it('reads the end year', () => {
    expect(formerNameUntil('old_name:uk:1936-2016')).toBe(2016);
    expect(formerNameUntil('old_name:-2023-12-18')).toBe(2023);
    expect(formerNameUntil('old_name:uk:--2022-09-27')).toBe(2022);
    expect(formerNameUntil('old_name:uk')).toBeNull();
  });
});

describe('osmPairs', () => {
  it('takes the year from a dated tag with the same old name', () => {
    const r = osmPairs({ name: 'вулиця Героїв', old_name: 'вулиця Пушкінська', 'old_name:uk:-2023-02-10': 'вулиця Пушкінська' });
    expect(r.pairs.map((p) => [p.old.key, p.until])).toEqual([['вул|пушкинска', 2023]]);
  });

  it('pairs every former-name tag with name:uk', () => {
    const r = osmPairs({
      name: 'улица Соборная', 'name:uk': 'вулиця Соборна', old_name: 'вулиця Леніна;вулиця Сталіна',
      'old_name:ru': 'улица Ленина', 'old_name:1936-1957': 'вулиця Сталіна', 'not:name': 'вулиця Шкільна', 'name:etymology': 'собор',
    });
    expect(r.current?.key).toBe('вул|соборна');
    expect(r.pairs.map((p) => p.old.key).sort()).toEqual(['вул|ленина']); // Сталіна: until 1957 by the dated tag
  });

  it('drops spelling and language variants of the current name', () => {
    const r = osmPairs({ name: 'вулиця Шевченка', old_name: 'улица Шевченко', 'old_name:uk': 'вул. Т.Шевченка' });
    expect(r.pairs).toEqual([]);
    expect(r.variants).toBe(1);
  });

  it('reads a former name without a type word as the current type', () => {
    const r = osmPairs({ name: 'проспект Берестейський', old_name: 'Перемоги' });
    expect(r.pairs.map((p) => p.old.key)).toEqual(['просп|перемоги']);
  });

  it('keeps a type change and skips Latin names', () => {
    expect(osmPairs({ name: 'вулиця Нова', old_name: 'провулок Леніна' }).pairs[0].old.key).toBe('пров|ленина');
    expect(osmPairs({ name: 'вулиця Нова', old_name: 'Lenina street' }).pairs).toEqual([]);
  });

  it('name samples parse back to their keys', () => {
    const n = readStreetName('вул. 40-річчя Жовтня');
    expect(n).not.toBeNull();
    expect(readStreetName(n!.sample)?.key).toBe(n!.key);
  });
});

describe('OsmRenamingAggregator', () => {
  const S = 'UA-71|м|тестоград';
  const pairs = (tags: Record<string, string>) => osmPairs(tags).pairs;

  it('one row per settlement and old street, the rows feed the runtime index', () => {
    const a = new OsmRenamingAggregator();
    a.add(S, 1, 'area', pairs({ name: 'вулиця Соборна', old_name: 'вулиця Леніна' }));
    a.add(S, 2, 'area', pairs({ name: 'вулиця Соборна', old_name: 'вулиця Леніна' }));
    const { rows, stats } = a.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ settlementKey: S, oldKey: 'вул|ленина', currentKey: 'вул|соборна', ways: 2, how: 'area' });
    expect(stats.kept).toBe(1);

    const index = buildStreetRenamingIndex(scopedRowsOf(rows.map((r) => ({
      settlement_key: r.settlementKey, old_name_sample: r.oldName, current_name_sample: r.currentName,
    }))));
    const addr = normAddress('Україна, 20300, Черкаська обл., місто Тестоград, ВУЛ. ЛЕНІНА, 5', { streetRenamings: index });
    expect(addr.street).toBe('соборна');
  });

  it('drops an old name split between two current streets', () => {
    const a = new OsmRenamingAggregator();
    a.add(S, 1, 'area', pairs({ name: 'вулиця Соборна', old_name: 'вулиця Леніна' }));
    a.add(S, 2, 'area', pairs({ name: 'вулиця Героїв', old_name: 'вулиця Леніна' }));
    expect(a.rows()).toMatchObject({ rows: [], stats: { ambiguous: 1 } });
  });

  it('drops an old name that another street of the settlement carries now', () => {
    const a = new OsmRenamingAggregator();
    a.add(S, 1, 'area', pairs({ name: 'вулиця Соборна', old_name: 'вулиця Шевченка' }));
    a.addCurrent(S, 'вул|шевченка');
    a.addCurrent('UA-71|м|инше', 'вул|соборна');
    expect(a.rows()).toMatchObject({ rows: [], stats: { stillCurrent: 1 } });
  });

  it('keeps settlements apart', () => {
    const a = new OsmRenamingAggregator();
    a.add(S, 1, 'area', pairs({ name: 'вулиця Соборна', old_name: 'вулиця Леніна' }));
    a.add('UA-71|н|тестове|201', 2, 'node', pairs({ name: 'вулиця Героїв', old_name: 'вулиця Леніна' }));
    expect(a.rows().rows.map((r) => [r.settlementKey, r.currentKey, r.how])).toEqual([
      ['UA-71|м|тестоград', 'вул|соборна', 'area'],
      ['UA-71|н|тестове|201', 'вул|героив', 'node'],
    ]);
  });
});

describe('readStreetName / dated former names', () => {
  it('reads a type word written after the name', () => {
    expect(readStreetName('1-й Кутаїський в’їзд')?.key).toBe(readStreetName('в’їзд 1-й Кутаїський')?.key);
    expect(readStreetName('1-й Кутаїський в’їзд')?.ref.type).toBe('вїзд');
    expect(readStreetName('Суворовская аллея')?.ref.type).toBe('алея');
  });

  it('drops former names that ended before the 1990s', () => {
    const r = osmPairs({ name: 'вулиця Соборна', 'old_name:-1944': 'вулиця Дворянська', 'old_name:1944-2016': 'вулиця Леніна' });
    expect(r.pairs.map((p) => p.old.key)).toEqual(['вул|ленина']);
  });
});
