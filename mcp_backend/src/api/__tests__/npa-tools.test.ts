/**
 * Unit tests for the full-НПА-corpus tools.
 *
 * Focus is on the things that silently produce wrong output rather than throwing:
 * dictionary decoding (types_raw is pipe-separated multi-value), the temporal edition
 * branch, and the TOAST-safe / chrome-stripped text paths.
 */

import { NpaTools, NPA_RANK, phraseRegex, queryYears } from '../tools/npa-tools.js';
import { legislationPhraseTsquery, normalizeApostrophes } from '../../services/legislation-search-utils.js';
import { docTypeIdFromLabel, docTypeLabels, npaUrl, statusLabel } from '../tools/npa-dicts.js';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const ACT_ROW = {
  nreg: '2755-17',
  title: 'Податковий кодекс України',
  status_code: 5,
  types_raw: '21|1|124',
  editions_cnt: 241,
  texts_cnt: 241,
  has_articles: true,
  first_ed: '2010-12-02',
  last_ed: '2026-01-01',
};

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('npa-dicts', () => {
  it('decodes status codes', () => {
    expect(statusLabel(5)).toBe('Чинний');
    expect(statusLabel(1)).toBe('Втратив чинність');
    expect(statusLabel(null)).toBe('Не визначено');
  });

  it('treats types_raw as a pipe-separated multi-value field', () => {
    expect(docTypeLabels('21|1|124')).toEqual(['Кодекс України', 'Закон', 'Кодекс']);
    expect(docTypeLabels('2')).toEqual(['Постанова']);
    expect(docTypeLabels(null)).toEqual([]);
    // unknown ids are dropped, not rendered as "Код N"
    expect(docTypeLabels('2|99999')).toEqual(['Постанова']);
  });

  it('maps doc-type labels case-insensitively, preferring the shortest prefix match', () => {
    expect(docTypeIdFromLabel('Закон')).toBe(1);
    expect(docTypeIdFromLabel('постанова')).toBe(2);
    expect(docTypeIdFromLabel('кодекс')).toBe(124); // "Кодекс" beats "Кодекс України"
    expect(docTypeIdFromLabel('нісенітниця')).toBeNull();
  });

  it('links to a historical edition only when one is shown', () => {
    expect(npaUrl('435-15')).toBe('https://zakon.rada.gov.ua/laws/show/435-15');
    expect(npaUrl('435-15', '2022-05-27', false)).toBe('https://zakon.rada.gov.ua/laws/show/435-15/ed20220527');
    expect(npaUrl('435-15', '2026-01-01', true)).toBe('https://zakon.rada.gov.ua/laws/show/435-15');
  });
});

describe('get_npa_act', () => {
  let db: { query: jest.Mock };
  let tools: NpaTools;

  beforeEach(() => {
    db = { query: jest.fn() };
    tools = new NpaTools(db);
  });

  it('resolves the edition in force on as_of_date, not the current one', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ nreg: '2755-17' }] })                        // resolveNreg
      .mockResolvedValueOnce({ rows: [ACT_ROW] })                                    // act card
      .mockResolvedValueOnce({ rows: [{ ed_date: '2022-05-27', is_current: false }] }) // resolveEdition
      .mockResolvedValueOnce({ rows: [{ article_count: 0, char_len: 123 }] });

    const out = parse(await tools.executeTool('get_npa_act', { nreg: '2755-17', as_of_date: '2022-06-01' }));

    expect(out.shown_edition).toBe('2022-05-27');
    expect(out.is_current).toBe(false);
    expect(out.url).toBe('https://zakon.rada.gov.ua/laws/show/2755-17/ed20220527');
    // the temporal branch must be the ed_date <= $2 one
    const editionSql = db.query.mock.calls[2][0];
    expect(editionSql).toContain('ed_date <= $2::date');
    expect(db.query.mock.calls[2][1]).toEqual(['2755-17', '2022-06-01']);
  });

  it('uses the is_current branch when no date is given', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ nreg: '2755-17' }] })
      .mockResolvedValueOnce({ rows: [ACT_ROW] })
      .mockResolvedValueOnce({ rows: [{ ed_date: '2026-01-01', is_current: true }] })
      .mockResolvedValueOnce({ rows: [{ article_count: 2, char_len: 9 }] });

    const out = parse(await tools.executeTool('get_npa_act', { nreg: '2755-17' }));

    expect(db.query.mock.calls[2][0]).toContain('is_current');
    expect(out.status).toBe('Чинний');
    expect(out.doc_types).toEqual(['Кодекс України', 'Закон', 'Кодекс']);
  });

  it('reports an unknown act instead of throwing', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const out = await tools.executeTool('get_npa_act', { nreg: 'не-існує' });
    expect(out!.content[0].text).toContain('не знайдено');
  });

  it('rejects a malformed as_of_date before touching the database', async () => {
    const out = await tools.executeTool('get_npa_act', { nreg: '2755-17', as_of_date: '01.06.2022' });
    expect(out!.content[0].text).toContain('YYYY-MM-DD');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('never slices a TOASTed body directly and strips the page chrome', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ nreg: '254к/96-вр' }] })
      .mockResolvedValueOnce({ rows: [{ ...ACT_ROW, nreg: '254к/96-вр', title: 'Конституція України' }] })
      .mockResolvedValueOnce({ rows: [{ ed_date: '2020-01-01', is_current: true }] })
      .mockResolvedValueOnce({ rows: [{ total_chars: 136113, text: 'КОНСТИТУЦІЯ УКРАЇНИ' }] });

    const out = parse(await tools.executeTool('get_npa_act', { nreg: '254к/96-вр', mode: 'text' }));

    const textSql = db.query.mock.calls[3][0];
    // The table column must be fully detoasted in the innermost subquery; slicing
    // npa.edition_text.body directly raises UTF8 errors on ~30% of rows. Every later
    // substr() in this statement reads the already-materialised CTE column, not the table.
    expect(textSql).toMatch(/FROM \(SELECT body \|\| '' AS b FROM npa\.edition_text/);
    expect(textSql).toContain('mouse wheel');
    expect(out.total_chars).toBe(136113);
    // first page of a 136k-char act — the caller must know to page on
    expect(out.has_more).toBe(true);
    expect(out.offset).toBe(0);
  });

  it('does not offer a table of contents for an act with no article layer', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ nreg: '148-2003-п' }] })
      .mockResolvedValueOnce({ rows: [{ ...ACT_ROW, nreg: '148-2003-п', has_articles: false }] })
      .mockResolvedValueOnce({ rows: [{ ed_date: '2020-01-01', is_current: true }] });

    const out = parse(await tools.executeTool('get_npa_act', { nreg: '148-2003-п', mode: 'toc' }));
    expect(out.note).toContain('mode=text');
  });
});

describe('search_npa', () => {
  let db: { query: jest.Mock };
  let tools: NpaTools;

  beforeEach(() => {
    db = { query: jest.fn() };
    tools = new NpaTools(db);
  });

  it('requires query or title', async () => {
    const out = await tools.executeTool('search_npa', {});
    expect(out!.content[0].text).toContain('query');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('excludes repealed acts by default and body-ranks only a bounded pool', async () => {
    db.query.mockResolvedValue({
      rows: [{ ...ACT_ROW, _total_count: 190, score: 1.23456, shown_edition: '2026-01-01', shown_is_current: true, snippet: 'фрагмент' }],
    });

    const out = parse(await tools.executeTool('search_npa', { query: 'відстрочка від мобілізації' }));

    const [sql, values] = db.query.mock.calls[0];
    expect(sql).toContain('t.is_current');            // required to hit the partial FTS index
    expect(sql).toContain("body || ''");              // TOAST-safe snippet and rank slice
    // ts_rank_cd over every matched body is ~8 s: it must run only on the metadata-
    // ranked pool, over a bounded prefix of the text.
    const poolAt = sql.indexOf('pool AS');
    const rankAt = sql.indexOf('ts_rank_cd');
    expect(poolAt).toBeGreaterThan(0);
    expect(rankAt).toBeGreaterThan(poolAt);
    expect(sql.slice(poolAt, rankAt)).toMatch(/LIMIT \$\d+/);
    expect(sql).toMatch(/to_tsvector\('simple', substr\(b\.body, 1, \$\d+\)\) AS tsv/);
    expect(sql).toContain("(SELECT t.body || '' AS body) b");
    expect(sql).toContain('ts_rank_cd(v.tsv,');
    expect(values).toContain(NPA_RANK.RERANK_POOL);
    expect(values).toContain(NPA_RANK.BODY_RANK_CHARS);
    // the final SELECT must keep the score order — the LATERAL join does not preserve it
    expect(sql.trim()).toMatch(/ORDER BY r\.score DESC[^)]*$/);
    expect(out.results[0].status).toBe('Чинний');
    expect(out.results[0].relevance).toBe(1.235);
    expect(out.total_count_at_least).toBe(190);
    expect(out.capped).toBe(false);
  });

  it('ranks by title coverage, demotes amendments, uses years only as title signals (LEXAI-2097)', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await tools.executeTool('search_npa', { query: 'мінімальна заробітна плата 2026' });

    const [sql, values] = db.query.mock.calls[0];
    // stems feed both the tsquery and the title-coverage array; the year is not a stem
    expect(values[0]).toBe('мінімал:* & заробі:* & плат:*');
    expect(values).toContainEqual(['мінімал', 'заробі', 'плат']);
    expect(values).toContainEqual(['2026']);
    expect(sql).toContain('strpos(lower(a.title), s)');
    expect(sql).toContain(`THEN ${NPA_RANK.AMENDMENT_PENALTY}`);
    expect(sql).toContain(`THEN ${NPA_RANK.YEAR_MATCH_BONUS}`);
    expect(sql).toContain(`-${NPA_RANK.YEAR_MISMATCH_PENALTY}`);
    // the old recency-first order is gone
    expect(sql).not.toMatch(/ORDER BY \(a\.status_code = 5\) DESC, a\.last_ed DESC/);
  });

  it('folds the ʼ apostrophe so the query tokenises like the corpus', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await tools.executeTool('search_npa', { query: 'бронювання військовозобовʼязаних' });
    const typographic = db.query.mock.calls[0][1][0];
    db.query.mockClear();
    await tools.executeTool('search_npa', { query: "бронювання військовозобов'язаних" });

    expect(typographic).toBe(db.query.mock.calls[0][1][0]);
    expect(typographic).toContain('язан:*');
  });

  it('title mode matches every word anywhere in the title, not the literal phrase', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await tools.executeTool('search_npa', { title: 'бронювання військовозобовʼязаних' });

    const [sql, values] = db.query.mock.calls[0];
    expect(sql).not.toContain("'%' || $1 || '%'");
    expect(values.slice(1, 4)).toEqual(['%бронюва%', '%військовозо%', '%язан%']);
    expect(sql).toContain('a.title ILIKE $2 AND a.title ILIKE $3 AND a.title ILIKE $4');
  });

  it('relaxes AND to OR only when AND finds nothing, and flags it (LEXAI-2153)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [1, 2, 3, 4].map(() => ({ ...ACT_ROW, _total_count: 4, shown_edition: '2026-01-01', shown_is_current: true, snippet: 'x' })),
      });

    const out = parse(await tools.executeTool('search_npa', { query: 'відстрочка від мобілізації' }));

    expect(db.query.mock.calls[0][1][0]).toContain(' & ');
    expect(db.query.mock.calls[1][1][0]).toContain(' | ');
    // the OR pass gets no phrase: nothing is "scattered" in a relaxed search
    const hasPhrase = (vals: any[]) => vals.some((v) => typeof v === 'string' && /<(->|\d+>)/.test(v));
    expect(hasPhrase(db.query.mock.calls[0][1])).toBe(true);
    expect(hasPhrase(db.query.mock.calls[1][1])).toBe(false);
    expect(out.note).toContain('пом’якшений');
    expect(out.match_mode).toBe('any_term');
    expect(out.results).toHaveLength(4);
    expect(out.results[0].match).toBe('any_term');
  });

  it('keeps a thin AND result instead of diluting it with OR matches', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ ...ACT_ROW, _total_count: 1, shown_edition: '2026-01-01', shown_is_current: true, snippet: 'x', phrase_hit: true }],
    });

    const out = parse(await tools.executeTool('search_npa', { query: 'відстрочка від мобілізації' }));

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(out.match_mode).toBe('all_terms');
    expect(out.note).toBeUndefined();
    expect(out.results[0].match).toBe('phrase');
  });

  it('boosts the query phrase and drops acts where the terms are only scattered (LEXAI-2153)', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { ...ACT_ROW, _total_count: 41, _scattered_dropped: 39, shown_edition: '2026-01-01', shown_is_current: true, snippet: 'штучним інтелектом', phrase_hit: true, score: 1.438 },
        { ...ACT_ROW, _total_count: 41, _scattered_dropped: 39, shown_edition: '2026-01-01', shown_is_current: true, snippet: 'x', phrase_hit: false, score: 1.0 },
      ],
    });

    const out = parse(await tools.executeTool('search_npa', { query: 'штучний інтелект', doc_type: 'Закон', limit: 5 }));

    const [sql, values] = db.query.mock.calls[0];
    expect(values[0]).toBe('штуч:* & інтел:*');
    expect(values).toContain('штуч:* <-> інтел:*');
    expect(values).toContain(phraseRegex('штуч:* <-> інтел:*'));
    expect(sql).toContain(`THEN ${NPA_RANK.PHRASE_BONUS}`);
    expect(sql).toContain(`m.body_rank >= ${NPA_RANK.PROXIMITY_MIN}`);
    expect(sql).toContain('WHERE j.focused OR NOT j._any_focused');
    // the phrase recheck detoasts bodies: it must run only on the bounded pool
    const poolAt = sql.indexOf('pool AS');
    expect(sql.indexOf('<->')).toBe(-1);                       // phrase is a bind value
    expect(sql.indexOf('phrase_hit')).toBeGreaterThan(poolAt);
    expect(sql.slice(0, poolAt)).not.toMatch(/phrase/);
    // one tokenisation per body: the tsvector subquery is fenced
    expect(sql).toMatch(/FROM \(SELECT t\.body \|\| '' AS body\) b OFFSET 0/);
    // "scattered" needs evidence over the FULL body: an act with no signal in the ranked
    // prefix but a longer text is checked for the phrase over the whole text first
    expect(sql).toMatch(/WHEN v\.body_len > \$\d+ THEN \(t\.body \|\| ''\) ~\* \$\d+::text/);
    expect(sql).toContain('(l.late_phrase IS NULL OR l.late_phrase) AS focused');
    expect(sql).toMatch(/regexp_instr\(t\.body \|\| '', \$\d+::text, 1, 1, 0, 'i'\)/);

    expect(out.scattered_dropped).toBe(39);
    expect(out.note).toContain('Відкинуто 39');
    expect(out.results.map((r: any) => r.match)).toEqual(['phrase', 'all_terms']);
  });

  it('sends no phrase for a single-term query', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await tools.executeTool('search_npa', { query: 'мобілізація' });
    const values = db.query.mock.calls[0][1];
    expect(values[0]).toBe('мобіліза:*');
    // the phrase and phrase-regex binds are NULL, and no bound string is a phrase or regex
    const sql: string = db.query.mock.calls[0][0];
    const bindAt = (re: RegExp) => Number(sql.match(re)![1]) - 1;
    expect(values[bindAt(/to_tsquery\('simple', \$(\d+)::text\)/)]).toBeNull();
    expect(values[bindAt(/regexp_instr\(t\.body \|\| '', \$(\d+)::text/)]).toBeNull();
    expect(values.some((v: any) => typeof v === 'string' && /<(->|\d+>)|\[\^/.test(v))).toBe(false);
  });

  it('rejects an unknown doc_type instead of silently ignoring it', async () => {
    const out = await tools.executeTool('search_npa', { query: 'податок', doc_type: 'Мандат' });
    expect(out!.content[0].text).toContain('Невідомий тип документа');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('rejects a query with no usable content tokens', async () => {
    const out = await tools.executeTool('search_npa', { query: 'та і в на' });
    expect(out!.content[0].text).toContain('придатних для пошуку');
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('query normalisation helpers', () => {
  it('folds every apostrophe look-alike to ASCII', () => {
    expect(normalizeApostrophes('військовозобовʼязаних')).toBe("військовозобов'язаних");
    expect(normalizeApostrophes('військовозобов’язаних')).toBe("військовозобов'язаних");
    expect(normalizeApostrophes("п'ять")).toBe("п'ять");
  });

  it('builds a phrase tsquery with the word distances the simple parser assigns', () => {
    expect(legislationPhraseTsquery('штучний інтелект')).toBe('штуч:* <-> інтел:*');
    // stopwords and short words keep their position
    expect(legislationPhraseTsquery('договір про закупівлю')).toBe('дого:* <2> закупі:*');
    expect(legislationPhraseTsquery('порядок видачі ліцензій у 2026 році')).toBe('поря:* <-> вида:* <-> ліцен:* <3> році:*');
    // a hyphenated word takes an extra position for the compound token
    expect(legislationPhraseTsquery('розвиток науково-технічний')).toBe('розви:* <2> наук:* <-> техніч:*');
    // the apostrophe splits a word in two, as in the corpus
    expect(legislationPhraseTsquery("бронювання військовозобов'язаних")).toBe('бронюва:* <-> військовозо:* <-> язан:*');
    // a dotted number is ONE token to the simple parser (ts_debug: float «69.22»,
    // version «2.3.4»); «354-1» is uint + signed int, two positions, no compound
    expect(legislationPhraseTsquery('ст. 69.22 ПК податок')).toBe('');
    expect(legislationPhraseTsquery('пункт 69.22 податкового кодексу')).toBe('пунк:* <2> податков:* <-> коде:*');
    expect(legislationPhraseTsquery('версія 2.3.4 програми')).toBe('верс:* <2> прогр:*');
    expect(legislationPhraseTsquery('стаття 354-1 кодексу')).toBe('стат:* <3> коде:*');
    expect(legislationPhraseTsquery('mobilization covid-19 тестування')).toBe('mobilizat:* <-> covi:* <2> тестува:*');
    expect(legislationPhraseTsquery('мобілізація')).toBe('');
    expect(legislationPhraseTsquery('та і в на')).toBe('');
  });

  it('turns a phrase tsquery into a regex with exactly N-1 gap tokens for <N>', () => {
    const W = '[0-9a-zа-яіїєґёʼ]';
    const S = '[^0-9a-zа-яіїєґёʼ]+';
    const H = '[^0-9a-zа-яіїєґёʼ]*[^0-9a-zа-яіїєґёʼ-][^0-9a-zа-яіїєґёʼ]*';
    const L = '(^|[^0-9a-zа-яіїєґёʼ])';
    const G = `([0-9]+(\\.[0-9]+)+|${W}+)`;
    // adjacent: plain separator
    expect(phraseRegex('штуч:* <-> інтел:*')).toBe(`${L}штуч${W}*${S}інтел${W}*`);
    // <2>: exactly one gap token, fenced by non-hyphen separators
    expect(phraseRegex('дого:* <2> закупі:*')).toBe(`${L}дого${W}*(${H}${G}){1}${H}закупі${W}*`);
    expect(phraseRegex('поря:* <-> вида:* <-> ліцен:* <3> році:*'))
      .toBe(`${L}поря${W}*${S}вида${W}*${S}ліцен${W}*(${H}${G}){2}${H}році${W}*`);
    expect(phraseRegex('мобіліз:*')).toBeNull();
  });

  // [tsquery, text, PostgreSQL `to_tsvector('simple', text) @@ to_tsquery('simple', q)`].
  // Every expected value below was checked on prod (LEXAI-2153 review); the regex must
  // never match where PostgreSQL does not.
  const PG_CASES: Array<[string, string, boolean]> = [
    ['штуч:* <-> інтел:*', 'створенні штучного інтелекту', true],
    ['штуч:* <-> інтел:*', 'Штучного Інтелекту', true],
    ['штуч:* <-> інтел:*', 'штучного, інтелекту', true],
    ['штуч:* <-> інтел:*', 'штучного-інтелекту', true],               // hword parts at 2, 3
    ['штуч:* <-> інтел:*', 'штучні острови та інтелектуальна власність', false],
    ['штуч:* <-> інтел:*', 'наштучний інтелект', false],
    ['дого:* <2> закупі:*', 'договір про закупівлю', true],
    ['дого:* <2> закупі:*', 'договір закупівлі', false],              // <N> is exact
    ['дого:* <2> закупі:*', 'договір про державну закупівлю', false],
    ['дого:* <3> закупі:*', 'договір про державну закупівлю', true],
    ['дого:* <2> закупі:*', 'договір абзац-закупівлі', false],        // hword: distance 3
    ['дого:* <3> закупі:*', 'договір абзац-а закупівлі', false],      // «абзац-а» = 3 positions
    ['пунк:* <2> податков:* <-> коде:*', 'згідно з пунктом 69.22 Податкового кодексу України', true],
    ['пунк:* <2> податков:* <-> коде:*', 'пунктом 69 22 податкового кодексу', false],
  ];

  it.each(PG_CASES)('regex for %s on «%s» matches only where PostgreSQL does (%s)', (q, text, pg) => {
    const re = phraseRegex(q)!;
    expect(new RegExp(re, 'iu').test(text)).toBe(pg); // SQL uses ~* / 'i'
  });

  it('is conservative where an hword sits inside a gap', () => {
    // PostgreSQL: договір:1 абзац-а:2 абзац:3 а:4 закупівлі:5 → `<4>` matches. The regex
    // can't count the compound position, so it declines rather than risk over-matching.
    expect(new RegExp(phraseRegex('дого:* <4> закупі:*')!, 'iu').test('договір абзац-а закупівлі')).toBe(false);
  });

  it('extracts years but not article numbers or longer digit runs', () => {
    expect(queryYears('мінімальна заробітна плата 2026')).toEqual(['2026']);
    expect(queryYears('стаття 1999 та 2026, 2026')).toEqual(['1999', '2026']);
    expect(queryYears('ст. 625 ЦК, номер 120260')).toEqual([]);
  });
});
