/**
 * LEXAI-2183: catalog sources whose data.gov.ua resources moved from JSON to CSV / XLSX /
 * a CKAN "API" resource. Parsers, resource selection and the import path over a fake DB.
 * Fixtures copy the shape of the real files (ДСА TSV, ДПС ";" CSV, НАЗК CSV, АМКУ XLSX).
 */
import { Readable } from 'stream';
import ExcelJS from 'exceljs';
import {
  CkanResource, CsvStreamParser, VALUE_TRANSFORMS, headerKeys, latestCkanResource, selectCkanResources,
  xlsxCellValue, xlsxRecords,
} from '../ckan-multifile-import';
import { ImportTaskService } from '../import-task-service';

const parseAll = (text: string, delimiter = ',', opts = {}, step = 0) => {
  const p = new CsvStreamParser(delimiter, opts);
  const out: any[] = [];
  if (step <= 0) out.push(...p.push(text));
  else for (let i = 0; i < text.length; i += step) out.push(...p.push(text.slice(i, i + step)));
  out.push(...p.end());
  return out;
};

// ДСА «Список справ призначених до розгляду»: TSV, every field quoted, "" inside, CRLF.
const courtTsv =
  '﻿"date"\t"judges"\t"case"\t"court_name"\t"court_room"\t"case_involved"\t"case_description"\r\n' +
  '"05.05.2026 00:00"\t"Головуючий суддя: Безименна Н.В."\t"620/4710/25"\t"Шостий апеляційний адміністративний суд"\t\t\t\r\n' +
  '"05.05.2026 00:00"\t"Головуючий суддя: Безименна Н.В."\t"320/9540/24"\t"Шостий апеляційний адміністративний суд"\t""\t' +
  '"Позивач (заявник): ТОВ "" Будівельні споруди міста "", відповідач"\t"про визнання\tпротиправним\nрішення"\n';

describe('CsvStreamParser', () => {
  it('parses the ДСА TSV: BOM, quotes, "" escapes, tab and newline inside quotes, empty trailing fields', () => {
    const recs = parseAll(courtTsv, '\t');
    expect(recs).toHaveLength(2);
    expect(recs[0]).toEqual({
      date: '05.05.2026 00:00', judges: 'Головуючий суддя: Безименна Н.В.', case: '620/4710/25',
      court_name: 'Шостий апеляційний адміністративний суд', court_room: '', case_involved: '', case_description: '',
    });
    expect(recs[1].case_involved).toBe('Позивач (заявник): ТОВ " Будівельні споруди міста ", відповідач');
    expect(recs[1].case_description).toBe('про визнання\tпротиправним\nрішення');
  });

  it('gives the same records for every chunk size (quotes and CRLF split across chunks)', () => {
    const whole = parseAll(courtTsv, '\t');
    for (const step of [1, 2, 3, 5, 7, 13]) expect(parseAll(courtTsv, '\t', {}, step)).toEqual(whole);
  });

  it('parses the ДПС ";" CSV and keeps the last row without a trailing newline', () => {
    const csv = 'Код за ЄДРПОУ платника податків;Найменування платника податків\r\n17733;"АСК ""УКРРІЧФЛОТ"""\r\n32112;"АТ ""УКРЕКСІМБАНК"""';
    expect(parseAll(csv, ';')).toEqual([
      { 'Код за ЄДРПОУ платника податків': '17733', 'Найменування платника податків': 'АСК "УКРРІЧФЛОТ"' },
      { 'Код за ЄДРПОУ платника податків': '32112', 'Найменування платника податків': 'АТ "УКРЕКСІМБАНК"' },
    ]);
  });

  it('parses the НАЗК CSV with a delimiter inside a quoted field', () => {
    const csv = 'declarationUid,uid,familyName,result\n,1863,Абдулаєва,"встановлено недостовірні відомості,встановлено ознаки"\n';
    expect(parseAll(csv)).toEqual([{ declarationUid: '', uid: '1863', familyName: 'Абдулаєва',
      result: 'встановлено недостовірні відомості,встановлено ознаки' }]);
  });

  it('honours header_row / skip_rows and skips blank lines', () => {
    const csv = 'Рейтинг кандидатів\n\na,b\nлейбл А,лейбл Б\n1,2\n\n3,4\n';
    expect(parseAll(csv, ',', { headerRow: 2, skipRows: 1 })).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  });

  it('gives a short row nulls but refuses a row wider than the header (wrong delimiter)', () => {
    expect(parseAll('a,b,c\n1,2\n')).toEqual([{ a: '1', b: '2', c: null }]);
    expect(() => parseAll('a;b\n1,2;3\n', ',')).toThrow(/2 fields, header has 1/);
  });

  it('detects a download cut inside a quoted field', () => {
    expect(() => parseAll('a,b\n1,"unfinished')).toThrow(/truncated/);
  });

  it('refuses a file without the header row', () => {
    expect(() => parseAll('')).toThrow(/no header row/);
  });
});

describe('headerKeys', () => {
  it('numbers repeated names and names empty cells', () => {
    expect(headerKeys(['number', 'EDRPOU', 'name', 'EDRPOU', null, ' Дата  початку '])).toEqual(
      ['number', 'EDRPOU', 'name', 'EDRPOU_2', 'col_5', 'Дата початку']);
  });
});

/** АМКУ «Реєстр державної допомоги»: English header, Ukrainian label row, duplicated EDRPOU. */
async function stateAidXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Лист1');
  ws.addRow(['number', 'RDDNumber', 'nameOfProgram', 'EDRPOU', 'theOneWhoProvidesStateAid', 'EDRPOU',
    'oneWhoReceivesStateAid', 'dateOfDecision', 'theAmountOfStateAid', 'linkToThePortal']);
  ws.addRow(['Номер', 'Номер РДД (станом на 27.10.2026)', 'Назва програми', 'ЄДРПОУ', 'Надавачі ДД', 'ЄДРПОУ',
    'Отримувачі', 'Дата рішення АМКУ', 'Сума за рішенням АМКУ (грн.)', 'Посилання на Портал']);
  ws.addRow([1425569, ' 8-ДДЗ/2022', 'Програма розвитку транспорту', '25082708', 'Департамент ЖКГ', '03328907',
    'КП "Чернівецьке тролейбусне управління"', new Date(Date.UTC(2022, 1, 24)), '107302000',
    { text: 'https://pdd.amc.gov.ua/portal/1425569', hyperlink: 'https://pdd.amc.gov.ua/portal/1425569' }]);
  ws.addRow([]);
  const r = ws.addRow([1425028, '7-ДДЗ/2022', 'Програма 2', 26139770, 'Управління транспорту', '43022656',
    'КП "Центр"', 'не визначено', 'н/д']);
  r.getCell(3).value = { richText: [{ text: 'Програма ' }, { text: '2' }] };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('xlsxRecords', () => {
  it('reads the АМКУ layout: label row skipped, EDRPOU_2, dates, hyperlinks, rich text, blank rows', async () => {
    const recs = await xlsxRecords(await stateAidXlsx(), { headerRow: 1, skipRows: 1 });
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({
      number: 1425569, EDRPOU: '25082708', EDRPOU_2: '03328907', dateOfDecision: '2022-02-24',
      theAmountOfStateAid: '107302000', linkToThePortal: 'https://pdd.amc.gov.ua/portal/1425569',
    });
    expect(recs[1]).toMatchObject({ nameOfProgram: 'Програма 2', EDRPOU: 26139770, linkToThePortal: null });
  });

  it('cell values: formula result, error, date with time', () => {
    expect(xlsxCellValue({ formula: 'A1+1', result: 5 })).toBe(5);
    expect(xlsxCellValue({ error: '#N/A' })).toBeNull();
    expect(xlsxCellValue(new Date(Date.UTC(2026, 9, 27, 15, 33)))).toBe('2026-10-27T15:33:00.000Z');
  });
});

describe('transforms for the new sources', () => {
  it('join turns НААУ statusDescription lists into text, [] into ""', () => {
    expect(VALUE_TRANSFORMS.join([])).toBe('');
    expect(VALUE_TRANSFORMS.join(['зупинено з 01.01.2019', ' припинено '])).toBe('зупинено з 01.01.2019\nприпинено');
    expect(VALUE_TRANSFORMS.join(null)).toBeNull();
  });

  it('number parses spreadsheet amounts and nulls text', () => {
    expect(VALUE_TRANSFORMS.number('107302000')).toBe(107302000);
    expect(VALUE_TRANSFORMS.number('107 302 000,50')).toBe(107302000.5);
    expect(VALUE_TRANSFORMS.number(12.5)).toBe(12.5);
    expect(VALUE_TRANSFORMS.number('н/д')).toBeNull();
    expect(VALUE_TRANSFORMS.number('')).toBeNull();
  });
});

describe('resource selection', () => {
  const res = (id: string, url: string, format: string, last_modified: string | null) => ({ id, name: id, url, format, last_modified });
  const pkg = { result: { resources: [
    res('xlsx', 'https://data.gov.ua/dataset/x/resource/1/download/getalldata', 'XLSX', '2020-12-04T12:37:26'),
    res('api', 'https://corruptinfo.nazk.gov.ua/ep/1.0/corrupt/getAllData', 'API', '2021-05-06T11:16:48'),
    res('json', 'https://data.gov.ua/dataset/x/resource/3/download/getalldata.json', 'JSON', '2024-11-05T15:14:47'),
  ] } };

  it('the CKAN format filter separates НАЗК API from the XLSX dump with the same file name', () => {
    expect(selectCkanResources(pkg, '^getAllData$').map(r => r.id).sort()).toEqual(['api', 'xlsx']);
    expect(selectCkanResources(pkg, '^getAllData$', 'API').map(r => r.id)).toEqual(['api']);
    expect(selectCkanResources(pkg, '^getAllData$', 'api').map(r => r.id)).toEqual(['api']);
  });

  it('latest_only picks the newest snapshot by last_modified, not by file name', () => {
    const r = (name: string, lm: string | null): CkanResource => ({ id: name, name, url: `https://x/${name}`, last_modified: lm });
    const list = [r('reestr_dd_2026_01_01-_kod.xlsx', '2026-01-08T14:05:55'), r('reestr_dd_27_10_2026-1.xlsx', '2026-10-27T15:33:09'),
      r('reestr_dd_18_08_2026.xlsx', '2026-08-18T13:01:06'), r('reestr_dd_undated.xlsx', null)];
    expect(latestCkanResource(list).map(x => x.name)).toEqual(['reestr_dd_27_10_2026-1.xlsx']);
    expect(latestCkanResource([r('only.xlsx', null)])).toHaveLength(1);
    expect(latestCkanResource([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// runCkanMultiFileImport over a fake database (no unique key -> DELETE + INSERT swap).

class FakeDb {
  queries: string[] = [];
  txQueries: string[] = [];
  staging: any[][] = [];
  stagingCols: string[] = [];
  constructor(private currentRows: number, private catalogRow?: any) {}
  async query(sql: string, params: any[] = []) {
    this.queries.push(sql);
    if (/^SELECT \* FROM import_source_catalog/.test(sql)) return { rows: this.catalogRow ? [this.catalogRow] : [] };
    const m = sql.match(/^INSERT INTO \S+__staging_\d+ \(([^)]*)\) VALUES/);
    if (m) {
      const width = m[1].split(',').length;
      this.stagingCols = m[1].split(',');
      for (let i = 0; i < params.length; i += width) this.staging.push(params.slice(i, i + width));
      return { rows: [], rowCount: params.length / width };
    }
    if (/DELETE FROM \S+__staging_\d+ WHERE _src/.test(sql)) { this.staging = []; return { rows: [], rowCount: 0 }; }
    if (/SELECT count\(\*\) AS n FROM \S+__staging/.test(sql)) return { rows: [{ n: String(this.staging.length) }] };
    if (/SELECT count\(\*\) AS n FROM opendata_/.test(sql)) return { rows: [{ n: String(this.currentRows) }] };
    if (/max\(started_at\)/.test(sql)) return { rows: [{ at: null }] };
    if (/information_schema\.columns/.test(sql)) return { rows: [{ '?column?': 1 }] };
    return { rows: [], rowCount: 0 };
  }
  async transaction(cb: (c: any) => Promise<any>) {
    const client = {
      query: async (sql: string) => {
        this.txQueries.push(sql);
        return /count\(/.test(sql) ? this.query(sql) : { rows: [], rowCount: 1 };
      },
    };
    return cb(client);
  }
  row(i: number) { return Object.fromEntries(this.stagingCols.map((c, k) => [c, this.staging[i][k]])); }
}

function service(db: FakeDb, packageShow: any, files: Record<string, string | Buffer>) {
  const svc = new ImportTaskService(db as any) as any;
  svc.fetchJson = jest.fn(async () => packageShow);
  svc.httpGetStream = jest.fn(async (url: string) => {
    const body = files[url.split('/').pop()!];
    if (body === undefined) throw new Error(`HTTP 404 for ${url}`);
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const chunks: Buffer[] = [];
    for (let i = 0; i < buf.length; i += 11) chunks.push(buf.subarray(i, i + 11));
    return Readable.from(chunks);
  });
  svc.sleep = jest.fn(async () => {});
  return svc;
}

const source = (name: string, target: string, config: Record<string, any>) => ({
  id: 7, name, title: name, source_type: 'json_array', source_url: 'https://data.gov.ua/dataset/x',
  target_table: target, upsert_sql: null, default_threads_per_ip: 1, rate_limit_ms: 0, enabled: true,
  source_config: { replace: true, min_rows_ratio: 0.9, min_files: 1, ...config },
});

describe('runCkanMultiFileImport with tabular and API resources', () => {
  it('court_schedule: streams the ДСА TSV into staging and swaps by DELETE + INSERT', async () => {
    const pkg = { result: { resources: [{ id: 'r', name: 'Список справ', format: 'CSV', last_modified: '2026-11-01T07:04:40',
      url: 'https://data.gov.ua/dataset/3a/resource/98/download/spisok-sprav-priznachenih-do-rozglyadu.csv' }] } };
    const db = new FakeDb(2);
    const svc = service(db, pkg, { 'spisok-sprav-priznachenih-do-rozglyadu.csv': courtTsv });
    await svc.runCkanMultiFileImport(1, source('court_schedule', 'opendata_court_schedule', {
      format: 'csv', csv_delimiter: '\t', ckan_package: '3a', resource_pattern: '^spisok-sprav-priznachenih-do-rozglyadu\\.csv$',
      min_rows_ratio: 0.7,
      mapping: { hearing_date: 'date', judges: 'judges', case_number: 'case', court_name: 'court_name',
        court_room: 'court_room', case_involved: 'case_involved', case_description: 'case_description' },
    }), new AbortController().signal);
    expect(db.staging).toHaveLength(2);
    expect(db.row(1)).toMatchObject({ hearing_date: '05.05.2026 00:00', case_number: '320/9540/24' });
    expect(db.txQueries.some(q => /^DELETE FROM opendata_court_schedule$/.test(q))).toBe(true);
    expect(db.txQueries.some(q => /^INSERT INTO opendata_court_schedule \(.*\) SELECT .* FROM opendata_court_schedule__staging_1 ORDER BY _ord$/s.test(q))).toBe(true);
  });

  it('state_aid: takes only the newest XLSX snapshot and maps both EDRPOU columns', async () => {
    const xlsx = await stateAidXlsx();
    const r = (file: string, lm: string) => ({ id: file, name: file, format: 'XLSX', last_modified: lm,
      url: `https://data.gov.ua/dataset/16/resource/${file}/download/${file}` });
    const pkg = { result: { resources: [r('reestr_dd_2026_01_01-_kod.xlsx', '2026-01-08T14:05:55'),
      r('reestr_dd_27_10_2026-1.xlsx', '2026-10-27T15:33:09'), r('reestr_chynnyi_dd_do_02_08_2017.xlsx', '2023-03-14T08:31:25')] } };
    const db = new FakeDb(2);
    const svc = service(db, pkg, { 'reestr_dd_27_10_2026-1.xlsx': xlsx });
    await svc.runCkanMultiFileImport(1, source('state_aid', 'opendata_state_aid', {
      format: 'xlsx', ckan_package: '16', resource_pattern: '^reestr_dd_.*\\.xlsx$', latest_only: true, header_row: 1, skip_rows: 1,
      mapping: { row_data: '', program_name: 'nameOfProgram', provider_edrpou: 'EDRPOU', provider_name: 'theOneWhoProvidesStateAid',
        recipient_edrpou: 'EDRPOU_2', recipient_name: 'oneWhoReceivesStateAid', decision_date: 'dateOfDecision', amount: 'theAmountOfStateAid' },
      transforms: { provider_edrpou: 'trim', recipient_edrpou: 'trim', decision_date: 'iso_date', amount: 'number' },
    }), new AbortController().signal);
    expect(svc.httpGetStream).toHaveBeenCalledTimes(1);
    expect(svc.httpGetStream.mock.calls[0][0]).toMatch(/reestr_dd_27_10_2026-1\.xlsx$/);
    expect(db.staging).toHaveLength(2);
    expect(db.row(0)).toMatchObject({ provider_edrpou: '25082708', recipient_edrpou: '03328907',
      decision_date: '2022-02-24', amount: 107302000 });
    expect(JSON.parse(db.row(0).row_data)).toMatchObject({ number: 1425569, EDRPOU_2: '03328907' });
    expect(db.row(1)).toMatchObject({ provider_edrpou: '26139770', decision_date: null, amount: null });
  });

  it('nazk_corruption_offenders: reads the API resource; a field absent only in the first records is fine', async () => {
    const pkg = { result: { resources: [
      { id: 'x', name: 'XLSX', format: 'XLSX', last_modified: '2020-12-04', url: 'https://data.gov.ua/d/560e/resource/7f/download/getalldata' },
      { id: 'a', name: 'API', format: 'API', last_modified: '2021-05-06', url: 'https://corruptinfo.nazk.gov.ua/ep/1.0/corrupt/getAllData' },
    ] } };
    const decree = (id: number) => ({ id, punishmentType: { code: 1, name: 'Указ' }, entityType: { code: 0, name: 'Фізична особа' },
      indLastNameOnOffenseMoment: 'Замотін', offenseName: 'Несвоєчасне подання декларації' });
    const records = [...Array.from({ length: 40 }, (_, i) => decree(i + 1)),
      { ...decree(99), offenseId: 554453, courtCaseNumber: '359/9747/26', codexArticles: [{ codexArticleId: 18 }] }];
    const db = new FakeDb(30);
    const svc = service(db, pkg, { getAllData: JSON.stringify(records) });
    await svc.runCkanMultiFileImport(1, source('nazk_corruption_offenders', 'opendata_corruption_offenders', {
      format: 'json', ckan_package: '560e', resource_format: 'API', resource_pattern: '^getAllData$', skip_unchanged: false,
      mapping: { source_id: 'id', punishment_type: 'punishmentType.name', last_name: 'indLastNameOnOffenseMoment',
        offense_id: 'offenseId', court_case_number: 'courtCaseNumber', codex_articles: 'codexArticles' },
    }), new AbortController().signal);
    expect(svc.httpGetStream).toHaveBeenCalledTimes(1);
    expect(svc.httpGetStream.mock.calls[0][0]).toBe('https://corruptinfo.nazk.gov.ua/ep/1.0/corrupt/getAllData');
    expect(db.staging).toHaveLength(41);
    expect(db.row(0)).toMatchObject({ source_id: 1, punishment_type: 'Указ', offense_id: null });
    expect(db.row(40)).toMatchObject({ offense_id: 554453, codex_articles: '[{"codexArticleId":18}]' });
  });

  it('a header renamed at the source fails the run once, without retries, and leaves the table alone', async () => {
    const pkg = { result: { resources: [{ id: 'r', name: 'd', format: 'CSV', last_modified: '2026-03-24',
      url: 'https://data.gov.ua/d/144a/resource/3a/download/declarationcheck.csv' }] } };
    const db = new FakeDb(2);
    const svc = service(db, pkg, { 'declarationcheck.csv': 'uid,surname\n1,Абдулаєва\n2,Абраменкова\n' });
    await expect(svc.runCkanMultiFileImport(1, source('nazk_declaration_checks', 'opendata_declaration_checks', {
      format: 'csv', ckan_package: '144a', resource_pattern: '^declarationcheck\\.csv$',
      mapping: { uid: 'uid', family_name: 'familyName' },
    }), new AbortController().signal)).rejects.toThrow(/no field for family_name in any source record/);
    expect(svc.httpGetStream).toHaveBeenCalledTimes(1);
    expect(db.txQueries).toHaveLength(0);
  });

  it('refuses an unknown format before any download', async () => {
    const db = new FakeDb(2);
    const svc = service(db, { result: { resources: [] } }, {});
    await expect(svc.runCkanMultiFileImport(1, source('x', 'opendata_x', {
      format: 'xml', ckan_package: 'p', mapping: { a: 'a' },
    }), new AbortController().signal)).rejects.toThrow(/unsupported format "xml"/);
    expect(svc.fetchJson).not.toHaveBeenCalled();
  });
});

describe('startImport and disabled sources', () => {
  it('refuses a disabled source with its reason and creates no task', async () => {
    const row = { ...source('lustration', 'opendata_lustration', { disabled_reason: 'ZIP з XML, не оновлювався з 02.07.2024' }), enabled: false };
    const db = new FakeDb(0, row);
    const svc = new ImportTaskService(db as any) as any;
    svc.runImport = jest.fn();
    await expect(svc.startImport({ sourceName: 'lustration' })).rejects.toThrow(
      'Джерело "lustration" вимкнено: ZIP з XML, не оновлювався з 02.07.2024');
    expect(svc.runImport).not.toHaveBeenCalled();
    expect(db.queries.some(q => /INSERT INTO import_tasks/.test(q))).toBe(false);
  });
});
