/**
 * LEXAI-2183 against a real PostgreSQL: migration 237's catalog rows drive the importer
 * end to end (CSV, TSV, XLSX, CKAN "API" resource) and the disabled sources are refused.
 *
 * Needs a throwaway database; skipped unless IMPORT_TEST_PG_URL is set, e.g.
 *   IMPORT_TEST_PG_URL=postgres://postgres@localhost:55432/postgres npx jest ckan-tabular-sources.pg
 * Everything is created in a fresh schema that is dropped afterwards.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';
import { Pool } from 'pg';
import ExcelJS from 'exceljs';
import { ImportTaskService } from '../import-task-service';

const PG_URL = process.env.IMPORT_TEST_PG_URL;
const d = PG_URL ? describe : describe.skip;

const schema = `lexai2183_test_${process.pid}`;
const migration = (f: string) => readFileSync(join(__dirname, '..', '..', 'migrations', f), 'utf8');

// These tables exist on prod but were created by hand (no migration); same columns as prod.
const handMadeTables = `
CREATE TABLE opendata_advocates (id SERIAL PRIMARY KEY, source_id TEXT, family_name TEXT, name TEXT, additional_name TEXT,
  ra_name TEXT, decision_num TEXT, decision_date TEXT, certificate_num TEXT, certificate_date TEXT, authority_name TEXT,
  other_info TEXT, email TEXT, status TEXT, status_description TEXT, work_address JSONB, additional_addresses JSONB,
  org_forms JSONB, imported_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE opendata_court_schedule (id BIGSERIAL PRIMARY KEY, hearing_date TEXT, judges TEXT, case_number TEXT,
  court_name TEXT, court_room TEXT, case_involved TEXT, case_description TEXT, imported_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE opendata_corruption_offenders (id SERIAL PRIMARY KEY, source_id TEXT, punishment_type TEXT, entity_type TEXT,
  last_name TEXT, first_name TEXT, patronymic TEXT, offense_id TEXT, offense_name TEXT, punishment TEXT,
  court_case_number TEXT, sentence_date TEXT, sentence_number TEXT, punishment_start TEXT, court_id TEXT, court_name TEXT,
  codex_articles JSONB, imported_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE opendata_declaration_checks (id SERIAL PRIMARY KEY, declaration_uid TEXT, uid TEXT, family_name TEXT, name TEXT,
  additional_name TEXT, position TEXT, position_category TEXT, reporting_period TEXT, status TEXT, result TEXT,
  result_url TEXT, measures TEXT, completion_year TEXT, imported_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE opendata_large_taxpayers (id SERIAL PRIMARY KEY, edrpou TEXT, name TEXT, imported_at TIMESTAMPTZ DEFAULT NOW());
`;

const dl = (pkg: string, file: string) => `https://data.gov.ua/dataset/${pkg}/resource/r-${file}/download/${file}`;
const resource = (url: string, format: string, last_modified: string) => ({ id: url, name: url.split('/').pop(), url, format, last_modified });

const packages: Record<string, any> = {
  'e1af20b8-c80b-4f2c-bf82-566567ef936e': [
    resource(dl('e1af20b8', 'register-2026-07-06.json'), 'JSON', '2026-07-08T07:55:49'),
    resource(dl('e1af20b8', 'structure.csv'), 'CSV', '2024-08-15T01:12:58'),
  ],
  '3a321301-a06f-487b-9d19-e6b917250aee': [
    resource(dl('3a321301', 'spisok-sprav-priznachenih-do-rozglyadu.csv'), 'CSV', '2026-11-01T07:04:40'),
  ],
  '560e5f5d-0b8b-491e-a0b1-72eb08602edc': [
    resource(dl('560e5f5d', 'getalldata'), 'XLSX', '2020-12-04T12:37:26'),
    resource('https://corruptinfo.nazk.gov.ua/ep/1.0/corrupt/getAllData', 'API', '2021-05-06T11:16:48'),
    resource(dl('560e5f5d', 'getalldata.json'), 'JSON', '2024-03-05T09:13:50'),
  ],
  '144a7349-4349-4211-9a5a-d58e98558673': [
    resource(dl('144a7349', 'declarationcheck.csv'), 'CSV', '2026-03-24T15:13:49'),
    resource(dl('144a7349', 'structure_declarationcheck.csv'), 'CSV', '2026-05-08T11:30:38'),
  ],
  '36cabc4a-f172-450d-a906-64cf28cdb34b': [
    resource(dl('36cabc4a', 'dodatok_do_nakazu_reiestr_2019_zmini.csv'), 'CSV', '2019-09-09T07:28:29'),
    resource(dl('36cabc4a', 'reestr_vpp_2022_zminu.csv'), 'CSV', '2021-12-21T12:40:41'),
  ],
  '16fcf128-1a28-41d5-8081-3dfffe68b397': [
    resource(dl('16fcf128', 'reestr_dd_2026_01_01-_kod.xlsx'), 'XLSX', '2026-01-08T14:05:55'),
    resource(dl('16fcf128', 'reestr_dd_27_10_2026-1.xlsx'), 'XLSX', '2026-10-27T15:33:09'),
  ],
};

async function stateAidXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Лист1');
  ws.addRow(['number', 'RDDNumber', 'nameOfProgram', 'EDRPOU', 'theOneWhoProvidesStateAid', 'EDRPOU', 'oneWhoReceivesStateAid',
    'region', 'dateOfCommencement', 'dateCompleted', 'decisionNumber', 'dateOfDecision', 'theAmountOfStateAid']);
  ws.addRow(['Номер', 'Номер РДД (станом на 27.10.2026)', 'Назва програми', 'ЄДРПОУ', 'Надавачі ДД', 'ЄДРПОУ', 'Отримувачі',
    'Області', 'Дата початку ', 'Дата завершення ', 'Номер рішення АМКУ', 'Дата рішення АМКУ', 'Сума за рішенням АМКУ (грн.)']);
  ws.addRow([1425569, ' 8-ДДЗ/2022', 'Програма розвитку транспорту', '25082708', 'Департамент ЖКГ', '03328907', 'КП «Тролейбус»',
    'Чернівецька область', new Date(Date.UTC(2022, 0, 1)), new Date(Date.UTC(2023, 11, 31)), '92-р', new Date(Date.UTC(2022, 1, 24)), '107302000']);
  ws.addRow([1425028, '7-ДДЗ/2022', 'Програма 2', '26139770', 'Управління транспорту', '43022656', 'КП «Центр»',
    'Дніпропетровська область', null, null, '7-р/тк', new Date(Date.UTC(2022, 1, 9)), 'NA']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function files(xlsx: Buffer): Record<string, string | Buffer> {
  return {
    'register-2026-07-06.json': JSON.stringify([
      { ID: '7656', familyName: 'Ромаданова', name: 'Галина', additionalName: 'Григорівна', raName: 'Рада адвокатів Кіровоградської області',
        decisionNum: '1', decisionDate: '1993-12-30', certificateNum: '6/6', certificateDate: '2004-12-02', authorityName: 'Кіровоградська обласна КДКА',
        otherinfo: null, email: 'g.romadanova@ukr.net', status: 'FALSE', statusDescription: [],
        workAddress: [{ workAddressCity: 'Кропивницький' }], additionalAddresses: [], orgforms: [{ orgFormName: 'АФ РОМАДАНОВА І ПАРТНЕРИ' }] },
      { ID: '7657', familyName: 'Іванов', name: 'Іван', additionalName: 'Іванович', raName: 'Рада адвокатів Київської області',
        decisionNum: '2', decisionDate: '2001-01-01', certificateNum: '7/7', certificateDate: '2005-01-01', authorityName: 'Київська КДКА',
        otherinfo: null, email: null, status: 'TRUE',
        statusDescription: ['Право на заняття адвокатською діяльністю зупинено згідно п.1 ч.1 ст.31 з 01.01.2019 на підставі заяви'],
        workAddress: [], additionalAddresses: [], orgforms: [] },
    ]),
    'spisok-sprav-priznachenih-do-rozglyadu.csv':
      '"date"\t"judges"\t"case"\t"court_name"\t"court_room"\t"case_involved"\t"case_description"\r\n' +
      '"05.05.2026 00:00"\t"Головуючий суддя: Безименна Н.В."\t"620/4710/25"\t"Шостий апеляційний адміністративний суд"\t\t\t\r\n' +
      '"06.05.2026 10:00"\t"Головуючий суддя: Кучма А.Ю."\t"320/9540/24"\t"Шостий апеляційний адміністративний суд"\t"5"\t' +
      '"Позивач: ТОВ "" Будівельні споруди міста """\t"про визнання дій протиправними"\r\n',
    getAllData: JSON.stringify([
      { id: 568240, punishmentType: { code: 1, name: 'Указ' }, entityType: { code: 0, name: 'Фізична особа' },
        indLastNameOnOffenseMoment: 'Замотін', indFirstNameOnOffenseMoment: 'Ілля', indPatronymicOnOffenseMoment: 'Олександрович',
        offenseName: 'Несвоєчасне подання декларації' },
      { id: 80969, punishmentType: { code: 0, name: 'Судове рішення' }, entityType: { code: 0, name: 'Фізична особа' },
        indLastNameOnOffenseMoment: 'Горечий', indFirstNameOnOffenseMoment: 'Олег', indPatronymicOnOffenseMoment: 'Романович',
        offenseId: 75786, offenseName: 'Прийняття пропозиції', punishment: 'штраф', courtCaseNumber: '297/383/19',
        sentenceDate: '2019-02-25', sentenceNumber: '80200420', punishmentStart: '2019-03-28', courtId: 660,
        courtName: 'Берегівський районний суд Закарпатської області', codexArticles: [{ codexArticleId: 29, codexArticleName: 'Прийняття' }] },
    ]),
    'declarationcheck.csv':
      'declarationUid,uid,familyName,name,additionalName,position,positionCategory,reportingPeriod,status,result,resultUrl,measures,completionYear\n' +
      ',1863,Абдулаєва,Ліна,Василівна,,Посадова особа юридичної особи публічного права,2024,завершено,' +
      '"встановлено недостовірні відомості,встановлено ознаки неточності",https://nazk.gov.ua/x.pdf,,2026\n' +
      ',945,Абраменкова,Наталя,Олександрівна,,Посадова особа,2023,завершено,встановлено недостовірні відомості,https://nazk.gov.ua/y.pdf,,2025\n',
    'reestr_vpp_2022_zminu.csv':
      'Код за ЄДРПОУ платника податків;Найменування платника податків\r\n17733;"АСК ""УКРРІЧФЛОТ"""\r\n32112;"АТ ""УКРЕКСІМБАНК"""\r\n;\r\n;\r\n',
    'reestr_dd_27_10_2026-1.xlsx': xlsx,
  };
}

function makeDb(pool: Pool) {
  return {
    query: (text: string, params?: any[]) => pool.query(text, params),
    getPool: () => pool,
    transaction: async <T>(cb: (c: any) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await cb(client);
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

d('moved catalog sources on PostgreSQL (LEXAI-2183)', () => {
  let admin: Pool;
  let pool: Pool;
  let svc: any;
  let body: Record<string, string | Buffer>;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: PG_URL, max: 4, options: `-c search_path=${schema}` });
    await pool.query(handMadeTables);
    for (const f of ['110_import_tasks.sql', '117_tier1_opendata_tables.sql', '125_add_missing_sync_sources.sql',
      '235_invalid_passports_ckan_sources.sql', '237_moved_catalog_sources_ckan.sql']) {
      await pool.query(migration(f));
    }
    await pool.query(migration('237_moved_catalog_sources_ckan.sql')); // idempotent
    body = files(await stateAidXlsx());
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(() => {
    svc = new ImportTaskService(makeDb(pool) as any);
    svc.fetchJson = jest.fn(async (url: string) => {
      const id = decodeURIComponent(url.split('id=')[1]);
      return packages[id] ? { success: true, result: { resources: packages[id] } } : { success: false };
    });
    svc.httpGetStream = jest.fn(async (url: string) => {
      const b = body[url.split('/').pop()!];
      if (b === undefined) throw new Error(`HTTP 404 for ${url}`);
      const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
      const chunks: Buffer[] = [];
      for (let i = 0; i < buf.length; i += 9) chunks.push(buf.subarray(i, i + 9));
      return Readable.from(chunks);
    });
    svc.sleep = jest.fn(async () => {});
  });

  const catalogRow = async (name: string) =>
    (await pool.query('SELECT * FROM import_source_catalog WHERE name = $1', [name])).rows[0];
  const run = async (name: string) => svc.runCkanMultiFileImport(1, await catalogRow(name), new AbortController().signal);

  it('migrates six sources to ckan_package and disables four with a reason', async () => {
    await pool.query(`UPDATE import_source_catalog SET default_threads_per_ip = 5, rate_limit_ms = 1100 WHERE name = 'state_aid'`);
    await pool.query(migration('237_moved_catalog_sources_ckan.sql')); // re-run resets them
    const r = await pool.query(`SELECT name, enabled, source_config, default_threads_per_ip, rate_limit_ms FROM import_source_catalog
      WHERE name IN ('advocates','court_schedule','nazk_corruption_offenders','nazk_declaration_checks','large_taxpayers','state_aid',
                     'dsfmu_terrorism','judge_candidates','lustration','wage_debtors') ORDER BY name`);
    const by = Object.fromEntries(r.rows.map((x: any) => [x.name, x]));
    for (const n of ['advocates', 'court_schedule', 'nazk_corruption_offenders', 'nazk_declaration_checks', 'large_taxpayers', 'state_aid']) {
      expect(by[n].enabled).toBe(true);
      expect(by[n].source_config.ckan_package).toBeTruthy();
      expect(by[n].source_config.replace).toBe(true);
      expect([by[n].default_threads_per_ip, by[n].rate_limit_ms]).toEqual([1, 0]);
    }
    for (const n of ['dsfmu_terrorism', 'judge_candidates', 'lustration', 'wage_debtors']) {
      expect(by[n].enabled).toBe(false);
      expect(by[n].source_config.disabled_reason).toMatch(/^LEXAI-2183: /);
    }
    expect(by.court_schedule.source_config.csv_delimiter).toBe('\t');
    expect(by.nazk_corruption_offenders.source_config.skip_unchanged).toBe(false);
  });

  it('advocates: newest register JSON, statusDescription joined, addresses as jsonb', async () => {
    await pool.query(`INSERT INTO opendata_advocates (source_id, family_name) VALUES ('1', 'Старий')`);
    await run('advocates');
    const rows = (await pool.query(`SELECT source_id, status, status_description, work_address, org_forms FROM opendata_advocates ORDER BY source_id`)).rows;
    expect(rows.map((x: any) => x.source_id)).toEqual(['7656', '7657']);
    expect(rows[0].status_description).toBe('');
    expect(rows[1].status_description).toMatch(/^Право на заняття/);
    expect(rows[0].work_address).toEqual([{ workAddressCity: 'Кропивницький' }]);
    expect(rows[0].org_forms[0].orgFormName).toBe('АФ РОМАДАНОВА І ПАРТНЕРИ');
    expect(svc.httpGetStream).toHaveBeenCalledTimes(1); // structure.csv not downloaded
  });

  it('court_schedule: the ДСА TSV replaces the table', async () => {
    await pool.query(`INSERT INTO opendata_court_schedule (case_number) VALUES ('old/1/26')`);
    await run('court_schedule');
    const rows = (await pool.query(`SELECT hearing_date, case_number, court_room, case_involved FROM opendata_court_schedule ORDER BY case_number`)).rows;
    expect(rows).toEqual([
      { hearing_date: '06.05.2026 10:00', case_number: '320/9540/24', court_room: '5', case_involved: 'Позивач: ТОВ " Будівельні споруди міста "' },
      { hearing_date: '05.05.2026 00:00', case_number: '620/4710/25', court_room: '', case_involved: '' },
    ]);
  });

  it('nazk_corruption_offenders: the live API resource, nested names, decree records without a court case', async () => {
    await run('nazk_corruption_offenders');
    expect(svc.httpGetStream.mock.calls[0][0]).toBe('https://corruptinfo.nazk.gov.ua/ep/1.0/corrupt/getAllData');
    const rows = (await pool.query(`SELECT source_id, punishment_type, entity_type, last_name, offense_id, court_id, codex_articles
      FROM opendata_corruption_offenders ORDER BY source_id`)).rows;
    expect(rows).toEqual([
      { source_id: '568240', punishment_type: 'Указ', entity_type: 'Фізична особа', last_name: 'Замотін', offense_id: null, court_id: null, codex_articles: null },
      { source_id: '80969', punishment_type: 'Судове рішення', entity_type: 'Фізична особа', last_name: 'Горечий', offense_id: '75786',
        court_id: '660', codex_articles: [{ codexArticleId: 29, codexArticleName: 'Прийняття' }] },
    ]);
  });

  it('nazk_declaration_checks and large_taxpayers: CSV, structure file and blank ";" rows ignored', async () => {
    await run('nazk_declaration_checks');
    const dc = (await pool.query(`SELECT uid, family_name, result, completion_year FROM opendata_declaration_checks ORDER BY uid`)).rows;
    expect(dc).toEqual([
      { uid: '1863', family_name: 'Абдулаєва', result: 'встановлено недостовірні відомості,встановлено ознаки неточності', completion_year: '2026' },
      { uid: '945', family_name: 'Абраменкова', result: 'встановлено недостовірні відомості', completion_year: '2025' },
    ]);
    await run('large_taxpayers');
    expect(svc.httpGetStream.mock.calls.map((c: any[]) => c[0].split('/').pop())).toEqual(['declarationcheck.csv', 'reestr_vpp_2022_zminu.csv']);
    const lt = (await pool.query(`SELECT edrpou, name FROM opendata_large_taxpayers ORDER BY edrpou`)).rows;
    expect(lt).toEqual([{ edrpou: '17733', name: 'АСК "УКРРІЧФЛОТ"' }, { edrpou: '32112', name: 'АТ "УКРЕКСІМБАНК"' }]);
  });

  it('state_aid: newest XLSX, label row skipped, both EDRPOU columns, date and amount typed', async () => {
    await pool.query(`INSERT INTO opendata_state_aid (row_data, provider_name, recipient_name) VALUES ('{"EDRPOU":"ЄДРПОУ"}', 'Номер РДД', 'ЄДРПОУ')`);
    await run('state_aid');
    expect(svc.httpGetStream.mock.calls[0][0]).toMatch(/reestr_dd_27_10_2026-1\.xlsx$/);
    const rows = (await pool.query(`SELECT provider_edrpou, recipient_edrpou, recipient_name, program_name, decision_date::text, amount::text,
      row_data->>'region' AS region FROM opendata_state_aid ORDER BY provider_edrpou`)).rows;
    expect(rows).toEqual([
      { provider_edrpou: '25082708', recipient_edrpou: '03328907', recipient_name: 'КП «Тролейбус»', program_name: 'Програма розвитку транспорту',
        decision_date: '2022-02-24', amount: '107302000', region: 'Чернівецька область' },
      { provider_edrpou: '26139770', recipient_edrpou: '43022656', recipient_name: 'КП «Центр»', program_name: 'Програма 2',
        decision_date: '2022-02-09', amount: null, region: 'Дніпропетровська область' },
    ]);
  });

  it('startImport refuses the disabled sources and records no task', async () => {
    await pool.query(`DELETE FROM import_tasks`);
    svc.runImport = jest.fn();
    for (const n of ['dsfmu_terrorism', 'judge_candidates', 'lustration', 'wage_debtors']) {
      await expect(svc.startImport({ sourceName: n })).rejects.toThrow(new RegExp(`Джерело "${n}" вимкнено: LEXAI-2183`));
    }
    expect((await pool.query(`SELECT count(*)::int n FROM import_tasks`)).rows[0].n).toBe(0);
    expect(svc.runImport).not.toHaveBeenCalled();
  });
});
