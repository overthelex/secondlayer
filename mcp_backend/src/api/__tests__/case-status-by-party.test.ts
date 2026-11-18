/**
 * search_case_status_by_party / get_case_status_details: party matching, region filter,
 * grouping by case, the "too broad" / "no results" / DB-error distinction, and the source
 * fallback from court_case_status_history (migration 278) to the daily snapshot table.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { logger } from '../../utils/logger.js';
import {
  buildTsQuery,
  canonicalRole,
  matchParticipants,
  parsePartyQuery,
  resolveRegion,
  splitParticipants,
  stemQuery,
  REGIONS,
} from '../tools/court-party-match';
import {
  CourtStatusTools,
  STATUS_ROW_CAP,
  attachHearings,
  baseCaseNumber,
  caseKey,
  caseNumberVariants,
  caseSuffix,
  groupPartyRows,
  isValidIsoDate,
  lastAndNext,
  partyHash,
} from '../tools/court-status-tools';

const P1 = 'відповідач: Яворська Лариса Григорівна,  позивач: ПАТ КБ "Приватбанк",  Представник позивача: Сафір Федір Олегович';

describe('party query parsing', () => {
  it('splits words and initials and drops legal-form abbreviations', () => {
    expect(parsePartyQuery('Яворська Л.Г.')).toEqual({ words: ['яворська'], initials: ['л', 'г'], droppedForms: [] });
    expect(parsePartyQuery('ПАТ КБ "Приватбанк"')).toEqual({ words: ['приватбанк'], initials: [], droppedForms: ['пат', 'кб'] });
    // Only forms → kept, so the query is never empty.
    expect(parsePartyQuery('ТОВ').words).toEqual(['тов']);
  });

  it('builds an AND tsquery with prefix initials', () => {
    expect(buildTsQuery(parsePartyQuery('Яворська Л.Г.'))).toBe("'яворська' & 'л':* & 'г':*");
    expect(buildTsQuery(parsePartyQuery("Кондрат'єва Софія"))).toBe("'кондрат' & 'єва' & 'софія'");
  });
});

describe('participants parsing and matching', () => {
  it('splits "role: name" segments, keeping commas inside names', () => {
    const segs = splitParticipants('позивач: ТОВ "Альфа, Бета",  відповідач: Іванов Іван Іванович');
    expect(segs).toEqual([
      { label: 'позивач', name: 'ТОВ "Альфа, Бета"' },
      { label: 'відповідач', name: 'Іванов Іван Іванович' },
    ]);
    expect(splitParticipants('-')).toEqual([{ label: null, name: '-' }]);
  });

  it('a role label with a comma ("особа, яка …") stays one label, not a fake party', () => {
    const t = 'особа, яка притягається до адміністративної відповідальності: Іванов Іван Іванович';
    expect(splitParticipants(t)).toEqual([
      { label: 'особа, яка притягається до адміністративної відповідальності', name: 'Іванов Іван Іванович' },
    ]);
    const t2 = 'потерпілий: Петров Петро Петрович, особа, що притягується до адміністративної відповідальності: Іванов Іван';
    expect(splitParticipants(t2)).toEqual([
      { label: 'потерпілий', name: 'Петров Петро Петрович' },
      { label: 'особа, що притягується до адміністративної відповідальності', name: 'Іванов Іван' },
    ]);
    const m = matchParticipants(t, parsePartyQuery('Іванов'));
    expect(m).toHaveLength(1);
    expect(m[0].role).toBe('особа, яка притягається до адміністративної відповідальності');
    // "особа" alone never becomes a matchable party.
    expect(matchParticipants(t, parsePartyQuery('особа'))).toEqual([]);
  });

  it('canonicalises roles', () => {
    expect(canonicalRole('Представник позивача')).toBe('представник позивача');
    expect(canonicalRole('Позивач (заявник)')).toBe('позивач');
    expect(canonicalRole('відповідач (боржник)')).toBe('відповідач');
    expect(canonicalRole('3-я особа')).toBe('третя особа');
    expect(canonicalRole('яка притягається до адмін. відповідальності')).toBe('особа, яка притягається до адмін. відповідальності');
  });

  it('matches a company and tags its role', () => {
    const m = matchParticipants(P1, parsePartyQuery('Приватбанк'));
    expect(m).toEqual([{ role: 'позивач', role_label: 'позивач', name: 'ПАТ КБ "Приватбанк"', match_variant: 'повний збіг' }]);
    // Quote glued to the name in the source: КБ"Приватбанк".
    expect(matchParticipants('позивач: ПАТ КБ"Приватбанк"', parsePartyQuery('приватбанк'))[0].role).toBe('позивач');
  });

  it('full name, surname only, and initials variants', () => {
    expect(matchParticipants(P1, parsePartyQuery('Яворська Лариса Григорівна'))[0].match_variant).toBe('повний збіг');
    expect(matchParticipants(P1, parsePartyQuery('Яворська'))[0].match_variant).toBe('усі слова запиту');
    const ini = matchParticipants(P1, parsePartyQuery('Яворська Л.Г.'));
    expect(ini).toHaveLength(1);
    expect(ini[0]).toMatchObject({ role: 'відповідач', match_variant: 'прізвище + ініціали' });
    expect(matchParticipants(P1, parsePartyQuery('Яворська Л.П.'))).toEqual([]);
    expect(matchParticipants(P1, parsePartyQuery('Л.Г. Яворська'))).toHaveLength(1);
  });

  it('initials skip apostrophes inside a first name', () => {
    expect(matchParticipants("позивач: Яворська Мар'яна Григорівна", parsePartyQuery('Яворська М.Г.'))).toHaveLength(1);
  });

  it('rejects words spread across different parties', () => {
    expect(matchParticipants(P1, parsePartyQuery('Яворська Федір'))).toEqual([]);
  });
});

describe('inflected names (stem fallback)', () => {
  it('cuts long words to a prefix stem, leaves short ones and numbers', () => {
    expect(stemQuery(parsePartyQuery('Яворської Л.Г.'))).toEqual({ words: ['яворськ'], initials: ['л', 'г'], droppedForms: [], prefix: true });
    // «Тараса» → «тара» would be shorter than 5 letters, so it stays whole.
    expect(stemQuery(parsePartyQuery('Шевченка Тараса'))!.words).toEqual(['шевчен', 'тараса']);
    expect(stemQuery(parsePartyQuery('Іванов'))).toBeNull();
    expect(buildTsQuery(stemQuery(parsePartyQuery('Приватбанку'))!)).toBe("'приватбан':*");
  });

  it('matches the nominative form and tags the variant', () => {
    const m = matchParticipants(P1, stemQuery(parsePartyQuery('Яворської Л.Г.'))!);
    expect(m).toHaveLength(1);
    expect(m[0].name).toBe('Яворська Лариса Григорівна');
    expect(m[0].match_variant).toBe('інша форма слова (відмінок)');
    expect(matchParticipants(P1, stemQuery(parsePartyQuery('Яворської О.Г.'))!)).toEqual([]);
  });
});

describe('regions', () => {
  it('resolves oblasts and Kyiv without confusing them', () => {
    expect(resolveRegion('Київ')?.name).toBe('м. Київ');
    expect(resolveRegion('м. Київ')?.name).toBe('м. Київ');
    expect(resolveRegion('Київська обл.')?.name).toBe('Київська область');
    expect(resolveRegion('Львівська область')?.name).toBe('Львівська область');
    expect(resolveRegion('Кропивницький')?.name).toBe('Кіровоградська область');
    expect(resolveRegion('Марс')).toBeNull();
    expect(REGIONS.filter((r) => r.name.endsWith('область'))).toHaveLength(24);
  });

  it('Kyiv city and Kyiv oblast select the right courts (names as stored on prod)', () => {
    // ILIKE pattern → case-insensitive regex.
    const like = (pat: string) => new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'iu');
    const hits = (region: string, court: string) => resolveRegion(region)!.patterns.some((p) => like(p).test(court));
    const city = ['Печерський районний суд міста Києва', 'Господарський суд м. Києва', 'Окружний адміністративний суд міста Києва',
      'Київський апеляційний суд'];
    const oblastCourts = ['Броварський міськрайонний суд Київської області', 'Господарський суд Київської області',
      'Київський окружний адміністративний суд', 'Київський апеляційний суд'];
    const neither = ['Київський районний суд м. Одеси', 'Київський районний суд м. Полтави', 'Київський районний суд м.Харкова'];
    for (const c of city) expect([c, hits('м. Київ', c)]).toEqual([c, true]);
    for (const c of oblastCourts) expect([c, hits('Київська область', c)]).toEqual([c, true]);
    expect(hits('м. Київ', 'Київський окружний адміністративний суд')).toBe(false);
    expect(hits('Київська область', 'Окружний адміністративний суд міста Києва')).toBe(false);
    expect(hits('Київська область', 'Печерський районний суд міста Києва')).toBe(false);
    for (const c of neither) {
      expect([c, hits('м. Київ', c)]).toEqual([c, false]);
      expect([c, hits('Київська область', c)]).toEqual([c, false]);
    }
  });

  it('oblast patterns cover first-instance, appellate and administrative courts', () => {
    expect(resolveRegion('Дніпропетровська')?.patterns).toEqual([
      '%Дніпропетровської області%', '%Дніпровський апеляційний%', '%Дніпропетровський окружний%',
    ]);
  });
});

describe('case-number helpers', () => {
  it('base number drops the proceeding suffix', () => {
    expect(baseCaseNumber(' 533/318/15-Ц')).toBe('533/318/15');
    expect(baseCaseNumber('2-747/11')).toBe('2-747/11');
  });
  it('variants try common suffixes only when nothing is known', () => {
    expect(caseNumberVariants('533/318/15')).toEqual(expect.arrayContaining(['533/318/15', '533/318/15-ц', '533/318/15-к']));
    expect(caseNumberVariants('533/318/15', ['533/318/15-ц'])).toEqual(['533/318/15', '533/318/15-ц']);
  });
  it('a bare known spelling does not suppress suffix probing; a suffixed one does', () => {
    // The status table stores "533/318/15", the archive "533/318/15-ц": still probe.
    expect(caseNumberVariants('533/318/15', ['533/318/15'])).toEqual(expect.arrayContaining(['533/318/15-ц', '533/318/15-а']));
    expect(caseNumberVariants('533/318/15', ['533/318/15', '533/318/15-а'])).toEqual(['533/318/15', '533/318/15-а']);
    expect(caseNumberVariants('533/318/15-ц')).toEqual(['533/318/15-ц', '533/318/15']);
  });
  it('the proceeding suffix is part of the case identity, stray punctuation is not', () => {
    expect(caseSuffix('530/1730/16-Ц.')).toBe('ц');
    expect(caseSuffix('530/1730/16')).toBe('');
    expect(caseKey('Суд', '530/1730/16-ц')).toBe(caseKey(' суд ', '530/1730/16-ц,'));
    expect(caseKey('Суд', '530/1730/16-ц')).not.toBe(caseKey('Суд', '530/1730/16-а'));
    expect(caseKey('Суд', '530/1730/16-ц')).not.toBe(caseKey('Суд', '530/1730/16'));
  });
  it('validates calendar dates', () => {
    expect(isValidIsoDate('2024-02-29')).toBe(true);
    expect(isValidIsoDate('2023-02-29')).toBe(false);
    expect(isValidIsoDate('2024-02-31')).toBe(false);
    expect(isValidIsoDate('2024-13-01')).toBe(false);
    expect(isValidIsoDate('2024-04-31')).toBe(false);
    expect(isValidIsoDate('2024-12-31')).toBe(true);
  });
  it('splits hearings into last and next around today', () => {
    const h = (date: string) => ({ date, time: '10:00', court: 'c', case_number: 'n', judge: null, form: null, room: null });
    const r = lastAndNext([h('2026-01-01'), h('2026-12-01'), h('2026-11-10'), h('2027-01-01')], '2026-11-18');
    expect(r.last?.date).toBe('2026-11-10');
    expect(r.next?.date).toBe('2026-12-01');
  });
});

// ---------------------------------------------------------------------------------------

type Handler = (sql: string, values: any[]) => any[] | Error;

function makeDb(handler: Handler, opts: { history?: boolean } = {}) {
  const calls: Array<{ sql: string; values: any[] }> = [];
  const run = async (sql: string, values: any[] = []) => {
    calls.push({ sql, values });
    if (sql.includes('to_regclass')) return { rows: [{ present: opts.history ?? true }] };
    if (sql.includes('has_rows')) return { rows: [{ has_rows: opts.history ?? true }] };
    if (sql.includes('court_case_status_snapshots')) return { rows: [{ snapshot_name: 'stan-17-11-2026.zip', loaded: '2026-11-17' }] };
    if (sql.includes('max(session_date)')) return { rows: [{ d: '2026-11-17' }] };
    if (sql.includes('max(imported_at)')) return { rows: [{ d: '2026-11-16' }] };
    if (sql.startsWith('SET LOCAL')) return { rows: [] };
    const out = handler(sql, values);
    if (out instanceof Error) throw out;
    return { rows: out };
  };
  const db = {
    query: jest.fn(run),
    transaction: jest.fn(async (cb: any) => cb({ query: run })),
  };
  return { db, calls };
}

const statusRow = (o: Partial<any> = {}) => ({
  court_name: 'Козельщинський районний суд Полтавської області',
  case_number: '533/318/15-ц',
  case_proc: '2/533/102/15',
  reg_key: '20150407',
  judge: 'Іваненко І.І.',
  judges: null,
  participants: 'позивач: ПАТ КБ"Приватбанк",  Представник позивача: Сафір Федір Олегович,  відповідач: Кійченко Олександр Миколайович',
  stage_key: '20150605',
  stage_name: 'Виконання рішення',
  cause_result: null,
  cause_dep: null,
  case_type: 'на цивільну справу (позовне провадження)',
  description: 'Про стягнення заборгованості по кредиту',
  last_seen: '2026-11-17',
  ...o,
});

const parse = (r: any) => JSON.parse(r.content[0].text);
const isStatusSql = (sql: string) => sql.includes('participants IS NOT NULL') || /FROM (court_case_status_history|opendata_court_case_status)/.test(sql);
const isPartySessions = (sql: string) => sql.includes("to_tsvector('simple', involved_parties)");
const isHearingLookup = (sql: string) => sql.includes("'g')) = ANY($1::text[])");

describe('search_case_status_by_party', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('validates input and never logs the party in plain text', async () => {
    const { db } = makeDb(() => []);
    const tool = new CourtStatusTools(db);
    expect((await tool.executeTool('search_case_status_by_party', { party: 'ab' }) as any).isError).toBe(true);
    expect((await tool.executeTool('search_case_status_by_party', { party: 'Л. Г.' }) as any).isError).toBe(true);
    const bad = await tool.executeTool('search_case_status_by_party', { party: 'Приватбанк', region: 'Марс' }) as any;
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('Невідомий регіон');

    await tool.executeTool('search_case_status_by_party', { party: 'Приватбанк' });
    const logged = JSON.stringify((logger.info as jest.Mock).mock.calls);
    expect(logged).not.toMatch(/приватбанк/i);
    expect(logged).toContain(partyHash('Приватбанк'));
  });

  it('queries the history table through the GIN expression with region filter and groups by case', async () => {
    const { db, calls } = makeDb((sql) => {
      if (isStatusSql(sql)) {
        return [
          statusRow(),
          statusRow({ stage_key: '20150410', stage_name: 'Зареєстровано' }),
          // Words of the query in different parties → dropped.
          statusRow({ case_number: '533/1/16-ц', participants: 'позивач: Приватний Петро, відповідач: Банк' }),
        ];
      }
      if (isPartySessions(sql)) return [];
      if (isHearingLookup(sql)) {
        return [{ case_number: '533/318/15-ц', court_name: 'Козельщинський районний суд Полтавської області',
          judge_name: 'Іваненко І.І.', session_date: '2015-05-20', session_time: '10:00', session_form: null, session_place: null }];
      }
      return [];
    });
    const res = parse(await new CourtStatusTools(db).executeTool('search_case_status_by_party', { party: 'ПАТ КБ Приватбанк', region: 'Полтавська' }));

    const st = calls.find((c) => c.sql.includes('participants IS NOT NULL AND') && c.sql.includes('FROM court_case_status_history'))!;
    expect(st.sql).toContain("participants IS NOT NULL AND to_tsvector('simple', participants) @@ to_tsquery('simple', $1)");
    expect(st.sql).toContain('court_name ILIKE ANY($2::text[])');
    expect(st.values[0]).toBe("'приватбанк'");
    expect(st.values[1]).toContain('%Полтавської області%');
    expect(calls.some((c) => c.sql === 'SET LOCAL enable_indexscan = off')).toBe(true);

    expect(res.status).toBe('ok');
    expect(res.total_found).toBe(1);
    const r = res.results[0];
    expect(r).toMatchObject({
      court: 'Козельщинський районний суд Полтавської області',
      case_number: '533/318/15-ц',
      case_proc: '2/533/102/15',
      registration_date: '2015-04-07',
      subject: 'Про стягнення заборгованості по кредиту',
      last_stage: { name: 'Виконання рішення', date: '2015-06-05', cause_result: null },
      stage_events_seen: 2,
      verify_url: 'https://court.gov.ua/fair/',
    });
    expect(r.matched_parties).toEqual([{ role: 'позивач', name: 'ПАТ КБ"Приватбанк"', match_variant: 'повний збіг' }]);
    expect(r.last_hearing.date).toBe('2015-05-20');
    expect(r.sources).toEqual(['ДСА: стан розгляду справ (відкриті дані)']);
    expect(res.query.ignored_legal_forms).toEqual(['пат', 'кб']);
    expect(res.as_of).toEqual({ case_status: '2026-11-17', case_status_snapshot: 'stan-17-11-2026.zip', hearings_archive: '2026-11-17' });
    expect(res.coverage_note).toContain('НЕ означає');
    expect(res.matching_note).toContain('Відкинуто записів');
  });

  it('keeps -ц and -а proceedings of one court apart; a bare spelling joins only an unambiguous case', () => {
    const q = parsePartyQuery('Приватбанк');
    const one = groupPartyRows([
      statusRow({ case_number: '533/318/15-ц', stage_key: '20150605' }),
      statusRow({ case_number: '533/318/15', stage_key: '20150410', stage_name: 'Зареєстровано' }),
    ], [], q).groups;
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ case_number: '533/318/15-ц', stage_events_seen: 2 });
    expect(one[0].last_stage!.date).toBe('2015-06-05');

    const two = groupPartyRows([
      statusRow({ case_number: '533/318/15-ц', stage_name: 'Цивільна' }),
      statusRow({ case_number: '533/318/15-а', stage_name: 'Адмін', participants: 'позивач: ПАТ КБ "Приватбанк", відповідач: ДПС' }),
      statusRow({ case_number: '533/318/15', stage_name: 'Без суфікса' }),
    ], [], q).groups;
    expect(two.map((g) => g.case_number).sort()).toEqual(['533/318/15', '533/318/15-а', '533/318/15-ц']);
    expect(two.find((g) => g.case_number === '533/318/15-а')!.participants).toContain('ДПС');

    // Hearings: exact proceeding first, a bare archive number only to the single case of that base.
    const h = (case_number: string, session_date: string) => ({ case_number, session_date, session_time: '10:00',
      court_name: 'Козельщинський районний суд Полтавської області', judge_name: null, session_form: null, session_place: null });
    attachHearings(two, [h('533/318/15-а', '2015-07-01'), h('533/318/15', '2015-07-02')]);
    expect(two.find((g) => g.case_number === '533/318/15-а')!.hearings.map((x) => x.date)).toEqual(['2015-07-01']);
    expect(two.find((g) => g.case_number === '533/318/15-ц')!.hearings).toEqual([]);
    expect(two.find((g) => g.case_number === '533/318/15')!.hearings.map((x) => x.date)).toEqual(['2015-07-02']);

    attachHearings(one, [h('533/318/15', '2015-08-01'), h('533/318/15-ц', '2015-08-02'), h('533/318/15-а', '2015-08-03')]);
    expect(one[0].hearings.map((x) => x.date)).toEqual(['2015-08-01', '2015-08-02']);
  });

  it('rejects impossible calendar dates in Ukrainian before querying', async () => {
    const { db, calls } = makeDb(() => []);
    const tool = new CourtStatusTools(db);
    const bad = await tool.executeTool('search_case_status_by_party', { party: 'Приватбанк', date_from: '2024-02-31' }) as any;
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('не існує');
    const fmt = await tool.executeTool('search_case_status_by_party', { party: 'Приватбанк', date_to: '31.02.2024' }) as any;
    expect(fmt.content[0].text).toContain('YYYY-MM-DD');
    const order = await tool.executeTool('search_case_status_by_party', { party: 'Приватбанк', date_from: '2025-01-02', date_to: '2025-01-01' }) as any;
    expect(order.isError).toBe(true);
    expect(calls.some((c) => isStatusSql(c.sql))).toBe(false);
  });

  it('merges cases found only in the hearing archive', async () => {
    const { db } = makeDb((sql) => {
      if (isStatusSql(sql)) return [];
      if (isPartySessions(sql)) {
        return [{ case_number: '  201/8176/21-ц', court_name: 'Печерський районний суд міста Києва', judge_name: 'Бусик О.Л.',
          session_date: '2027-02-15', session_time: '14:00', session_form: null, session_place: null,
          involved_parties: 'Позивач: Дьомочкіна Лілія Іванівна, відповідач: Акціонерне товариство комерційний банк "ПриватБанк"' }];
      }
      return [];
    });
    const res = parse(await new CourtStatusTools(db).executeTool('search_case_status_by_party', { party: 'Приватбанк' }));
    expect(res.total_found).toBe(1);
    expect(res.results[0]).toMatchObject({ case_number: '201/8176/21-ц', sources: ['розклад засідань'], last_stage: null });
    expect(res.results[0].matched_parties[0].role).toBe('відповідач');
    expect(res.results[0].next_hearing.date).toBe('2027-02-15');
  });

  it('flags a capped result set as too broad but still returns the first page', async () => {
    const rows = Array.from({ length: STATUS_ROW_CAP }, (_, i) => statusRow({ case_number: `533/${i}/15-ц` }));
    const { db, calls } = makeDb((sql) => {
      if (sql.includes('count(*)::int AS n')) return [{ n: 16734 }];
      return isStatusSql(sql) ? rows : [];
    });
    const res = parse(await new CourtStatusTools(db).executeTool('search_case_status_by_party', { party: 'Приватбанк', region: 'Полтавська', limit: 10, offset: 20 }));
    expect(res.status).toBe('too_broad');
    expect(res.total_is_lower_bound).toBe(true);
    expect(res.estimated_total_cases).toBe(16734);
    expect(res.message).toContain('близько 16734');
    // One count over both sources; session placeholders shifted past the status ones.
    const count = calls.find((c) => c.sql.includes('count(*)::int AS n'))!;
    expect(count.sql).toContain('UNION SELECT court_name');
    expect(count.sql).toContain('$3');
    expect(count.sql).not.toMatch(/LIMIT/);
    expect(count.values).toHaveLength(4);
    expect(res.returned).toBe(10);
    expect(res.offset).toBe(20);
    expect(res.has_more).toBe(true);
    expect(res.message).toContain('Уточніть пошук');
  });

  it('an empty result says it does not mean there are no cases', async () => {
    const { db } = makeDb(() => []);
    const res = parse(await new CourtStatusTools(db).executeTool('search_case_status_by_party', { party: 'Неіснуючабанк' }));
    expect(res.status).toBe('no_results');
    expect(res.results).toEqual([]);
    expect(res.message).toContain('НЕ означає');
  });

  it('retries with stems when the inflected query finds nothing', async () => {
    const { db, calls } = makeDb((sql, values) => {
      if (!isStatusSql(sql)) return [];
      return String(values[0]).includes(':*') && String(values[0]).includes('яворськ')
        ? [statusRow({ participants: P1, case_number: '127/1/24' })] : [];
    });
    const res = parse(await new CourtStatusTools(db).executeTool('search_case_status_by_party', { party: 'Яворської' }));
    expect(res.status).toBe('ok');
    expect(res.query.inflection_fallback).toBe(true);
    expect(res.results[0].matched_parties[0].match_variant).toBe('інша форма слова (відмінок)');
    expect(res.matching_note).toContain('відмінок');
    expect(calls.filter((c) => isStatusSql(c.sql) && typeof c.values[0] === 'string').map((c) => c.values[0]))
      .toEqual(["'яворської'", "'яворськ':*"]);
  });

  it('a DB error is an explicit error, never an empty list', async () => {
    const err = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const { db } = makeDb(() => err);
    const res = await new CourtStatusTools(db).executeTool('search_case_status_by_party', { party: 'Приватбанк' }) as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('ліміт часу');
  });

  it('one failed source with results from the other is returned as incomplete', async () => {
    const { db } = makeDb((sql) => (isPartySessions(sql) ? new Error('boom') : isStatusSql(sql) ? [statusRow()] : []));
    const res = parse(await new CourtStatusTools(db).executeTool('search_case_status_by_party', { party: 'Приватбанк' }));
    expect(res.incomplete).toBe(true);
    expect(res.warnings[0]).toContain('Архів засідань');
    expect(res.total_found).toBe(1);
  });

  it('falls back to the snapshot table with text-date keys before the loader has filled history', async () => {
    const { db, calls } = makeDb((sql) => (isStatusSql(sql) ? [statusRow()] : []), { history: false });
    const res = parse(await new CourtStatusTools(db).executeTool('search_case_status_by_party', {
      party: 'Приватбанк', date_from: '2015-01-01', proceeding_number: '2/533', include_sessions: false,
    }));
    const st = calls.find((c) => c.sql.includes('FROM opendata_court_case_status'))!;
    expect(st.sql).toContain('substr(registration_date, 7, 4)');
    expect(st.values).toContain('20150101');
    expect(st.values).toContain('2/533%');
    expect(calls.some((c) => isPartySessions(c.sql) || isHearingLookup(c.sql))).toBe(false);
    expect(res.source.case_status_table).toBe('останній щоденний знімок');
    expect(res.as_of).toEqual({ case_status: '2026-11-16' });
  });
});

describe('get_case_status_details', () => {
  it('returns stages in order, hearings and next steps', async () => {
    const { db, calls } = makeDb((sql) => {
      if (isHearingLookup(sql)) {
        return [
          { case_number: '533/318/15-ц', court_name: 'Козельщинський районний суд Полтавської області', session_date: '2015-05-20',
            session_time: '10:00', judge_name: 'Іваненко І.І.', session_form: null, session_place: null },
        ];
      }
      if (isStatusSql(sql)) {
        return [
          statusRow({ stage_key: '20150407', stage_name: 'Зареєстровано' }),
          statusRow({ stage_key: '20150605', stage_name: 'Розглянуто', cause_result: 'позов задоволено' }),
          statusRow({ stage_key: '20150605', stage_name: 'Розглянуто', cause_result: 'позов задоволено' }),
        ];
      }
      return [];
    });
    const res = parse(await new CourtStatusTools(db).executeTool('get_case_status_details', { case_number: '533/318/15' }));
    const st = calls.find((c) => c.sql.includes('FROM court_case_status_history') && c.sql.includes('ORDER BY'))!;
    expect(st.sql).toContain("lower(regexp_replace(case_number, '\\s+', '', 'g')) LIKE $2");
    expect(st.sql).toContain('ORDER BY stage_date ASC');
    const hl = calls.find((c) => isHearingLookup(c.sql))!;
    // Normalised (lower case, no whitespace): idx_court_sessions_case_norm, migration 279.
    expect(hl.values[0]).toEqual(['533/318/15', '533/318/15-ц']);
    expect(hl.sql).toContain("lower(regexp_replace(case_number, '\\s+', '', 'g')) = ANY($1::text[])");

    expect(res.status).toBe('found');
    expect(res.cases).toHaveLength(1);
    expect(res.cases[0].stages.map((s: any) => s.name)).toEqual(['Зареєстровано', 'Розглянуто']);
    expect(res.cases[0].last_stage.cause_result).toBe('позов задоволено');
    expect(res.hearings_total).toBe(1);
    expect(res.next_steps.decisions).toContain('search_court_decisions');
    expect(res.next_steps.documents_chain).toContain('get_case_documents_chain');
    expect(res.verify.url).toBe('https://court.gov.ua/fair/');
  });

  it('one card per proceeding: -ц and -а of the same court and base are not mixed', async () => {
    const { db } = makeDb((sql) => (isStatusSql(sql) ? [
      statusRow({ case_number: '533/318/15-ц', stage_key: '20150407', stage_name: 'Зареєстровано' }),
      statusRow({ case_number: '533/318/15-а', stage_key: '20160101', stage_name: 'Адмін стадія', participants: 'позивач: Х' }),
      statusRow({ case_number: '533/318/15-ц', stage_key: '20150605', stage_name: 'Розглянуто' }),
    ] : []));
    const res = parse(await new CourtStatusTools(db).executeTool('get_case_status_details', { case_number: '533/318/15' }));
    expect(res.cases).toHaveLength(2);
    const c = res.cases.find((x: any) => x.case_number === '533/318/15-ц');
    expect(c.stages.map((s: any) => s.name)).toEqual(['Зареєстровано', 'Розглянуто']);
    expect(res.cases.find((x: any) => x.case_number === '533/318/15-а').stages.map((s: any) => s.name)).toEqual(['Адмін стадія']);
  });

  it('a bare-number record joins the single suffixed card of that court', async () => {
    const { db } = makeDb((sql) => (isStatusSql(sql) ? [
      statusRow({ case_number: '533/318/15', stage_key: '20150407', stage_name: 'Зареєстровано' }),
      statusRow({ case_number: '533/318/15-ц', stage_key: '20150605', stage_name: 'Розглянуто' }),
    ] : []));
    const res = parse(await new CourtStatusTools(db).executeTool('get_case_status_details', { case_number: '533/318/15' }));
    expect(res.cases).toHaveLength(1);
    expect(res.cases[0].case_number).toBe('533/318/15-ц');
    expect(res.cases[0].stages.map((s: any) => s.name)).toEqual(['Зареєстровано', 'Розглянуто']);
  });

  it('falls back to the snapshot when history has no rows for the case', async () => {
    const { db, calls } = makeDb((sql) => (sql.includes('FROM opendata_court_case_status') ? [statusRow()] : []));
    const res = parse(await new CourtStatusTools(db).executeTool('get_case_status_details', { case_number: '533/318/15-ц' }));
    expect(calls.some((c) => c.sql.includes('FROM court_case_status_history'))).toBe(true);
    expect(res.status).toBe('found');
    expect(res.source.case_status_table).toBe('останній щоденний знімок');
  });

  it('not found is a caveated answer, a DB error an error', async () => {
    const { db } = makeDb(() => []);
    const nf = parse(await new CourtStatusTools(db).executeTool('get_case_status_details', { case_number: '999/1/26' }));
    expect(nf.status).toBe('not_found');
    expect(nf.message).toContain('НЕ означає');

    const { db: bad } = makeDb(() => new Error('connection lost'));
    const er = await new CourtStatusTools(bad).executeTool('get_case_status_details', { case_number: '999/1/26' }) as any;
    expect(er.isError).toBe(true);
  });
});
