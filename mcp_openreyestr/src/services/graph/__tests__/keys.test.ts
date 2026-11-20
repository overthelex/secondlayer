import {
  addressKeyRow, addressKeyVersion, ADDRESS_KEY_VERSION, companyKey, foreignCode, foreignEntityKey, isHub,
  isPlaceholderName, personKey,
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

  it('person key groups spellings of one name (a candidate, namesakes included)', () => {
    expect(personKey('ІВАНЕНКО ІВАН ІВАНОВИЧ')).toBe(personKey('Іваненко Іван Іванович'));
    expect(personKey('Д\'ЯЧЕНКО ОЛЕНА')).toBe(personKey('Дяченко Олена'));
    expect(personKey('АКЦІОНЕРИ ЗГІДНО РЕЄСТРУ')).toBeNull();
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
    expect(isHub('address', 31)).toBe(true);
    expect(isHub('address', 30)).toBe(false);
    expect(isHub('company', 31)).toBe(false);
    expect(isHub('person_name', 5, { company: 1, person_name: 4, address: 1, foreign_entity: 1 })).toBe(true);
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
    expect(() => parseStartKey('whatever')).toThrow();
  });
});
