/**
 * History fold against a real PostgreSQL (pg_trgm needed). Skipped unless
 * EDR_HIST_TEST_DATABASE_URL points at a throwaway database: the test drops and recreates
 * schema edr_hist there.
 *
 *   EDR_HIST_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/edrtest npx jest edr-history
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import iconv from 'iconv-lite';
import { Pool } from 'pg';
import { loadEdrSnapshot } from '../loader';
import { companyAsOf, companyHistory, searchBeneficiariesHistory, searchFoundersHistory } from '../queries';
import { JONES_NEW, RECORD_UO, SCARA_2021, SCARA_NEW, subject, subjectDump, zipStore } from './fixtures';

const URL = process.env.EDR_HIST_TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;

const S1 = '2016-05-01';   // 2018-style flat RECORD dump: address, boss, founders (+ old КБВ)
const S2 = '2021-10-25';   // 2020-2022 SUBJECT dump: address, founders, beneficiaries
const S3 = '2026-11-17';   // current dump: no address
const ALFA = 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "АЛЬФА"';

d('edr_hist fold (out-of-order loads, field-absent snapshots)', () => {
  let pool: Pool;
  let dir: string;
  const files: Record<string, string> = {};

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 3 });
    await pool.query('DROP SCHEMA IF EXISTS edr_hist CASCADE');
    await pool.query(fs.readFileSync(path.join(__dirname, '../../../migrations/027_edr_history.sql'), 'utf8'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edr-fold-'));
    files.s1 = path.join(dir, '15.1-EX_XML_EDR_UO.xml');
    fs.writeFileSync(files.s1, iconv.encode(RECORD_UO, 'win1251'));
    files.s2 = path.join(dir, '2021.zip');
    fs.writeFileSync(files.s2, zipStore([
      ['17-ufop_full_25.10.2021/', ''],
      ['17-ufop_full_25.10.2021/17.1-EX_XML_EDR_UO_FULL_25.10.2021.xml', subjectDump(
        subject({ record: '10', edrpou: '11111111', name: 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "АЛЬФА-ПЛЮС"', address: '01001, м.Київ, вул. Тестова, буд. 1',
          founders: [SCARA_2021], signers: ['ІВАНЕНКО ІВАН ІВАНОВИЧ - керівник'] }),
        subject({ record: '11', edrpou: '44444444', name: 'ДЕЛЬТА', address: 'м.Одеса',
          benefs: ['ОСОБА ІНША; Україна; Україна, м.Одеса'] }),
      )],
    ]));
    files.s3 = path.join(dir, 'UO.xml');
    fs.writeFileSync(files.s3, subjectDump(
      subject({ record: '10', edrpou: '11111111', name: ALFA, stan: 'в стані припинення', founders: [SCARA_NEW], benefs: [JONES_NEW],
        signers: ['ІВАНЕНКО ІВАН ІВАНОВИЧ - керівник'] }),
      // a cancelled duplicate of the same code: the live record must win
      subject({ record: '99', edrpou: '11111111', name: 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "АЛЬФА-ДУБЛЬ"', stan: 'скасовано',
        founders: ['ЧУЖИЙ ЗАСНОВНИК; громадянство: Україна'] }),
      subject({ record: '12', edrpou: '33333333', name: 'ПРЕДСТАВНИЦТВО БЕТА ЛІМІТЕД', branch: true,
        founders: ['БЕТА ЛІМІТЕД; 99887766; резиденство: Сполучене Королівство'] }),
    ));
  });

  afterAll(async () => {
    await pool?.end();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const load = (snapshot: string, file: string) => loadEdrSnapshot(pool, { snapshot, source: 'test', files: [file], log: () => undefined });
  const runs = async (field: string) => {
    const r = await pool.query(
      `SELECT value, to_char(first_snapshot,'YYYY-MM-DD') f, to_char(last_snapshot,'YYYY-MM-DD') l FROM edr_hist.history
       WHERE edrpou = '11111111' AND field = $1 ORDER BY first_snapshot, value`, [field]);
    return r.rows.map(x => [x.value, x.f, x.l]);
  };

  it('loads newest, then oldest, then the one in between', async () => {
    const r3 = await load(S3, files.s3);
    expect(r3.subjects).toEqual({ uo: 2, fsu: 1 });
    expect((await load(S3, files.s3)).skipped).toMatch(/already loaded/);
    await load(S1, files.s1);
    expect(await runs('name')).toEqual([[ALFA, S1, S3]]);
    const r2 = await load(S2, files.s2);
    expect(r2.fields.uo).toContain('address');
    expect(r2.members).toHaveLength(1);

    // the name changed in 2021 and came back: three runs
    expect(await runs('name')).toEqual([
      [ALFA, S1, S1],
      ['ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "АЛЬФА-ПЛЮС"', S2, S2],
      [ALFA, S3, S3],
    ]);
    expect(await runs('status')).toEqual([['зареєстровано', S1, S2], ['в стані припинення', S3, S3]]);
    // the same founder written in three formats is one run
    expect((await runs('founder')).map(([, f, l]) => [f, l])).toEqual([[S1, S3]]);
    // 2021 publishes beneficiaries (of another company) but none for this one: two runs
    expect((await runs('beneficiary')).map(([, f, l]) => [f, l])).toEqual([[S1, S1], [S3, S3]]);
    // the current dump publishes no address: the 2016-2021 run is not closed by it
    expect(await runs('address')).toEqual([['01001, м.Київ, вул. Тестова, буд. 1', S1, S2]]);
    const heads = Object.fromEntries((await runs('head')).map(([v, f, l]) => [v, [f, l]]));
    expect(heads).toEqual({ 'ПЕТРЕНКО ПЕТРО ПЕТРОВИЧ (head)': [S1, S1], 'ІВАНЕНКО ІВАН ІВАНОВИЧ (керівник)': [S2, S3] });
    expect((await runs('name')).some(([v]) => /ДУБЛЬ/.test(v))).toBe(false);

    const co = (await pool.query(`SELECT * FROM edr_hist.company WHERE edrpou = '11111111'`)).rows[0];
    expect(co.name).toBe(ALFA);
    expect(co.status).toBe('в стані припинення');
    expect(co.record_id).toBe('10');
    expect(co.address).toMatch(/^01001/);   // kept from the last snapshot that published it
  });

  it('as of a date', async () => {
    const a = await companyAsOf(pool, '11111111', '2022-01-01');
    expect(a.snapshot.date).toBe(S2);
    expect(a.fields.name.values).toEqual(['ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "АЛЬФА-ПЛЮС"']);
    expect(a.fields.beneficiary).toBeUndefined();
    const now = await companyAsOf(pool, '11111111', '2026-12-01');
    expect(now.snapshot.date).toBe(S3);
    expect(now.fields.address.snapshot_date).toBe(S2);       // carried from the last snapshot with addresses
    expect(now.note).toMatch(/address/);
    expect((await companyAsOf(pool, '11111111', '2015-01-01')).found).toBe(false);
    const h = await companyHistory(pool, '11111111');
    expect(h.fields.name).toHaveLength(3);
    expect(h.snapshots.map((s: any) => s.date)).toEqual([S1, S2, S3]);
  });

  it('a field-absent snapshot loaded later does not split runs', async () => {
    // another current-format snapshot (no address) between 2021 and 2026
    const f = path.join(dir, 'UO-2026-01.xml');
    fs.writeFileSync(f, subjectDump(subject({ record: '10', edrpou: '11111111', name: ALFA, founders: [SCARA_NEW] })));
    await load('2026-01-19', f);
    expect(await runs('address')).toEqual([['01001, м.Київ, вул. Тестова, буд. 1', S1, S2]]);
    expect(await runs('name')).toEqual([
      [ALFA, S1, S1],
      ['ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "АЛЬФА-ПЛЮС"', S2, S2],
      [ALFA, '2026-01-19', S3],
    ]);
    // the beneficiary was absent in 2026-01 (published for nobody, so the field is not carried): S3 run unchanged
    expect((await runs('beneficiary')).map(([, a, b]) => [a, b])).toEqual([[S1, S1], [S3, S3]]);
    // the status was 'зареєстровано' in 2026-01: joins nothing (2021 run ends at S2, next is 2026-01)
    expect(await runs('status')).toEqual([['зареєстровано', S1, '2026-01-19'], ['в стані припинення', S3, S3]]);
  });

  it('reverse search across scripts, with country and code', async () => {
    const f = await searchFoundersHistory(pool, { query: 'Scaramander Limited', country: 'CY' });
    expect(new Set(f.results.map((r: any) => r.edrpou))).toEqual(new Set(['11111111']));
    expect(f.results.every((r: any) => /наводка/.test(r.match))).toBe(true);
    expect(f.warning).toMatch(/лише наводка/);
    expect(f.snapshots.length).toBeGreaterThan(0);
    expect((await searchFoundersHistory(pool, { query: 'Scaramander Limited', country: 'GB' })).results).toEqual([]);
    const byCode = await searchFoundersHistory(pool, { code: '11111111' });
    expect(byCode.results.map((r: any) => [r.edrpou, r.match])).toEqual([['22222222', 'код ЄДРПОУ (факт)']]);
    expect((await searchFoundersHistory(pool, { query: 'Beta Limited' })).results[0].edrpou).toBe('33333333');
    const b = await searchBeneficiariesHistory(pool, { query: 'John Jones', country: 'Кіпр' });
    expect(b.results.map((r: any) => r.edrpou)).toContain('11111111');
    expect(b.results.some((r: any) => r.current)).toBe(true);
    expect((await searchFoundersHistory(pool, { query: 'ab' })).found).toBe(false);
    expect((await searchFoundersHistory(pool, { query: 'Scaramander', country: 'Атлантида' })).message).toMatch(/не розпізнано/);
  });
});
