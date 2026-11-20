import { readFileSync } from 'fs';
import { join } from 'path';
import {
  cyNameKey, cyNameSkeleton, findCyRegistrationCode, founderNames, parseCyRegistrationNumber, pickTransliterated, SKELETON_STOP,
} from '../tools/cyprus-names.js';
import { CyprusCompaniesTool, groupOfficials, nameTerms } from '../tools/cyprus-companies-tool.js';
import { cyprusFounderLines, cyprusFoundersSection, matchFounder } from '../tools/dossier-cyprus.js';
import { V2_TOOL_NAMES } from '../curated-mcp-tools.js';
import { V2_ANNOTATION_OVERRIDES } from '../v2-tool-presentation.js';

describe('Cyprus registration numbers', () => {
  it('parses HE/AE in Latin, Cyrillic and Greek letters, and bare digits', () => {
    expect(parseCyRegistrationNumber('HE455684')).toEqual({ prefix: 'HE', digits: '455684', code: 'HE455684' });
    expect(parseCyRegistrationNumber('НЕ 287592')?.code).toBe('HE287592'); // Cyrillic Н, Е
    expect(parseCyRegistrationNumber('ΗΕ-123')?.code).toBe('HE123'); // Greek Η, Ε
    expect(parseCyRegistrationNumber('ae 0999')?.code).toBe('AE999');
    expect(parseCyRegistrationNumber('123456')).toEqual({ prefix: null, digits: '123456', code: null });
    expect(parseCyRegistrationNumber('TOLDEX')).toBeNull();
  });

  it('finds a number inside an ЄДР founder line', () => {
    expect(findCyRegistrationCode('ОБДЖЕРКИ ДРАЙД ФУДЗ ЛТД НЕ 287592; резиденство: Кіпр')).toBe('HE287592');
    expect(findCyRegistrationCode('"HIQUE MANAGEMENT LTD", ІДЕНТИФІКАЦІЙНИЙ КОД - НЕ378731; резиденство: Кіпр')).toBe('HE378731');
    expect(findCyRegistrationCode('АРІСТО ДЕВЕЛОПЕРС ПЛС; HE19736; резиденство: Кіпр')).toBe('HE19736');
    expect(findCyRegistrationCode('ТОЛДЕКС ЛІМІТЕД (TOLDEX LIMITED); резиденство: Кіпр; розмір частки - 468661609,00 грн.')).toBeNull();
  });
});

describe('Cyprus names', () => {
  it('exact key ignores case, punctuation and LTD/LIMITED', () => {
    expect(cyNameKey('Toldex Ltd.')).toBe(cyNameKey('TOLDEX LIMITED'));
    expect(cyNameKey('PINDERBRIDGE SHIPPING & TRADING LTD')).toBe('PINDERBRIDGE SHIPPING AND TRADING LIMITED');
    expect(cyNameKey('TOLDEX LIMITED')).not.toBe(cyNameKey('TOLDEX HOLDINGS LIMITED'));
  });

  it('splits founder lines into Latin and Cyrillic spellings', () => {
    expect(founderNames('ТОЛДЕКС ЛІМІТЕД (TOLDEX LIMITED); резиденство: Кіпр; розмір частки - 1,00 грн.'))
      .toMatchObject({ latin: ['TOLDEX LIMITED'], cyrillic: 'ТОЛДЕКС ЛІМІТЕД' });
    expect(founderNames('КОМПАНІЯ "PENDLETON TRADING LIMITED"; резиденство: Кіпр'))
      .toMatchObject({ latin: ['PENDLETON TRADING LIMITED'], cyrillic: null });
    expect(founderNames('КОМПАНІЯ З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "РУНЕЛЬСТОН ІНВЕСТМЕНТС ЛІМІТЕД"; резиденство: Кіпр'))
      .toMatchObject({ latin: [], cyrillic: 'РУНЕЛЬСТОН ІНВЕСТМЕНТС ЛІМІТЕД' });
  });

  it('gives a transliteration and its Latin original the same skeleton', () => {
    expect(cyNameSkeleton('ЕЙНТРІВУД ІНВЕСТМЕНТС ЛІМІТЕД')).toBe(cyNameSkeleton('AINTREEWOOD INVESTMENTS LIMITED'));
    expect(cyNameSkeleton('ЛОНАР ЕНТЕРПРАЙЗЕС ЛІМІТЕД')).toBe(cyNameSkeleton('LONAR ENTERPRISES LIMITED'));
    expect(cyNameSkeleton('ЧЕЛСІДОН ТРЕЙДІНГ ЛІМІТЕД')).toBe(cyNameSkeleton('CHALCEDON TRADING LIMITED'));
    expect(cyNameSkeleton('ФОЛІОНА МЕНЕДЖМЕНТ ЛІМІТЕД')).toBe(cyNameSkeleton('FOLIONA MANAGEMENT LIMITED'));
  });

  // Outputs of cy_name_skeleton() (migration 294) on local.lex, 20.11.2026; the full
  // 502,583-name comparison showed no difference.
  it.each([
    ['TOLDEX LIMITED', 'tldks'],
    ['SONSERA HOLDINGS LTD', 'snsrldngs'],
    ['SFINAKIA. COM. LIMITED', 'sfnkm'],
    ['PENTHOUSE LTD', 'pnts'],
    ['M.G.K. PROPERTIES INVESTMENTS LIMITED', 'mgkprprtsnvstmnts'],
    ['SONATA ACCOUNTING SERVICES LIMITED', 'sntkntngsrvs'],
    ['JFLIGHT LTD', 'gflgt'],
    ['RIFFWAVE INVESTMENTS LTD', 'rfvnvstmnts'],
    ['ZELIO INVESTMENTS LIMITED', 'slnvstmnts'],
    ['SHAPWICK NOMINEES LIMITED', 'spvknmns'],
    ['NORTHBOUND ASSETS LTD', 'nrtbndsts'],
  ])('JS skeleton of %s equals the SQL function', (name, sql) => {
    expect(cyNameSkeleton(name)).toBe(sql);
  });

  it('migration 294 drops the same legal-form words as the JS skeleton', () => {
    const sql = readFileSync(join(__dirname, '../../migrations/294_cy_companies_name_skeleton.sql'), 'utf8');
    expect(sql).toContain(`\\m(${SKELETON_STOP.join('|')})\\M`);
  });

  it('picks the closest spelling among skeleton candidates, refuses a close tie', () => {
    const cands = [{ name: 'CAMENORA HOLDINGS LIMITED' }, { name: 'CUMNOR HOLDINGS LIMITED' }, { name: 'KIMONAR HOLDINGS LTD' }];
    expect(pickTransliterated('КІМОНАР ХОЛДІНГЗ ЛТД', cands)?.company.name).toBe('KIMONAR HOLDINGS LTD');
    expect(pickTransliterated('ЛІОНОРЕ КОНСАЛТАНТС ЛІМІТЕД', [{ name: 'LENORE CONSULTANTS LIMITED' }, { name: 'LIONORE CONSULTANTS LIMITED' }])?.company.name)
      .toBe('LIONORE CONSULTANTS LIMITED');
    expect(pickTransliterated('УЦР ХОЛДИНГ ЛТД', [{ name: 'TESSORO HOLDING LIMITED' }])).toBeNull();
  });

  it('search terms drop legal-form words and short words', () => {
    expect(nameTerms('Toldex Ltd')).toEqual(['TOLDEX']);
    expect(nameTerms('limited')).toEqual(['LIMITED']);
    expect(nameTerms('a b')).toEqual([]);
  });
});

/** Fake DB answering the tool's queries from a small register. */
function fakeDb() {
  const companies = [
    { org_type_code: 'C', registration_no: '455684', registration_code: 'HE455684', name: 'TOLDEX LIMITED', org_type: 'Εταιρεία', org_sub_type: 'Ιδιωτική',
      registration_date: '2023-01-10', status: 'Εγγεγραμμένη', status_date: null, address_seq_no: 7, snapshot_date: '2026-11-02',
      source_url: 'https://www.data.gov.cy/sites/default/files/organisations_103.csv',
      street: 'Αρχ. Μακαρίου ΙΙΙ, 155', building: 'PROTEAS HOUSE', territory: '3026, Λεμεσός, Κύπρος', office_snapshot_date: '2026-11-02',
      office_source_url: 'https://www.data.gov.cy/sites/default/files/registered_office_102.csv' },
    { org_type_code: 'C', registration_no: '1', registration_code: 'HE1', name: 'TOLDEX HOLDINGS LTD', org_type: 'Εταιρεία', org_sub_type: 'Ιδιωτική',
      registration_date: '2001-01-10', status: 'Διαγραμμένη', status_date: '2010-05-01', address_seq_no: null, snapshot_date: '2026-11-02',
      source_url: 'https://www.data.gov.cy/sites/default/files/organisations_103.csv' },
  ];
  const officials = [
    { org_type_code: 'C', registration_no: '455684', person_name: 'ANDREAS GEORGIOU', position: 'Διευθυντής', snapshot_date: '2026-11-02', source_url: 'o.csv' },
    { org_type_code: 'C', registration_no: '455684', person_name: 'ANDREAS GEORGIOU', position: 'Γραμματέας', snapshot_date: '2026-11-02', source_url: 'o.csv' },
    { org_type_code: 'C', registration_no: '455684', person_name: 'ZETA SECRETARIAL LTD', position: 'Γραμματέας', snapshot_date: '2026-11-02', source_url: 'o.csv' },
  ];
  const calls: Array<{ sql: string; params: any[] }> = [];
  const like = (v: string, pat: string) => v.toUpperCase().includes(pat.replace(/%/g, '').toUpperCase());
  return {
    calls,
    async query(sql: string, params: any[] = []) {
      calls.push({ sql, params });
      if (/FROM cy_officials p\s+JOIN unnest/.test(sql)) {
        const keys = new Set(params[0].map((t: string, i: number) => `${t}|${params[1][i]}`));
        const pats = params.slice(2);
        return { rows: officials.filter((o) => keys.has(`${o.org_type_code}|${o.registration_no}`) && pats.every((p: string) => like(o.person_name, p))) };
      }
      if (/WITH m AS/.test(sql)) {
        const pats = params.slice(0, -1).filter((p) => typeof p === 'string');
        const keys = new Set(officials.filter((o) => pats.every((p: string) => like(o.person_name, p))).map((o) => `${o.org_type_code}|${o.registration_no}`));
        const rows = companies.filter((c) => keys.has(`${c.org_type_code}|${c.registration_no}`));
        return { rows: rows.map((r) => ({ ...r, _total: rows.length })) };
      }
      if (/registration_code = \$1/.test(sql)) {
        const rows = companies.filter((c) => c.registration_code === params[0]);
        return { rows: rows.map((r) => ({ ...r, _total: rows.length })) };
      }
      if (/cy_name_skeleton\(c\.name\) = \$1/.test(sql)) {
        return { rows: companies.filter((c) => cyNameSkeleton(c.name) === params[0]) };
      }
      if (/c\.name ILIKE/.test(sql)) {
        const pats = params.filter((p) => typeof p === 'string' && p.startsWith('%'));
        const rows = companies.filter((c) => pats.every((p: string) => like(c.name, p)));
        return { rows: rows.map((r) => ({ ...r, _total: rows.length })) };
      }
      return { rows: [] };
    },
  };
}

const run = async (tool: CyprusCompaniesTool, args: any) => JSON.parse((await tool.executeTool('search_cyprus_companies', args))!.content[0].text);

describe('search_cyprus_companies', () => {
  it('is on the v2 whitelist with read-only annotations', () => {
    expect(V2_TOOL_NAMES.has('search_cyprus_companies')).toBe(true);
    expect(V2_ANNOTATION_OVERRIDES.search_cyprus_companies).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const def = new CyprusCompaniesTool(fakeDb()).getToolDefinitions()[0];
    expect(def.description).not.toMatch(/викликайте|search_|get_|openreyestr_/);
  });

  it('finds a company by HE number typed in Cyrillic, with office, officials and provenance', async () => {
    const out = await run(new CyprusCompaniesTool(fakeDb()), { query: 'НЕ 455684' });
    expect(out.match_basis).toBe('registration_number');
    expect(out.total_count).toBe(1);
    const r = out.results[0];
    expect(r).toMatchObject({
      registration_code: 'HE455684', name: 'TOLDEX LIMITED', status: 'Зареєстрована', status_original: 'Εγγεγραμμένη', dissolved: false,
      org_sub_type: 'приватна', registration_date: '2023-01-10',
      registered_office: { building: 'PROTEAS HOUSE', snapshot_date: '2026-11-02' },
      source: { snapshot_date: '2026-11-02', source_url: expect.stringContaining('organisations_103.csv'), officials_snapshot_date: '2026-11-02' },
    });
    expect(r.officials).toEqual([
      expect.objectContaining({ name: 'ANDREAS GEORGIOU', positions: ['Директор', 'Секретар'] }),
      expect.objectContaining({ name: 'ZETA SECRETARIAL LTD', positions: ['Секретар'] }),
    ]);
    expect(out.source.as_of).toBe('2026-11-02');
  });

  it('exact name mode keeps only the same name', async () => {
    const out = await run(new CyprusCompaniesTool(fakeDb()), { query: 'Toldex Ltd.', name_match: 'exact' });
    expect(out.results.map((r: any) => r.name)).toEqual(['TOLDEX LIMITED']);
  });

  it('a Cyrillic query is searched by transliteration and says so', async () => {
    const out = await run(new CyprusCompaniesTool(fakeDb()), { query: 'ТОЛДЕКС ЛІМІТЕД' });
    expect(out.match_basis).toBe('transliteration');
    expect(out.results[0]).toMatchObject({ name: 'TOLDEX LIMITED', match_score: 0.71 }); // toldeks vs toldex
    expect(out.caveat).toMatch(/транслітерац/);
  });

  it('finds companies by official and lists the matching official', async () => {
    const out = await run(new CyprusCompaniesTool(fakeDb()), { person_name: 'andreas georgiou' });
    expect(out.match_basis).toBe('official');
    expect(out.results[0].matched_officials[0]).toMatchObject({ name: 'ANDREAS GEORGIOU' });
  });

  it('caps the limit and passes status filters as parameters', async () => {
    const db = fakeDb();
    await run(new CyprusCompaniesTool(db), { query: 'toldex', limit: 1000, status: 'active' });
    const q = db.calls[0];
    expect(q.sql).toMatch(/LIMIT 25 OFFSET 0/);
    expect(q.sql).toMatch(/NOT \(c\.status = ANY\(\$3\)\)/);
    expect(q.params[2]).toContain('Διαγραμμένη');
  });

  it('rejects an unusable registration number and an empty request in Ukrainian', async () => {
    const tool = new CyprusCompaniesTool(fakeDb());
    expect((await run(tool, { registration_number: 'XX-1' })).message).toMatch(/не схоже/);
    expect((await run(tool, {})).message).toMatch(/Вкажіть/);
  });

  it('groups positions per person, directors first', () => {
    const g = groupOfficials([
      { person_name: 'B', position: 'Γραμματέας' }, { person_name: 'A', position: 'Διευθυντής' }, { person_name: 'B', position: 'Διευθυντής' },
    ]);
    expect(g.map((p) => [p.name, p.positions])).toEqual([['A', ['Директор']], ['B', ['Секретар', 'Директор']]]);
  });
});

describe('dossier: founders from Cyprus', () => {
  const viaTool = (db = fakeDb()) => {
    const tool = new CyprusCompaniesTool(db);
    return async (name: string, args: any) => {
      const res = await tool.executeTool(name, args);
      return { status: 'ok' as const, data: JSON.parse(res!.content[0].text) };
    };
  };

  it('keeps only legal entities resident in Cyprus', () => {
    expect(cyprusFounderLines({ founders: [
      { founder_info: 'ТОЛДЕКС ЛІМІТЕД (TOLDEX LIMITED); резиденство: Кіпр; розмір частки - 1,00 грн.' },
      { founder_info: 'ПАТСІАС ЛОІЗОС; громадянство: Кіпр; розмір частки - 1000,00 грн.' },
      { founder_info: 'НАВТЕК ГМБХ; резиденство: Німеччина' },
    ] })).toHaveLength(1);
  });

  it('matches by number, then by Latin name, then by transliteration, naming the basis', async () => {
    const call = viaTool();
    expect(await matchFounder('КОМПАНІЯ "ТОЛДЕКС ЛІМІТЕД" (НЕ 455684); резиденство: Кіпр', call))
      .toMatchObject({ match_basis: 'registration_number', company: { registration_code: 'HE455684' } });
    expect(await matchFounder('ТОЛДЕКС ЛІМІТЕД (TOLDEX LIMITED); резиденство: Кіпр', call))
      .toMatchObject({ match_basis: 'exact_name', company: { name: 'TOLDEX LIMITED' } });
    const t = await matchFounder('КОМПАНІЯ "ТОЛДЕКС ЛІМІТЕД"; резиденство: Кіпр', call);
    expect(t).toMatchObject({ match_basis: 'transliteration', company: { name: 'TOLDEX LIMITED' } });
    expect(t.caveat).toMatch(/Перевірте/);
    expect(await matchFounder('КОМПАНІЯ "НЕВІДОМА ЛІМІТЕД"; резиденство: Кіпр', call)).toMatchObject({ match_basis: null });
  });

  it('builds a dossier section with source and as-of date; a failed lookup is not "nothing found"', async () => {
    const details = { status: 'ok' as const, data: { founders: [{ founder_info: 'ТОЛДЕКС ЛІМІТЕД (TOLDEX LIMITED); резиденство: Кіпр' }] } };
    const s = await cyprusFoundersSection(details, viaTool());
    expect(s).toMatchObject({ status: 'found', count: 1, founders_total: 1, source: { tool: 'search_cyprus_companies', as_of: '2026-11-02' } });

    const down = await cyprusFoundersSection(details, async () => ({ status: 'timeout', data: null }));
    expect(down.status).toBe('error');
    expect(down.message).toMatch(/невідомий/);

    const none = await cyprusFoundersSection({ status: 'ok', data: { founders: [] } }, viaTool());
    expect(none).toMatchObject({ status: 'empty', count: 0 });
    expect((await cyprusFoundersSection(null, viaTool())).status).toBe('unavailable');
  });
});
