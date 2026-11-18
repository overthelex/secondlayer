import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import iconv from 'iconv-lite';
import { addressKey, entryRows, historyValues, isOldBeneficiary, parseBeneficiary, parseFounder, parseHead, EdrSubject } from '../entries';
import { countryIso } from '../norm';
import { isFopMember, newReadStats, readDump, readXmlStream, DumpFormat } from '../records';
import {
  FOP_SUBJECT, JONES_2021, JONES_NEW, JONES_OLD, RECORD_UO, ROW_UO, SCARA_2021, SCARA_NEW, SCARA_OLD,
  subject, subjectDump, zipStore,
} from './fixtures';

describe('free-text entries', () => {
  it('founders in every format', () => {
    let f = parseFounder(SCARA_NEW);
    expect([f.name, f.code, f.country, f.kind, f.contribution_uah]).toEqual(['СКАРАМАНДЕР ЛІМІТЕД', 'HE123456', 'Кіпр', 'organisation', 1000]);
    f = parseFounder('ВИГАДАНЕНКО ДМИТРО ОЛЕКСАНДРОВИЧ; громадянство: Білорусь; розмір частки - 9405,00 грн.');
    expect([f.name, f.kind, countryIso(f.country), f.contribution_uah]).toEqual(['ВИГАДАНЕНКО ДМИТРО ОЛЕКСАНДРОВИЧ', 'person', 'BY', 9405]);
    f = parseFounder('ПРИВАТНЕ ПІДПРИЄМСТВО "ВИГАДКА"; 12340001; розмір частки - 5100,00 грн.');
    expect([f.code, f.kind, f.country]).toEqual(['12340001', 'organisation', null]);

    const old = parseFounder(SCARA_OLD);
    expect([old.name, old.country, old.contribution_uah, old.kind]).toEqual(['СКАРАМАНДЕР ЛІМІТЕД (SCARAMANDER LIMITED)', 'Кіпр', 1000, 'organisation']);
    f = parseFounder('ТОВ "АЛЬФА", код ЄДРПОУ 11111111, країна резиденства: Україна, розмір внеску до статутного фонду - 500.00 грн.');
    expect([f.name, f.code, f.country]).toEqual(['ТОВ "АЛЬФА"', '11111111', 'Україна']);

    // 2020-2022: positional, comma-separated
    f = parseFounder(SCARA_2021);
    expect([f.name, f.code, f.country, f.contribution_uah, f.kind]).toEqual(['СКАРАМАНДЕР ЛІМІТЕД', null, 'Кіпр', 1000, 'organisation']);
    f = parseFounder('ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "ОМЕГА", 12345678, Україна, Україна, 01001, м.Київ, вул. Тестова, 1, розмір внеску до статутного фонду - 1300,00 грн.');
    expect([f.name, f.code, f.country, f.contribution_uah]).toEqual(['ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "ОМЕГА"', '12345678', 'Україна', 1300]);
    f = parseFounder('ТЕСТЕНКО ІВАН ПЕТРОВИЧ, Україна, розмір внеску до статутного фонду - 100,00 грн.');
    expect([f.name, f.country, f.kind, f.contribution_uah]).toEqual(['ТЕСТЕНКО ІВАН ПЕТРОВИЧ', 'Україна', 'person', 100]);
    f = parseFounder('БЕТА ХОЛДІНГС ЛТД, HE 4242, Кіпр, Кіпр, Лімасол');
    expect([f.code, f.country]).toEqual(['HE 4242', 'Кіпр']);
  });

  it('beneficiaries in every format', () => {
    let b = parseBeneficiary(JONES_NEW);
    expect([b.name, b.country, b.share, b.influence]).toEqual(['ДЖОНС ДЖОН', 'Кіпр', '100', 'Непрямий вирішальний вплив']);
    b = parseBeneficiary('причина відсутності: відсутні фізичні особи, які відповідають статусу');
    expect(b.name).toBeNull();
    expect(b.reason).toMatch(/^відсутні/);
    expect(isOldBeneficiary(JONES_OLD)).toBe(true);
    b = parseBeneficiary(JONES_OLD);
    expect([b.name, countryIso(b.country)]).toEqual(['ДЖОНС ДЖОН', 'CY']);
    // 2020-2022: 'NAME; COUNTRY; ADDRESS' — the address is not an influence
    b = parseBeneficiary(JONES_2021);
    expect([b.name, b.country, b.influence]).toEqual(['ДЖОНС ДЖОН', 'Кіпр', null]);
    // old КБВ without a dash, and the "none" form
    expect(isOldBeneficiary('КІНЦЕВИЙ БЕНЕФІЦІАРНИЙ ВЛАСНИК (КОНТРОЛЕР) У ЮРИДИЧНОЇ ОСОБИ ВІДСУТНІЙ')).toBe(true);
    b = parseBeneficiary('КІНЦЕВИЙ БЕНЕФІЦІАРНИЙ ВЛАСНИК (КОНТРОЛЕР) У ЮРИДИЧНОЇ ОСОБИ ВІДСУТНІЙ');
    expect(b.name).toBeNull();
    expect(b.reason).toMatch(/ВІДСУТНІЙ/);
  });

  it('heads', () => {
    let h = parseHead('ТЕСТОВИЧ АРТЕМ ПЕТРОВИЧ; 23.02.2011; (згідно статуту) - керівник', 'signer');
    expect([h.name, h.role, h.role_class, h.appointed_on]).toEqual(['ТЕСТОВИЧ АРТЕМ ПЕТРОВИЧ', 'керівник', 'head', '2011-02-23']);
    h = parseHead('ТЕСТЕНКО ПЕТРО ІВАНОВИЧ; 11.04.2016 - керівник', 'signer');
    expect([h.name, h.role_class, h.appointed_on]).toEqual(['ТЕСТЕНКО ПЕТРО ІВАНОВИЧ', 'head', '2016-04-11']);
    expect(parseHead('ПРИКЛАДОВА ОЛЬГА ІВАНІВНА; - представник', 'signer').role_class).toBe('representative');
    expect(parseHead('ЗРАЗКОВА ОЛЬГА ПЕТРІВНА; ЧЛЕН КОМІТЕТУ', 'member').role_class).toBe('member');
  });

  it('history values are format-independent', () => {
    const mk = (founders: string[], beneficiaries: string[]): EdrSubject => ({
      kind: 'uo', record: '1', edrpou: '11111111', name: 'АЛЬФА', short_name: 'не має', legal_form: null, status: 'зареєстровано',
      address: null, kved: '46.90 Опт', capital: '1000,00', registered_on: null, founders, beneficiaries, heads: [],
    });
    const hv = (s: EdrSubject) => { const r = entryRows(s); return historyValues(s, r.founders, r.beneficiaries, r.heads); };
    const a = hv(mk([SCARA_NEW], [JONES_NEW]));
    const b = hv(mk([SCARA_2021], [JONES_2021]));
    const c = hv(mk([SCARA_OLD], [JONES_OLD]));
    const pick = (x: typeof a, f: string) => x.filter(v => v.field === f).map(v => v.value_hash);
    expect(pick(a, 'founder')).toEqual(pick(b, 'founder'));
    expect(pick(a, 'founder')).toEqual(pick(c, 'founder'));
    expect(pick(a, 'beneficiary')).toEqual(pick(b, 'beneficiary'));
    expect(pick(a, 'beneficiary')).toEqual(pick(c, 'beneficiary'));
    expect(pick(a, 'short_name')).toEqual([]);                       // 'не має' is not a value
    expect(pick(a, 'capital')).toEqual(pick(hv({ ...mk([], []), capital: '1000.00' }), 'capital'));
  });

  it('address key ignores the wording of each era', () => {
    expect(addressKey('04212, м.Київ, Тестовий район, ВУЛИЦЯ ТЕСТОВА, будинок 3, квартира 256'))
      .toBe(addressKey('Україна, 04212, місто Київ, ВУЛИЦЯ ТЕСТОВА, будинок 3, квартира 256'));
    expect(addressKey('04212, м.Київ, вул. Тестова, 3')).not.toBe(addressKey('04213, м.Київ, вул. Тестова, 3'));
    expect(addressKey('Україна, м.Львів')).toBe(addressKey('м.Львів'));
  });
});

async function collect(bytes: Buffer): Promise<Array<[EdrSubject, DumpFormat]>> {
  const out: Array<[EdrSubject, DumpFormat]> = [];
  await readXmlStream(Readable.from([bytes]), (s, f) => out.push([s, f]), newReadStats());
  return out;
}

describe('dump formats', () => {
  it('current SUBJECT: UO, FSU, ФОП skipped, &#24; dropped', async () => {
    const recs = await collect(subjectDump(
      subject({ record: '1', edrpou: '11111111', name: 'АЛЬФА', founders: [SCARA_NEW], benefs: [JONES_NEW] }),
      subject({ record: '2', edrpou: '33333333', name: 'ПРЕДСТАВНИЦТВО БЕТА ЛІМІТЕД', branch: true }),
      FOP_SUBJECT,
    ));
    expect(recs.map(([s, f]) => [s.kind, f, s.edrpou])).toEqual([['uo', 'subject', '11111111'], ['fsu', 'subject', '33333333']]);
    expect(recs[0][0].founders).toEqual([SCARA_NEW]);
    expect(recs[0][0].registered_on).toBe('2006-03-01');
    expect(recs[0][0].address).toBeNull();
  });

  it('2020-2022 SUBJECT: address and the primary KVED', async () => {
    const [[s]] = await collect(subjectDump(subject({
      record: '7', edrpou: '11111111', name: 'АЛЬФА', address: 'Україна, 01001, м.Київ', kved: ['46.90', 'Опт'],
      founders: [SCARA_2021, JONES_OLD], benefs: [JONES_2021], signers: ['ТЕСТЕНКО ПЕТРО ІВАНОВИЧ; 11.04.2016 - керівник'],
    })));
    expect(s.address).toBe('Україна, 01001, м.Київ');
    expect(s.kved).toBe('46.90 Опт');
    expect(s.founders).toEqual([SCARA_2021]);
    expect(s.beneficiaries).toEqual([JONES_OLD, JONES_2021]);   // the КБВ entry moved out of the founders
    expect(s.heads).toEqual([['signer', 'ТЕСТЕНКО ПЕТРО ІВАНОВИЧ; 11.04.2016 - керівник']]);
  });

  it('2018-2019 RECORD (experimental)', async () => {
    const recs = await collect(iconv.encode(RECORD_UO, 'win1251'));
    expect(recs.map(([s, f]) => [s.edrpou, f])).toEqual([['11111111', 'record'], ['22222222', 'record']]);
    const a = recs[0][0];
    expect(a.address).toMatch(/^01001/);
    expect(a.kved).toMatch(/^46\.90/);
    expect(a.heads).toEqual([['boss', 'ПЕТРЕНКО ПЕТРО ПЕТРОВИЧ']]);
    expect([a.founders.length, a.beneficiaries.length]).toEqual([1, 1]);
  });

  it('2016 ROWDATA/ROW with Ukrainian tags and attributes (experimental)', async () => {
    const recs = await collect(iconv.encode(ROW_UO, 'win1251'));
    expect(recs.map(([s, f]) => [s.edrpou, f, s.status])).toEqual([['11111111', 'row', 'зареєстровано'], ['44444444', 'row', 'припинено']]);
    expect(recs[0][0].address).toMatch(/^01001/);
    expect(recs[0][0].heads).toEqual([['boss', 'ПЕТРЕНКО ПЕТРО ПЕТРОВИЧ']]);
    expect(recs[1][0].name).toBe('ПРИВАТНЕ ПІДПРИЄМСТВО "ДЕЛЬТА"');
  });

  it('zip with a folder and several XML members; ФОП members skipped', async () => {
    expect(isFopMember('17-ufop_full_25.10.2021/17.2-EX_XML_EDR_FOP_FULL_25.10.2021.xml')).toBe(true);
    expect(isFopMember('17-ufop_full_25.10.2021/17.1-EX_XML_EDR_UO_FULL_25.10.2021.xml')).toBe(false);
    expect(isFopMember('FOP_1.xml')).toBe(true);
    expect(isFopMember('15-UFOP/ФОП_1.xml')).toBe(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edr-zip-'));
    const zip = path.join(dir, 'dump.zip');
    fs.writeFileSync(zip, zipStore([
      ['17-ufop_full_01.01.2021/', ''],
      ['17-ufop_full_01.01.2021/17.1-EX_XML_EDR_UO_FULL_01.01.2021.xml', subjectDump(subject({ record: '1', edrpou: '11111111', name: 'АЛЬФА' }))],
      ['17-ufop_full_01.01.2021/17.2-EX_XML_EDR_FOP_FULL_01.01.2021.xml', subjectDump(FOP_SUBJECT)],
      ['17-ufop_full_01.01.2021/17.3-EX_XML_EDR_FSU_FULL_01.01.2021.xml', subjectDump(subject({ record: '2', edrpou: '33333333', name: 'БЕТА', branch: true }))],
    ]));
    const got: string[] = [];
    const stats = await readDump(zip, s => got.push(`${s.kind}:${s.edrpou}`));
    expect(got).toEqual(['uo:11111111', 'fsu:33333333']);
    expect(stats.members).toHaveLength(2);
    expect(stats.skippedMembers).toEqual(['17-ufop_full_01.01.2021/17.2-EX_XML_EDR_FOP_FULL_01.01.2021.xml']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
