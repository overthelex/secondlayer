import {
  candidatesFor, companyKeyVariants, icijSection, isDistinctiveCompanyKey, judge, latinCompanyName, personKeys, residencyAgrees, splitInfo, translit,
} from '../tools/dossier-icij.js';
import { ICIJ_CAVEAT } from '../tools/offshore-leaks-tools.js';

describe('dossier ICIJ matching (LEXAI-2311)', () => {
  it('transliterates by КМУ 2010 and the older y-forms', () => {
    expect(translit('Коломойський')).toBe('kolomoiskyi');
    expect(translit('Юрій')).toBe('yurii');
    expect(translit('Згурський')).toBe('zghurskyi');
    expect(translit('Ігор', 'alt')).toBe('igor');
  });

  it('person keys cover both name orders, common spellings and the patronymic', () => {
    const keys = personKeys('КОЛОМОЙСЬКИЙ ІГОР ВАЛЕРІЙОВИЧ')!.map((k) => k.key);
    expect(keys).toEqual(expect.arrayContaining(['igor kolomoisky', 'igor kolomoiskyi', 'ihor kolomoiskyi', 'kolomoiskyi ihor']));
    expect(keys.some((k) => k.split(' ').length === 3)).toBe(true);
    expect(personKeys('ТОВ "АГРО"')).toBeNull();
    expect(personKeys('Іван')).toBeNull();
  });

  it('pulls the Latin company name out of ЄДР founder text, with residency', () => {
    const info = 'КОМПАНІЯ "КІЕНО ХОЛДІНГС ЛТД" ("KIENO HOLDINGS LTD"); резиденство: Кіпр; розмір частки - 7878218,10 грн.';
    const { name, residency } = splitInfo(info);
    expect(residency).toBe('Кіпр');
    expect(latinCompanyName(name)).toBe('KIENO HOLDINGS LTD');
    expect(companyKeyVariants('KIENO HOLDINGS LTD')).toEqual(['kieno holdings ltd', 'kieno holdings limited']);
  });

  it('skips company names with nothing but legal form and generic words', () => {
    expect(isDistinctiveCompanyKey('holdings limited')).toBe(false);
    expect(isDistinctiveCompanyKey('global investments ltd')).toBe(false);
    expect(isDistinctiveCompanyKey('kieno holdings ltd')).toBe(true);
    expect(isDistinctiveCompanyKey('abc')).toBe(false);
  });

  it('builds candidates from company, founders and beneficiaries; ignores the no-beneficiary reason', () => {
    const c = candidatesFor({ name: 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "ВАРГАС ДЕВЕЛОПМЕНТ"' },
      ['КОМПАНІЯ "VARGAS PROPERTIES INC."; резиденство: Британські Віргінські Острови; розмір частки - 100,00 грн.'],
      ['Івахів Степан Петрович; громадянство: Україна; Прямий вирішальний вплив', 'причина відсутності: ВІДСУТНІ ФІЗИЧНІ ОСОБИ']);
    expect(c.filter((x) => x.role === 'founder').map((x) => x.key)).toEqual(['vargas properties inc', 'vargas properties incorporated']);
    expect(c.some((x) => x.role === 'beneficiary' && x.key === 'stepan ivakhiv')).toBe(true);
    expect(c.filter((x) => x.role === 'company').map((x) => x.key)).toContain('vargas development');
  });

  it('judges matches: residency corroborates a company, a known other jurisdiction suppresses it', () => {
    const founder = { key: 'zenith ltd', kind: 'company' as const, role: 'founder' as const, source_name: 'ZENITH LTD', residency: 'Беліз' };
    expect(residencyAgrees('Британські Віргінські Острови', { jurisdiction_description: 'British Virgin Islands' })).toBe(true);
    expect(judge(founder, { node_type: 'entity', jurisdiction_description: 'Malta', country_codes: ['MLT'] }).report).toBe(false);
    expect(judge(founder, { node_type: 'entity', jurisdiction_description: 'Belize' })).toMatchObject({ report: true, corroborated: true });
    expect(judge(founder, { node_type: 'entity', jurisdiction_description: null })).toMatchObject({ report: true, corroborated: false });
    expect(judge(founder, { node_type: 'address' }).report).toBe(false);
  });

  it('judges people: two words need UKR and an uncommon surname; the patronymic is enough', () => {
    const rare = { key: 'stepan ivakhiv', kind: 'person' as const, role: 'beneficiary' as const, source_name: 'Івахів Степан Петрович', residency: 'Україна', with_patronymic: false, common_surname: false };
    expect(judge(rare, { node_type: 'officer', country_codes: ['UKR'] })).toMatchObject({ report: true, corroborated: true });
    expect(judge(rare, { node_type: 'officer', country_codes: ['RUS'] }).report).toBe(false);
    expect(judge(rare, { node_type: 'entity', country_codes: ['UKR'] }).report).toBe(false);
    expect(judge({ ...rare, common_surname: true }, { node_type: 'officer', country_codes: ['UKR'] }).report).toBe(false);
    expect(judge({ ...rare, with_patronymic: true, common_surname: true }, { node_type: 'officer', country_codes: null }).report).toBe(true);
    // a common surname is flagged at candidate time
    const c = candidatesFor({}, [], ['БОНДАРЕНКО СЕРГІЙ ЛЕОНІДОВИЧ; громадянство: Україна']);
    expect(c.every((x) => x.common_surname)).toBe(true);
  });

  it('section: queries ICIJ in groups, reports corroborated matches with the caveat', async () => {
    const calls: any[] = [];
    const call = async (name: string, args: any) => {
      calls.push({ name, args });
      const results = args.names.includes('stepan ivakhiv') && args.country === 'UKR'
        ? [{ node_id: '1', node_type: 'officer', name: 'STEPAN IVAKHIV', name_key: 'stepan ivakhiv', country_codes: ['UKR'], source_leak: 'Pandora Papers',
            url: 'https://offshoreleaks.icij.org/nodes/1', relationships: { total: 1, items: [{ rel_type: 'officer_of', direction: 'out', node: { name: 'X LTD', url: 'u' } }] } }]
        : args.names.includes('zenith ltd')
          ? [{ node_id: '2', node_type: 'entity', name: 'ZENITH LIMITED', name_key: 'zenith limited', jurisdiction_description: 'Malta', country_codes: ['MLT'], source_leak: 'Paradise Papers', url: 'u2' }]
          : [];
      return { status: 'ok' as const, data: { results, source: { as_of: '2026-09-09' } } };
    };
    const s = await icijSection(call, { name: 'ТОВ "ЛАГУР"' }, { status: 'ok', data: {
      founders: [{ founder_info: 'КОМПАНІЯ "ZENITH LTD"; резиденство: Беліз; розмір частки - 1 грн.' }],
      beneficiaries: [{ beneficiary_info: 'Івахів Степан Петрович; громадянство: Україна' }],
    } });
    expect(calls.every((c) => c.name === 'search_offshore_leaks' && c.args.names.length <= 50)).toBe(true);
    expect(calls.some((c) => c.args.country === 'UKR' && c.args.node_type === 'officer')).toBe(true);
    expect(s.status).toBe('found');
    expect(s.count).toBe(1);
    expect(s.items[0]).toMatchObject({ checked: { role: 'beneficiary', name_in_edr: 'Івахів Степан Петрович' }, corroborated: true,
      icij: { node_id: '1', source_leak: 'Pandora Papers' } });
    expect(s.source.as_of).toBe('2026-09-09');
    expect(s.caveat).toBe(ICIJ_CAVEAT);
    expect(s.message).toMatch(/Не показано 1/);
  });

  it('section: a failed ICIJ call is unknown, not empty; no ЄДР data is unavailable', async () => {
    const down = await icijSection(async () => ({ status: 'timeout', data: null }), { name: 'ТОВ "Х"' },
      { status: 'ok', data: { founders: [{ founder_info: 'KIENO HOLDINGS LTD; резиденство: Кіпр' }] } });
    expect(down.status).toBe('timeout');
    expect(down.message).toMatch(/невідомий/);
    expect((await icijSection(async () => ({ status: 'ok', data: {} }), null, null)).status).toBe('unavailable');
    const none = await icijSection(async () => ({ status: 'ok', data: {} }), { name: 'ТОВ "Х"' }, { status: 'ok', data: {} });
    expect(none.status).toBe('empty');
  });
});
