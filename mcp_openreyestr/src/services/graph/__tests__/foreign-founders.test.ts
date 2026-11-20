/**
 * Foreign founders, founder bodies, passport data and foreign register links (LEXAI-2321).
 * Synthetic names and numbers only.
 */
import { foreignFounderFix, founderEndpoint, isFounderOrganisationName, isPlaceholderName, organisationKey, PERSON_KEY_VERSION, personKey } from '../keys';
import {
  companiesHouseNumbers, cyRole, greekToLatin, heNumbers, matchName, officerEndpoint, parseForeignKey, registerNameKey,
} from '../foreign-refs';
import { hasPassportOrDob, hasPersonalIdMarker, stripPersonalMarkers, stripPersonIds } from '../../graph-norm/personal-ids';

const NAME = 'ТЕСТЕНКО ТЕСТ ТЕСТОВИЧ';
const ru = (name: string | null, code: string | null = null) => founderEndpoint({ kind: 'organisation', name, code, country_code: 'RU' });

describe('foreign founders that are individuals', () => {
  it('beneficiary / qualifying holder entries: the participant after the last dash', () => {
    const k = personKey('ТЕСТЕР ТЕСТ ТЕСТОВИЧ');
    for (const n of ['КІНЦЕВИЙ БЕНЕФІЦІАРНИЙ ВЛАСНИК (КОНТРОЛЕР) - ТЕСТЕР ТЕСТ ТЕСТОВИЧ',
      '""КІНЦЕВИЙ БЕНЕФІЦІАРНИЙ ВЛАСНИК (КОНТРОЛЕР)". - ТЕСТЕР ТЕСТ ТЕСТОВИЧ',
      'ВЛАСНИК ІСТОТНОЇ УЧАСТІ - ТОВ "ТЕСТ"- КІНЦЕВИЙ БЕНЕФІЦІАРНИЙ ВЛАСНИК (КОНТРОЛЕР) - ТЕСТЕР ТЕСТ ТЕСТОВИЧ',
      '"ВИГОДОНАБУВАЧ - ТЕСТЕР ТЕСТ ТЕСТОВИЧ']) {
      expect([n, ru(n, 'ПАСПОРТ 1234 567890')]).toEqual([n, { kind: 'person_name', key: k }]);
    }
    // the participant is a company: a foreign entity under its own name
    expect(foreignFounderFix('КІНЦЕВИЙ БЕНЕФІЦІАРНИЙ ВЛАСНИК (КОНТРОЛЕР) - КОМПАНІЯ "ТЕСТ ЛІМІТЕД"', null))
      .toEqual({ kind: 'organisation', name: 'КОМПАНІЯ "ТЕСТ ЛІМІТЕД"', dropCode: false });
    expect(foreignFounderFix('ВЛАСНИК ІСТОТНОЇ УЧАСТІ-ПРИВАТНА КОМПАНІЯ ТЕСТ ЛІМІТЕД', null))
      .toMatchObject({ kind: 'organisation', name: 'ПРИВАТНА КОМПАНІЯ ТЕСТ ЛІМІТЕД' });
    // 'no beneficiary' stays a placeholder
    expect(ru('"КІНЦЕВИЙ БЕНЕФІЦІАРНИЙ ВЛАСНИК (КОНТРОЛЕР) - ВІДСУТНІЙ"')).toBe('placeholder');
  });

  it('passport data or a date of birth in the code: a person, the code is not kept', () => {
    for (const code of ['ПАСПОРТ 1234 567890', 'ПАСПОРТ СЕРІЯ 1234 №', 'PASSPORT AB1234567', '01.02.1980 Р.Н.', 'Д.Н. 01.02.1980',
      '01.02.1980', '01021980РН', '1234 567890', '12 34 567890']) {
      expect([code, foreignFounderFix('ТЕСТЕР ТЕСТ', code)]).toEqual([code, { kind: 'person', name: 'ТЕСТЕР ТЕСТ', dropCode: true }]);
    }
    expect(ru('ТЕСТЕР ТЕСТ - 01.02.1980 Р.Н.')).toEqual({ kind: 'person_name', key: personKey('ТЕСТЕР ТЕСТ') });
    expect(ru(NAME)).toEqual({ kind: 'person_name', key: personKey(NAME) });  // a patronymic
    // an individual without a name is dropped, not keyed by the passport number
    expect(ru(null, 'ПАСПОРТ 1234567890')).toBe('placeholder');
  });

  it('foreign companies keep their registration numbers (exempt from the personal-number rules)', () => {
    expect(foreignFounderFix('ТЕСТ ЛІМІТЕД', 'HE 123456')).toBeNull();
    expect(foreignFounderFix('КОМПАНІЯ "ТЕСТ ЛІМІТЕД" НЕ 123456', null)).toBeNull();
    expect(ru(null, '1234567890')).toEqual({ kind: 'foreign_entity', key: 'RU|code:1234567890' });
    expect(ru('ТЕСТ ЛІМІТЕД', '1234567890')).toEqual({ kind: 'foreign_entity', key: 'RU|name:test' });
    expect(founderEndpoint({ kind: 'organisation', name: 'ТЕСТ ГМБХ', code: 'HRB 12345', country_code: 'DE' }))
      .toEqual({ kind: 'foreign_entity', key: 'DE|name:test' });
    // a company with a date in the code (a registration date) stays a company, the date is dropped
    expect(foreignFounderFix('ТЕСТ ГМБХ', '01.02.1980')).toEqual({ kind: 'organisation', name: 'ТЕСТ ГМБХ', dropCode: true });
    expect(foreignFounderFix('TEST S.R.L.', 'ПАСПОРТ 123')).toMatchObject({ kind: 'organisation', dropCode: true });
  });
});

describe('founders that name a party, a public body or an act', () => {
  it('are organisations, unless the name has a patronymic', () => {
    for (const n of ['ПАРТІЯ ТЕСТІВ', 'ТЕСТОВА ПОЛІТИЧНА ПАРТІЯ', 'СЛУЖБА БЕЗПЕКИ УКРАЇНИ', 'КАБІНЕТ МІНІСТРІВ УКРАЇНИ', 'УКАЗ ПРЕЗИДЕНТА',
      'Указ Президента України', 'ТЕСТОВСЬКИЙ ОБЛАСНИЙ ЦЕНТР ЗАЙНЯТОСТІ', 'НАЦІОНАЛЬНА АКАДЕМІЯ НАУК УКРАЇНИ', 'ТЕСТІВСЬКА РАЙОННА ВИБОРЧА КОМІСІЯ',
      'ВИКОНКОМ ТЕСТІВСЬКОЇ МІСЬКОЇ РАДИ', 'ФЕДЕРАЦІЯ ПРОФЕСІЙНИХ СПІЛОК УКРАЇНИ', 'ТЕСТОВА ОБЛАСНА САНІТАРНО-ЕПІДЕМІОЛОГІЧНА СТАНЦІЯ']) {
      expect([n, isFounderOrganisationName(n)]).toEqual([n, true]);
      expect([n, founderEndpoint({ kind: 'person', name: n, code: null, country_code: 'UA' })]).toEqual([n, 'ua_body_without_code']);
      expect(organisationKey(n)).toBeTruthy();
    }
    for (const n of [NAME, 'МІСЬКО ТЕСТ ТЕСТОВИЧ', 'ГРОМАДСЬКА ТЕСТА ТЕСТІВНА', 'ДЕРЖАВЕЦЬ ТЕСТ ТЕСТОВИЧ', 'СУДАК ТЕСТ', 'РАДА ТЕСТА ТЕСТІВНА',
      'ПАРТІЄНКО ТЕСТ']) {
      expect([n, founderEndpoint({ kind: 'person', name: n, code: null, country_code: 'UA' })])
        .toEqual([n, { kind: 'person_name', key: personKey(n) }]);
    }
  });

  it('statements are placeholders', () => {
    for (const n of ['ВІДПОВІДНО ДО РІШЕННЯ', 'ВІДПОВІДНО РІШЕННЯ', 'НЕ ПЕРЕДБАЧЕНО ЗАКОНОМ УКРАЇНИ']) expect([n, isPlaceholderName(n)]).toEqual([n, true]);
  });

  it('Ukrainian organisations without a code are unchanged (company by unique name, else dropped)', () => {
    expect(founderEndpoint({ kind: 'organisation', name: 'ДЕРЖАВНЕ ПІДПРИЄМСТВО ТЕСТ', code: null, country_code: 'UA' })).toBe('ua_org_without_code');
  });
});

describe('dates of birth and passport words in names (person key version 3)', () => {
  it('are stripped before the key', () => {
    expect(PERSON_KEY_VERSION).toBe(3);
    const k = personKey(NAME);
    for (const s of [`${NAME} 01.02.1980 Р.Н.`, `${NAME} 01/02/1980`, `${NAME}, д.н. 01.02.1980`, `${NAME}01.02.1980`, `${NAME} (01.02.1980 р.н.)`,
      `${NAME} ПАСПОРТ`, `${NAME} ПАСПОРТ СЕРІЯ`, `${NAME}. ПАСПОРТ №`, `${NAME} - ПАСПОРТ ГРОМАДЯНИНА ТЕСТЛАНДУ № ВИДАНИЙ 01.02.2003`,
      `ПАСПОРТ ${NAME}`, `- ПАСПОРТ ${NAME}`, `${NAME} ПАСПОРТ 12345`, `${NAME}, паспорт серії АА № 123456`]) {
      expect([s, personKey(s)]).toEqual([s, k]);
      expect([s, hasPassportOrDob(stripPersonIds(s))]).toEqual([s, false]);
    }
    expect(stripPersonIds('01.02.1980 Р.Н.')).toBe('');
    // a surname that starts like the word is kept
    expect(stripPersonIds('ПАСІЧНИК ТЕСТ ТЕСТОВИЧ')).toBe('ПАСІЧНИК ТЕСТ ТЕСТОВИЧ');
  });

  it('marker detection and the entity cleaner', () => {
    expect(hasPersonalIdMarker('1234567890')).toBe(false);
    expect(hasPersonalIdMarker('HE 123456')).toBe(false);
    expect(hasPersonalIdMarker('ПАСПОРТ')).toBe(true);
    expect(hasPersonalIdMarker('ТЕСТ 01.02.1980', 'name')).toBe(false);
    expect(hasPersonalIdMarker('ТЕСТ 01.02.1980 р.н.', 'name')).toBe(true);
    expect(stripPersonalMarkers('ТЕСТ ЛТД НЕ 123456')).toBe('ТЕСТ ЛТД НЕ 123456');
    expect(stripPersonalMarkers('ТЕСТ ЛТД, ПАСПОРТ ДИРЕКТОРА')).toBe('ТЕСТ ЛТД');
    expect(hasPassportOrDob('ТЕСТ АА 123456')).toBe(true);
    expect(hasPassportOrDob('ТЕСТ 1.2.1980')).toBe(true);
    expect(hasPassportOrDob(NAME)).toBe(false);
  });
});

describe('foreign register links', () => {
  it('HE numbers, Companies House numbers, keys', () => {
    expect(heNumbers('КОМПАНІЯ "ТЕСТ ЛІМІТЕД" НЕ 123456', 'HE-012345', 'ΗΕ 7777', 'H.E. 4321', 'THE 123', 'ТЕСТ 123456')).toEqual(['123456', '12345', '7777', '4321']);
    expect(heNumbers('HE123456')).toEqual(['123456']);
    expect(companiesHouseNumbers('№01234567', 'SC123456', '1234567', '123')).toEqual(['01234567', 'SC123456']);
    expect(companiesHouseNumbers('№ 07654321')).toEqual(['07654321']);
    expect(parseForeignKey('CY|name:skaramander')).toEqual({ country: 'CY', nameKey: 'skaramander', code: null });
    expect(parseForeignKey('CY|code:HE123456')).toEqual({ country: 'CY', nameKey: null, code: 'HE123456' });
    expect(matchName('skaramander ne 123456')).toBe('skaramander');
    expect(registerNameKey('SCARAMANDER LIMITED')).toBe(matchName('skaramander'));
    expect(registerNameKey('СКАРАМАНДЕР ЛІМІТЕД')).toBe(registerNameKey('Scaramander Ltd'));
  });

  it('officials: persons, corporate officials, Greek spellings, roles', () => {
    expect(officerEndpoint('JOHN TESTER', 'CY')).toEqual({ ep_kind: 'person_name', ep_key: personKey('JOHN TESTER'), name: 'JOHN TESTER' });
    expect(officerEndpoint('TEST SECRETARIAL LIMITED', 'CY')).toMatchObject({ ep_kind: 'foreign_entity', ep_key: 'CY|name:test sekretarial' });
    expect(officerEndpoint('TEST NOMINEES LTD.', 'CY')).toMatchObject({ ep_kind: 'foreign_entity' });
    expect(greekToLatin('ΤΕΣΤ ΤΕΣΤΑΚΗΣ')).toBe('TEST TESTAKIS');
    expect(officerEndpoint('ΤΕΣΤ ΤΕΣΤΑΚΗΣ', 'CY')).toEqual({ ep_kind: 'person_name', ep_key: personKey('TEST TESTAKIS'), name: 'ΤΕΣΤ ΤΕΣΤΑΚΗΣ' });
    expect(cyRole('Διευθυντής')).toBe('director');
    expect(cyRole('Γραμματέας')).toBe('secretary');
    expect(cyRole('')).toBe('official');
  });
});
