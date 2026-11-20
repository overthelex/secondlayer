import {
  addressHubFlags, addressKeyRow, addressKeyVersion, ADDRESS_KEY_VERSION, codeInName, companyKey, computeHubThresholds,
  DEFAULT_HUB_THRESHOLDS, foreignCode, foreignEntityKey, founderEndpoint, headEndpoint, hubPercentiles, isHub, isOrganisationName,
  isPlaceholderName, organisationKey, PERSON_KEY_VERSION, personKey,
} from '../keys';
import { parseStartKey } from '../neighbourhood';

describe('graph keys', () => {
  it('drops group and statement entries, keeps names', () => {
    for (const n of ['АКЦІОНЕРИ ЗГІДНО РЕЄСТРУ', '91 акціонер', 'ЧЛЕНИ КООПЕРАТИВУ', 'члени громадської організації',
      '"КІНЦЕВИЙ БЕНЕФІЦІАРНИЙ ВЛАСНИК (КОНТРОЛЕР) - ВІДСУТНІЙ"', 'ТРУДОВИЙ КОЛЕКТИВ', 'ФІЗИЧНІ ОСОБИ - ЧЛЕНИ ПРОФСПІЛКИ',
      'ІНШІ АКЦІОНЕРИ В КІЛЬКОСТІ 1315 ФІЗИЧНИХ ОСІБ', 'УЧАСНИК Є КІНЦЕВИМ БЕНЕФІЦІАРНИМ ВЛАСНИКОМ', '', null]) {
      expect(isPlaceholderName(n)).toBe(true);
    }
    for (const n of ['ТЕСТЕНКО ОЛЕГ ПЕТРОВИЧ', 'Членов Петро', 'ГРОМАДА ОЛЕНА', 'Власниченко Ірина', 'ПРИКЛАДЯН АРАМ', 'ФОНД ДЕРЖАВНОГО МАЙНА УКРАЇНИ']) {
      expect(isPlaceholderName(n)).toBe(false);
    }
  });

  it('drops the placeholders found on the full graph (LEXAI-2319)', () => {
    for (const n of ['НЕВИЗНАЧЕНА ОСОБА', 'НЕВИЧНАЧЕНА ОСОБА', 'НЕВІДОМА ОСОБА', 'НЕВІДОМИЙ НЕВІДОМИЙ', 'НЕ ВІДОМИЙ', 'НЕ ВИЗНАЧЕНО',
      'НЕ ВКАЗАНО', 'НЕМАЄ', 'НЕ МАЄ ВІДОМОСТЕЙ', 'НЕМОЖЛИВО ВСТАНОВИТИ', 'ВСТАНОВИТИ НЕМОЖЛИВО', 'ВІДОМОСТІ ВІТСУТНІ',
      'ЮРИДИЧНА ОСОБА', 'ЮРИДИЧНОЇ ОСОБИ', 'ФІЗИЧНИХ ОСІБ', 'ДЕСЯТЬ ФІЗИЧНИХ ОСІБ', 'ФИЗИЧНІ ОСОБИ', 'ФІЗ ОС', 'одна особа',
      'КЕРІВНИК ПІДПРИЄМСТВА', 'КЕРІНВИК ПІДПРИЄМСТВА', 'КЕРІВНИ К ПІДПРИЄМСТВА', 'КЕРІВНИК К', 'КЕРІВНИК НЕВІДОМИЙ',
      'ДИРЕКТОР ТОВАРИСТВА', 'ПРИВАТНЕ ПІДПРИЄМСТВО', 'ГОЛОВА АСОЦІАЦІЇ', 'КЕРІНВИК ФОНДУ', 'ТЕРИТОРІАЛЬНА ГРОМАДА', 'територіальна громада села',
      'СІЛЬСЬКА ТЕРИТОРІАЛЬНА ГРОМАДА', 'РЕЛІГІЙНА ГРОМАДА', 'Релігійна громада парафії', 'ГРОМАДА СЕЛА', 'ЦЕРКОВНА ДЕСЯТКА',
      'УКРАЇНА', 'ГРОМАДЯНИН УКРАЇНИ', 'ПРЯМЕ', 'ПРЯМИЙ ВИРІШАЛЬНИЙ ВПЛИВ', 'КОНТРОЛЕР', 'КОНТРОЛЕР ЮРИДИЧНОЇ ОСОБИ',
      'ЗАГАЛЬНА КІЛЬКІСТЬ', 'ФРАНКІВСЬКА ОБЛАСТЬ', '100%', '0.00 грн.', '68004']) {
      expect([n, isPlaceholderName(n)]).toEqual([n, true]);
    }
    // real names next to those words, and organisations that founders name without a code
    for (const n of ['ГРОМАДА ТЕСТ ТЕСТОВИЧ', 'НЕВІДОМСЬКА ТЕСТА ТЕСТІВНА', 'КОНТРОЛЕР ІВАНЕНКО ІВАН ІВАНОВИЧ',
      'ЮРИДИЧНОЇ ОСОБИ-ПЕТРЕНКО ПЕТРО ПЕТРОВИЧ', 'УКРАЇНЕЦЬ ТЕСТ ТЕСТОВИЧ', 'ГРОМАДЯНИН УКРАЇНИ ПРИКЛАДЕНКО ТЕСТ ТЕСТОВИЧ',
      'КОМПАНІЄЦЬ ТЕСТ ТЕСТОВИЧ', 'ПРИКЛАДІШВІЛІ ТЕСТО', 'МІСЬКА ГРОМАДСЬКА ОРГАНІЗАЦІЯ "СВІТАНОК"',
      'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "АЛЬФА"', 'ОБЛАСНА РАДА']) {
      expect([n, isPlaceholderName(n)]).toEqual([n, false]);
    }
  });

  it('organisations as heads (LEXAI-2318)', () => {
    for (const n of ['ПРАТ ГАЄК', 'ТОВ "КУА "ПРИКЛАД КАПІТАЛ"', 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "УПРАВИТЕЛЬ"',
      'ПРИВАТНЕ АКЦІОНЕРНЕ ТОВАРИСТВО "ТЕСТ"', 'ТОВ"АЛЬФА"', 'КОМПАНІЯ З УПРАВЛІННЯ АКТИВАМИ "ПРИКЛАД"', 'EXAMPLE HOLDINGS LIMITED',
      'УПРАВЛЯЮЧА ФІРМА, 12345678']) {
      expect([n, isOrganisationName(n)]).toEqual([n, true]);
    }
    for (const n of ['ТОВ ТЕСТ ТЕСТОВИЧ', 'БАНК ТЕСТ ТЕСТОВИЧ', 'КОМПАНІЄЦЬ ПРИКЛАД ТЕСТОВИЧ', 'ПРИКЛАДУА ТЕСТО',
      'ТЕСТЕНКО ТЕСТ ТЕСТОВИЧ ЛІКВІДАТОР ПІДПРИЄМСТВА', 'ТЕСТЕНКО ПП', 'ІВАНЕНКО ІВАН ІВАНОВИЧ', 'ТЕСТЕНКО ІВАН 1234567890', '', null]) {
      expect([n, isOrganisationName(n)]).toEqual([n, false]);
    }
    expect(codeInName('ТОВ "АЛЬФА" (код 01234567)')).toBe('01234567');
    expect(codeInName('ПЕТРЕНКО 1234567890')).toBeNull();
    expect(codeInName('ТОВ 00000000')).toBeNull();
    expect(headEndpoint('ТОВ "АЛЬФА", 11111110')).toEqual({ kind: 'company', key: '11111110' });
    expect(headEndpoint('ПРАТ ГАЄК')).toBe('ua_org_without_code');
    expect(headEndpoint('КЕРІВНИК ПІДПРИЄМСТВА')).toBe('placeholder');
    expect(headEndpoint('ІВАНЕНКО ІВАН ІВАНОВИЧ')).toEqual({ kind: 'person_name', key: personKey('ІВАНЕНКО ІВАН ІВАНОВИЧ') });
    expect(organisationKey('ПРАТ "ГАЄК"')).toBe(organisationKey('Приватне акціонерне товариство ГАЄК'));
  });

  it('person key groups spellings of one name (a candidate, namesakes included)', () => {
    expect(personKey('ІВАНЕНКО ІВАН ІВАНОВИЧ')).toBe(personKey('Іваненко Іван Іванович'));
    expect(personKey('Д\'ЯЧЕНКО ОЛЕНА')).toBe(personKey('Дяченко Олена'));
    expect(personKey('АКЦІОНЕРИ ЗГІДНО РЕЄСТРУ')).toBeNull();
  });

  it('personal numbers are not part of a key: the same person with and without one is one node (LEXAI-2322)', () => {
    const k = personKey('ТЕСТЕНКО ТЕСТ ТЕСТОВИЧ');
    for (const n of ['ТЕСТЕНКО ТЕСТ ТЕСТОВИЧ (1234567890)', 'ТЕСТЕНКО ТЕСТ ТЕСТОВИЧ, РНОКПП 1234567890', 'Тестенко Тест Тестович ІНД.КОД 1234567890',
      'ТЕСТЕНКО ТЕСТ ТЕСТОВИЧ1234567890', '1234567890 ТЕСТЕНКО ТЕСТ ТЕСТОВИЧ', 'ТЕСТЕНКО ТЕСТ ТЕСТОВИЧ, паспорт серії АА № 123456']) {
      expect([n, personKey(n)]).toEqual([n, k]);
    }
    expect(personKey('1234567890')).toBeNull();
    expect(personKey('РНОКПП 1234567890')).toBeNull();
    expect(founderEndpoint({ kind: 'person', name: 'ТЕСТЕНКО ТЕСТ ТЕСТОВИЧ (1234567890)', code: null, country_code: 'UA' }))
      .toEqual({ kind: 'person_name', key: k });
    expect(headEndpoint('ТЕСТЕНКО ТЕСТ ТЕСТОВИЧ, ІПН 1234567890')).toEqual({ kind: 'person_name', key: k });
    expect(organisationKey('ПРАТ "ГАЄК" 1234567890')).toBe(organisationKey('ПРАТ "ГАЄК"'));
    expect(PERSON_KEY_VERSION).toBeGreaterThanOrEqual(2);
  });

  it('8-digit ЄДРПОУ codes survive the cleaning; foreign registration numbers are kept', () => {
    expect(headEndpoint('ТОВ "АЛЬФА", 11111110')).toEqual({ kind: 'company', key: '11111110' });
    expect(headEndpoint('ТОВ "АЛЬФА" (код 11111110), РНОКПП директора 1234567890')).toEqual({ kind: 'company', key: '11111110' });
    expect(founderEndpoint({ kind: 'organisation', name: 'ТОВ "БЕТА"', code: '22222220', country_code: 'UA' }))
      .toEqual({ kind: 'company', key: '22222220' });
    // a Russian company's ИНН has 10 digits: a foreign entity keeps it
    expect(founderEndpoint({ kind: 'organisation', name: null, code: '1234567890', country_code: 'RU' }))
      .toEqual({ kind: 'foreign_entity', key: 'RU|code:1234567890' });
  });

  it('company key is the 8-digit code; longer numbers are not companies', () => {
    expect(companyKey('32945')).toBe('00032945');
    expect(companyKey('0012345678')).toBe('12345678');
    expect(companyKey('1234567890')).toBeNull();
    expect(companyKey('00000000')).toBeNull();
    expect(companyKey('abc')).toBeNull();
  });

  it('foreign entity key: country + name skeleton, else the registration code', () => {
    expect(foreignEntityKey('CY', 'СКАРАМАНДЕР ЛІМІТЕД', 'HE 123456')).toBe('CY|name:skaramander');
    expect(foreignEntityKey('cy', 'Scaramander Limited')).toBe('CY|name:skaramander');
    expect(foreignEntityKey('CY', null, 'HE-123456')).toBe('CY|code:HE123456');
    expect(foreignEntityKey('UA', 'ТОВ АЛЬФА')).toBeNull();
    expect(foreignEntityKey(null, 'X LTD')).toBeNull();
    expect(foreignCode('12')).toBeNull();
  });

  it('address key row: raw, building key, premises key and version', () => {
    const v = addressKeyVersion(null);
    expect(v).toBe(`a${ADDRESS_KEY_VERSION}/sr:none`);
    const a = addressKeyRow('Україна, 09100, Київська обл., місто Біла Церква, ВУЛИЦЯ СХІДНА, будинок 32-А, квартира 41', v);
    const b = addressKeyRow('Україна, 09100, ВУЛ. СХІДНА, 32-А, КВ. 41, М.БІЛА ЦЕРКВА, КИЇВСЬКА ОБЛАСТЬ', v);
    expect(a.address_key).toBe(b.address_key);
    expect(a.premises_key).toBe(b.premises_key);
    expect(a.address_key).toMatch(/^UA-32\|м\|/);
    expect(a.raw_md5).toMatch(/^[0-9a-f]{32}$/);
    expect(a.key_version).toBe(v);
    expect(a.label).toContain('32а');
    expect(addressKeyRow('Україна', v).address_key).toBeNull();
  });

  it('hub thresholds are per kind', () => {
    expect(isHub('address', 101)).toBe(true);
    expect(isHub('address', 100)).toBe(false);
    expect(isHub('person_name', 31)).toBe(true);
    expect(isHub('company', 31)).toBe(false);
    expect(isHub('person_name', 5, { company: 1, person_name: 4, address: 1, foreign_entity: 1, organisation: 1 })).toBe(true);
  });

  it('hub thresholds from the degree percentiles, with floors and overrides (LEXAI-2319)', () => {
    expect(hubPercentiles()).toEqual([0.999, 0.9999, 0.99995]);
    // the first full build
    const full = {
      address: { '0.999': 153, '0.9999': 457, '0.99995': 600 }, company: { '0.999': 55, '0.9999': 250, '0.99995': 300 },
      person_name: { '0.999': 65, '0.9999': 252, '0.99995': 300 }, foreign_entity: { '0.999': 69, '0.9999': 174, '0.99995': 190 },
    };
    const t = computeHubThresholds(full);
    expect(t.thresholds).toEqual({ address: 457, company: 250, person_name: 65, foreign_entity: 69, organisation: 30 });
    expect(t.massRegistrationMinDegree).toBe(600);
    expect(t.basis).toMatchObject({ address: 'percentile', organisation: 'floor', mass_registration: 'percentile' });
    // a small sample: the floors
    const small = computeHubThresholds({ address: { '0.9999': 12, '0.99995': 14 }, person_name: { '0.999': 4 } });
    expect(small.thresholds).toEqual(DEFAULT_HUB_THRESHOLDS);
    expect(small.massRegistrationMinDegree).toBe(500);
    const o = computeHubThresholds(full, { address: 5 }, 7);
    expect(o.thresholds.address).toBe(5);
    expect(o.massRegistrationMinDegree).toBe(7);
    expect(o.basis.address).toBe('override');
    // a business centre below the threshold is not a hub; a mass registration address is; the curated list wins
    expect(addressHubFlags(180, t)).toEqual({ hub: false, massRegistration: false });
    expect(addressHubFlags(500, t)).toEqual({ hub: true, massRegistration: false });
    expect(addressHubFlags(3109, t)).toEqual({ hub: true, massRegistration: 'degree' });
    expect(addressHubFlags(40, t, 'mass_registration')).toEqual({ hub: true, massRegistration: 'list' });
    expect(addressHubFlags(3109, t, 'not_hub')).toEqual({ hub: false, massRegistration: false });
  });

  it('start keys', () => {
    expect(parseStartKey('32945')).toEqual({ kind: 'company', key: '00032945' });
    expect(parseStartKey('company:12345678')).toEqual({ kind: 'company', key: '12345678' });
    expect(parseStartKey('person:Іваненко Іван Іванович')).toEqual({ kind: 'person_name', key: personKey('ІВАНЕНКО ІВАН ІВАНОВИЧ') });
    expect(parseStartKey('node:42')).toEqual({ id: 42 });
    expect(parseStartKey('foreign:CY:Scaramander Limited')).toEqual({ kind: 'foreign_entity', key: 'CY|name:skaramander' });
    expect(parseStartKey('foreign:CY|code:HE123456')).toEqual({ kind: 'foreign_entity', key: 'CY|code:HE123456' });
    expect((parseStartKey('address:Україна, 01001, місто Київ, ВУЛИЦЯ ХРЕЩАТИК, будинок 1') as any).key).toMatch(/хрешатик|хрещатик|hreshchatyk|хрищатик/);
    expect(() => parseStartKey('person:АКЦІОНЕРИ')).toThrow();
    expect(parseStartKey('org:ПРАТ "ГАЄК"')).toEqual({ kind: 'organisation', key: organisationKey('ПРАТ ГАЄК') });
    expect(() => parseStartKey('whatever')).toThrow();
  });
});
