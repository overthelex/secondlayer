import {
  formatAddress, normAddress, normBuilding, parseAddressParts, parseStreetName, streetCoreKey,
} from '../address';
import { buildStreetRenamingIndex } from '../street-renamings';

// Synthetic company addresses (invented streets and numbers), in the layouts the ЄДР uses.

describe('parseAddressParts', () => {
  it('reads the current ЄДР layout', () => {
    const p = parseAddressParts('Україна, 29000, Хмельницька обл., місто Хмельницький, ВУЛИЦЯ ТЕСТОВА, будинок 12-А, квартира 7');
    expect(p).toMatchObject({
      country: 'UA', postcode: '29000', oblast: 'хмельницька', oblastCode: 'UA-68',
      settlementType: 'місто', settlement: 'хмельницький', streetType: 'вулиця', street: 'тестова',
      building: '12а', premisesType: 'квартира', premises: '7', unparsed: [], status: 'full',
    });
  });

  it('reads the pre-2016 reversed layout with a bare building number', () => {
    const p = parseAddressParts('Україна, 09100, ВУЛ. ТЕСТОВА, 32, КВ. 41, М.БІЛА ЦЕРКВА, КИЇВСЬКА ОБЛАСТЬ');
    expect(p).toMatchObject({
      postcode: '09100', oblastCode: 'UA-32', settlementType: 'місто', settlement: 'біла церква',
      streetType: 'вулиця', street: 'тестова', building: '32', premisesType: 'квартира', premises: '41', status: 'full',
    });
    const q = parseAddressParts('Україна, 31400, ВУЛ. ТЕСТОВА, 28, СМТ. СТАРА СИНЯВА, СТАРОСИНЯВСЬКИЙ РАЙОН, ХМЕЛЬНИЦЬКА ОБЛАСТЬ');
    expect(q).toMatchObject({ settlementType: 'смт', settlement: 'стара синява', raion: 'старосинявський', building: '28' });
  });

  it('reads raion, corpus, office, room and liter', () => {
    const p = parseAddressParts('Україна, 20600, Черкаська обл., Шполянський р-н, місто Шпола, ВУЛ.ДОСЛІДНА, будинок 8, корпус 2, офіс 15');
    expect(p).toMatchObject({ raion: 'шполянський', building: '8', corpus: '2', premisesType: 'офіс', premises: '15' });
    expect(parseAddressParts('Україна, 03142, місто Київ, ВУЛ.ДОСЛІДНА, будинок 15, ЛІТЕРА"А"')).toMatchObject({ liter: 'а', status: 'full' });
    expect(parseAddressParts('Україна, 21000, місто Вінниця, ПРОВУЛОК ДОСЛІДНИЙ, будинок 14, кімната 26'))
      .toMatchObject({ streetType: 'провулок', premisesType: 'кімната', premises: '26' });
    expect(parseAddressParts('м. Київ, вул. Дослідна, буд. 6, кабінет 403')).toMatchObject({ premisesType: 'кімната', premises: '403' });
  });

  it('knows Kyiv and Sevastopol as oblast-level cities, else falls back to the postcode', () => {
    expect(parseAddressParts('Україна, 04050, місто Київ, ВУЛИЦЯ ДОСЛІДНА, будинок 11-Б')).toMatchObject({ oblast: 'київ', oblastCode: 'UA-30' });
    expect(parseAddressParts('Україна, 99006, місто Севастополь, ВУЛИЦЯ ДОСЛІДНА, будинок 2').oblastCode).toBe('UA-40');
    expect(parseAddressParts('61141, ВУЛ.ДОСЛІДНА, БУД.21, М. ХАРКІВ, ДЗЕРЖИНСЬКИЙ РАЙОН')).toMatchObject({ oblast: null, oblastCode: 'UA-63', country: 'UA' });
    expect(parseAddressParts('Україна, 98100, ВУЛ.ДОСЛІДНА, Б.14, М.ФЕОДОСІЯ, АВТОНОМНА РЕСПУБЛІКА КРИМ').oblastCode).toBe('UA-43');
  });

  it('keeps the smaller of two places in the current layout', () => {
    expect(parseAddressParts('Україна, 79495, Львівська обл., місто Львів, місто Винники, ВУЛ. ДОСЛІДНА, будинок 6'))
      .toMatchObject({ settlement: 'винники', unparsed: [], status: 'full' });
    expect(parseAddressParts('Україна, 84293, Донецька обл., місто Дружківка, селище міського типу Олексієво-Дружківка, ВУЛИЦЯ ДОСЛІДНА, будинок 1'))
      .toMatchObject({ settlementType: 'смт', settlement: 'олексієво-дружківка' });
    expect(parseAddressParts('Україна, Луганська обл., місто Луганськ, М.ЛУГАНСЬК, ЛЕНІНСЬКИЙ Р-Н, ВУЛИЦЯ ДОСЛІДНА, БУДИНОК 26'))
      .toMatchObject({ settlement: 'луганськ', unparsed: [], status: 'full' });
  });

  it('tells a квартал from a квартира and a бульвар from a building', () => {
    expect(parseAddressParts('Україна, 94800, КВ. СОНЯЧНИЙ, БУД. 61, М. ДОСЛІДНЕ, ЛУГАНСЬКА ОБЛАСТЬ'))
      .toMatchObject({ streetType: 'квартал', street: 'сонячний', building: '61', premises: null });
    expect(parseAddressParts('Україна, 55001, Миколаївська обл., місто Южноукраїнськ, б.Дослідний, будинок 8'))
      .toMatchObject({ streetType: 'бульвар', street: 'дослідний', building: '8' });
  });

  it('reads a postfix street type and a house number inside the street component', () => {
    expect(parseAddressParts('Україна, 19615, Черкаська обл., Черкаський р-н, село Мошни, ДОСЛІДНА ВУЛ., будинок 65А'))
      .toMatchObject({ settlementType: 'село', settlement: 'мошни', streetType: 'вулиця', street: 'дослідна', building: '65а' });
    expect(parseAddressParts('Україна, 04073, місто Київ, МОСКОВСЬКИЙ ПРОСПЕКТ, будинок 11')).toMatchObject({ streetType: 'проспект', street: 'московський' });
    expect(parseAddressParts('м. Одеса, вул. Дослідна 5, кв. 3')).toMatchObject({ street: 'дослідна', building: '5', premises: '3' });
    expect(parseAddressParts('Україна, 15072, село Дослідне, ВУЛИЦЯ 40 РОКІВ ПЕРЕМОГИ, будинок 4'))
      .toMatchObject({ street: '40 років перемоги', building: '4' });
  });

  it('reads an ordinal street and a building split by a comma', () => {
    expect(parseAddressParts('Україна, 14020, місто Чернігів, 3-Й ПРОВУЛОК ДОСЛІДНИЙ, будинок 1, квартира 20'))
      .toMatchObject({ streetType: 'провулок', street: '3-й дослідний', building: '1', status: 'full' });
    expect(parseAddressParts('Україна, 39234, село Дослідне, ВУЛИЦЯ МИРУ, БУДИНОК,2')).toMatchObject({ building: '2', status: 'full' });
    expect(parseAddressParts('Україна, 70014, село Дослідне, ВУЛИЦЯ ТЕСТОВА , будинок 42,Б')).toMatchObject({ building: '42б', status: 'full' });
  });

  it('reports partial and failed parses', () => {
    expect(parseAddressParts('Україна, 59316, Чернівецька обл., Кіцманський р-н, село Дослідне').status).toBe('partial');
    expect(parseAddressParts('Україна, 27500, місто Дослідне, ДОСЛІДНИЙ МАСИВ /ТЕСТОВИЙ СПУСК/')).toMatchObject({ status: 'partial' });
    expect(parseAddressParts('').status).toBe('failed');
    expect(parseAddressParts(null).status).toBe('failed');
    expect(parseAddressParts('абвгд, 12').status).toBe('failed');
  });

  it('reads a foreign founder address country', () => {
    expect(parseAddressParts('Кіпр, Нікосія, Тестова 1').country).toBe('CY');
  });
});

describe('normBuilding / parseStreetName / streetCoreKey', () => {
  it.each([
    ['4 А', '4а'], ['4-а', '4а'], ['4 "А"', '4а'], ['4A', '4а'], ['17/10', '17/10'], ['102-104', '102-104'],
    ['№ 5', '5'], ['45 / 24', '45/24'], ['2-В', '2в'],
  ])('building %j -> %j', (raw, want) => expect(normBuilding(raw)).toBe(want));

  it.each([
    ['вул.Тестова', 'вулиця', 'тестова'], ['ВУЛИЦЯ.ТЕСТОВА', 'вулиця', 'тестова'], ['ул. Тестовая', 'вулиця', 'тестовая'],
    ['просп. Тестовий', 'проспект', 'тестовий'], ['пр-т Тестовий', 'проспект', 'тестовий'], ['пр.Тестовий', 'проспект', 'тестовий'],
    ['пров. Тестовий', 'провулок', 'тестовий'], ['пер. Тестовый', 'провулок', 'тестовый'], ['бул. Тестовий', 'бульвар', 'тестовий'],
    ['пл. Тестова', 'площа', 'тестова'], ['Тестова вулиця', 'вулиця', 'тестова'], ['вул. О.Тестової', 'вулиця', 'о. тестової'],
  ])('street %j', (raw, type, name) => expect(parseStreetName(raw)).toEqual({ type, name }));

  it('folds spelling, initials, given names and word order', () => {
    const k = streetCoreKey('Івана Тестенка');
    expect(streetCoreKey('І. Тестенка')).toBe(k);
    expect(streetCoreKey('Тестенка')).toBe(k);
    expect(streetCoreKey('ТЕСТЕНКА ІВАНА')).toBe(k);
    expect(streetCoreKey('Академіка Тестенка')).toBe(k);
    expect(streetCoreKey('Тестенко')).not.toBe(k);
    expect(streetCoreKey('Обʼєднана')).toBe(streetCoreKey("Об'єднана"));
    expect(streetCoreKey('ОБ`ЄДНАНА')).toBe(streetCoreKey('об’єднана'));
    expect(streetCoreKey('Садовая')).toBe(streetCoreKey('Садова'));
    expect(streetCoreKey('Ленина')).toBe(streetCoreKey('Леніна'));
    expect(streetCoreKey('40-річчя Перемоги')).toBe(streetCoreKey('40 річчя перемоги'));
    expect(streetCoreKey('Івана')).toBe('ивана'); // a name made only of a given name keeps it
  });
});

describe('normAddress keys', () => {
  const same = (xs: string[], key: 'addressKey' | 'streetKey' | 'settlementKey' | 'premisesKey') => {
    const keys = xs.map((x) => normAddress(x)[key]);
    expect(keys[0]).toBeTruthy();
    for (const k of keys) expect(k).toBe(keys[0]);
    return keys[0];
  };

  it('gives one building key for both layouts and every abbreviation', () => {
    const k = same([
      'Україна, 09100, Київська обл., місто Біла Церква, ВУЛИЦЯ ТЕСТОВА, будинок 32-А, квартира 41',
      'Україна, 09100, ВУЛ. ТЕСТОВА, 32 А, КВ. 41, М.БІЛА ЦЕРКВА, КИЇВСЬКА ОБЛАСТЬ',
      '09100, Київська область, м. Біла Церква, вул. Тестова, буд. 32а, кв. 41',
      'Украина, 09100, Киевская обл., г. Біла Церква, ул. Тестовая, д. 32-а, кв. 41',
      'Київська обл., Білоцерківський р-н, м Біла Церква, вул Тестова, б. 32"А", кв.41',
    ], 'addressKey');
    expect(k).toBe('UA-32|м|била церква|вул|тестова|32а');
    expect(normAddress('Україна, 09100, ВУЛ. ТЕСТОВА, 32 А, КВ. 41, М.БІЛА ЦЕРКВА, КИЇВСЬКА ОБЛАСТЬ').premisesKey)
      .toBe('UA-32|м|била церква|вул|тестова|32а|кв41');
  });

  it('keeps flats and offices of one building apart only in the premises key', () => {
    const a = normAddress('м. Київ, вул. Дослідна, буд. 6, офіс 1');
    const b = normAddress('Україна, 01001, місто Київ, ВУЛИЦЯ ДОСЛІДНА, будинок 6, офіс 2');
    const c = normAddress('Україна, 01001, місто Київ, ВУЛИЦЯ ДОСЛІДНА, будинок 6, корпус 2');
    expect(a.addressKey).toBe(b.addressKey);
    expect(a.premisesKey).not.toBe(b.premisesKey);
    expect(c.addressKey).not.toBe(a.addressKey);
    expect(c.streetKey).toBe(a.streetKey);
    expect(normAddress('м. Київ, просп. Дослідний, буд. 6').streetKey).not.toBe(a.streetKey); // another street type
  });

  it('matches name variants of the street', () => {
    same([
      'Україна, 49000, Дніпропетровська обл., місто Дніпро, вул.Тестенка В\'ячеслава, будинок 4',
      'Україна, 49000, Дніпропетровська обл., місто Дніпро, ВУЛИЦЯ ВʼЯЧЕСЛАВА ТЕСТЕНКА, будинок 4',
      'Україна, 49000, ВУЛ. В.ТЕСТЕНКА, 4, М.ДНІПРО, ДНІПРОПЕТРОВСЬКА ОБЛАСТЬ',
    ], 'addressKey');
  });

  it('keys a renamed settlement by its current name', () => {
    const k = same([
      'Україна, 49000, ВУЛ.ДОСЛІДНА, 4, М.ДНІПРОПЕТРОВСЬК, ДНІПРОПЕТРОВСЬКА ОБЛАСТЬ',
      'Україна, 49000, Дніпропетровська обл., місто Дніпро, ВУЛИЦЯ ДОСЛІДНА, будинок 4',
    ], 'addressKey');
    expect(k).toBe('UA-12|м|днипро|вул|дослидна|4');
    const p = normAddress('Україна, 25006, Кіровоградська обл., місто Кіровоград(п), ВУЛИЦЯ ДОСЛІДНА, будинок 17');
    expect(p).toMatchObject({ settlement: 'кропивницький', settlementRenamedFrom: 'кіровоград' });
    // a renaming is bound to its oblast: another place of the same old name stays
    expect(normAddress('м. Дніпропетровськ, вул. Дослідна, 4, Тестова обл.').settlement).toBe('дніпропетровськ');
  });

  it('adds the postcode to a village key, not to a city key', () => {
    expect(normAddress('Україна, 19425, Черкаська обл., село Дослідне').settlementKey).toBe('UA-71|н|дослидне|19425');
    expect(normAddress('Україна, 20630, Черкаська обл., село Дослідне').settlementKey).not.toBe(normAddress('Україна, 19425, Черкаська обл., село Дослідне').settlementKey);
    expect(normAddress('Україна, 18001, місто Черкаси, ВУЛ. ДОСЛІДНА, 1').settlementKey).toBe(normAddress('Україна, 18036, Черкаська обл., місто Черкаси').settlementKey);
    expect(normAddress('Україна, 19425, Черкаська обл., село Дослідне, будинок 5').addressKey).toBe('UA-71|н|дослидне|19425|-||5');
  });

  it('has no keys for an unreadable address', () => {
    expect(normAddress('невідомо')).toMatchObject({ settlementKey: null, streetKey: null, addressKey: null, premisesKey: null, status: 'failed' });
  });

  it('formats a canonical address', () => {
    expect(formatAddress(normAddress('Україна, 09100, ВУЛ. ТЕСТОВА, 32 А, КВ. 41, М.БІЛА ЦЕРКВА, КИЇВСЬКА ОБЛАСТЬ')))
      .toBe('09100, Київська обл., м. Біла Церква, вул. Тестова, буд. 32а, кв. 41');
  });
});

describe('street renamings', () => {
  const KYIV = normAddress('м. Київ, вул. Дослідна, 1').settlementKey;
  const OTHER = normAddress('Україна, 18000, місто Черкаси, вул. Дослідна, 1').settlementKey;

  it('maps an old name to the current one within the settlement', () => {
    const idx = buildStreetRenamingIndex([
      { currentName: 'проспект Степана Тестенка', oldNames: ['Московський проспект'], settlementKey: KYIV },
    ]);
    const old = normAddress('Україна, 04073, місто Київ, МОСКОВСЬКИЙ ПРОСПЕКТ, будинок 11', { streetRenamings: idx });
    const now = normAddress('Україна, 04073, місто Київ, ПРОСПЕКТ СТЕПАНА ТЕСТЕНКА, будинок 11', { streetRenamings: idx });
    expect(old.addressKey).toBe(now.addressKey);
    expect(old).toMatchObject({ streetType: 'проспект', street: 'степана тестенка', streetRenamedFrom: 'проспект московський' });
    // not in another city
    const other = normAddress('Україна, 18000, місто Черкаси, МОСКОВСЬКИЙ ПРОСПЕКТ, будинок 11', { streetRenamings: idx });
    expect(other.street).toBe('московський');
    expect(other.streetRenamedFrom).toBeNull();
    expect(OTHER).not.toBe(KYIV);
  });

  it('uses rows without a settlement only when asked, and only for unambiguous old names', () => {
    const rows = [
      { currentName: 'вулиця Соборна', oldNames: ['вулиця Тестова'] },
      { currentName: 'вулиця Покровська', oldNames: ['вулиця Тестова'] },   // ambiguous
      { currentName: 'Ясенева вулиця', oldNames: ['вулиця Дослідна'] },     // unambiguous
      { currentName: 'вулиця Дослідна', oldNames: ['вулиця Інша'] },        // Дослідна is somebody's current name
      { currentName: 'Каштанова вулиця', oldNames: ['вулиця Стара'] },
    ];
    const off = buildStreetRenamingIndex(rows);
    expect(off.size).toBe(0);
    const on = buildStreetRenamingIndex(rows, { global: true });
    expect(on.stats).toMatchObject({ rows: 5, scoped: 0, global: 2 });
    const opt = { streetRenamings: on };
    expect(normAddress('м. Київ, вул. Тестова, 1', opt).street).toBe('тестова');
    expect(normAddress('м. Київ, вул. Дослідна, 1', opt).street).toBe('дослідна');
    expect(normAddress('м. Київ, вул. Інша, 1', opt).street).toBe('дослідна');
    expect(normAddress('м. Київ, вул. Стара, 1', opt).street).toBe('каштанова');
  });

  it('drops an old name mapped to two current names in one settlement', () => {
    const idx = buildStreetRenamingIndex([
      { currentName: 'вулиця Соборна', oldNames: ['вулиця Тестова'], settlementKey: KYIV },
      { currentName: 'вулиця Покровська', oldNames: ['вулиця Тестова'], settlementKey: KYIV },
    ]);
    expect(idx.size).toBe(0);
    expect(idx.stats.ambiguous).toBe(1);
  });
});
