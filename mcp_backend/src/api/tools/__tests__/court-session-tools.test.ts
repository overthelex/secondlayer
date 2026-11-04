/**
 * search_court_hearing_schedule after the ZakonOnline leg was retired (LEXAI-2193).
 * source=api used to call the local EDRSR decisions adapter with session parameters and
 * always returned 0; now every source reads opendata_court_schedule.
 */
import { CourtSessionTools, looksLikeCaseNumber, HEARING_DAY_SQL } from '../court-session-tools.js';

jest.mock('../../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const parse = (r: any) => JSON.parse(r.content[0].text);

function setup(rows: any[] = []) {
  const calls: Array<{ sql: string; values: any[] }> = [];
  const adapter = { searchCourtDecisions: jest.fn() };
  const db = { query: jest.fn(async (sql: string, values: any[]) => { calls.push({ sql, values }); return { rows }; }) };
  return { tool: new CourtSessionTools(adapter as any, db), adapter, calls };
}

describe('search_court_hearing_schedule (LEXAI-2193)', () => {
  it('source=api with a case number searches the opendata schedule by case_number', async () => {
    const { tool, adapter, calls } = setup([{ case_number: '910/5220/26' }]);
    const res = parse(await tool.executeTool('search_court_hearing_schedule', { query: '910/5220/26', source: 'api' }));
    expect(adapter.searchCourtDecisions).not.toHaveBeenCalled();
    expect(calls[0].sql).toContain('case_number = $1');
    expect(calls[0].values[0]).toBe('910/5220/26');
    expect(res.sessions_found).toBe(1);
    expect(res.source).toBe('opendata');
  });

  it('a name in query is matched against participants', async () => {
    const { tool, calls } = setup();
    await tool.executeTool('search_court_hearing_schedule', { query: 'Гарантований покупець' });
    expect(calls[0].sql).toContain('case_involved ILIKE $1');
    expect(calls[0].values[0]).toBe('%Гарантований покупець%');
  });

  it('asks for a filter instead of reporting "not found" when given none', async () => {
    const { tool, calls } = setup();
    const r: any = await tool.executeTool('search_court_hearing_schedule', {});
    expect(r.content[0].text).toMatch(/Вкажіть/);
    expect(calls).toHaveLength(0);
  });

  it('recognises case-number shapes', () => {
    for (const n of ['910/5220/26', '352/923/16-ц', '922/989/18', '757/17194/23-ц']) expect(looksLikeCaseNumber(n)).toBe(true);
    for (const n of ['Нова Пошта', 'Іваненко', '2025']) expect(looksLikeCaseNumber(n)).toBe(false);
  });
});

describe('review fixes (LEXAI-2193)', () => {
  it('the schema no longer defaults target, so a case number is detected', async () => {
    const { tool } = setup();
    const def = tool.getToolDefinitions().find((d: any) => d.name === 'search_court_hearing_schedule')!;
    expect((def.inputSchema as any).properties.target.default).toBeUndefined();
  });

  it('date bounds compare the parsed day, not the «DD.MM.YYYY» text', async () => {
    const { tool, calls } = setup();
    await tool.executeTool('search_court_hearing_schedule', { court_name: 'Київ', date_from: '2026-05-01', date_to: '2026-05-31' });
    expect(calls[0].sql).toContain(`${HEARING_DAY_SQL} >= $`);
    expect(calls[0].sql).toMatch(/<= \$\d+::date/);
    expect(calls[0].sql).not.toMatch(/hearing_date >= \$/);
  });
});
