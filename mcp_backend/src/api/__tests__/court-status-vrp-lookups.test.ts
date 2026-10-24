import {
  CourtStatusTools,
  buildCaseNumberCondition,
  hasProceedingSuffix,
  normalizeCaseNumber,
} from '../tools/court-status-tools';
import {
  OpenDataTools,
  extractJudgeNameFromDecisionTitle,
  judgeSurnameStem,
  fillJudgeNameFromDecision,
} from '../tools/opendata-tools';

describe('search_court_case_status case number (LEXAI-2104)', () => {
  it('normalises whitespace and case', () => {
    expect(normalizeCaseNumber(' 201/14253/25')).toBe('201/14253/25');
    expect(normalizeCaseNumber('522/9583/16- Ц')).toBe('522/9583/16-ц');
  });

  it('detects proceeding suffixes', () => {
    for (const n of ['522/9583/16-ц', '761/1/19-к', '9901/5/20-а', '1/2/20-цр']) expect(hasProceedingSuffix(n)).toBe(true);
    for (const n of ['522/9583/16', '2-123/2010', '01/19-2020']) expect(hasProceedingSuffix(n)).toBe(false);
  });

  it('a bare number matches itself or any "<number>-…" suffix, anchored on the dash', () => {
    const c = buildCaseNumberCondition('522/9583/16', 1);
    expect(c.sql).toContain('= $1');
    expect(c.sql).toContain('LIKE $2');
    expect(c.values).toEqual(['522/9583/16', '522/9583/16-%']);
    // The anchored pattern cannot reach 522/9583/161.
    const like = new RegExp('^' + c.values[1].replace('%', '.*') + '$');
    expect(like.test('522/9583/16-ц')).toBe(true);
    expect(like.test('522/9583/161')).toBe(false);
  });

  it('a suffixed number is an exact (normalised) match', () => {
    expect(buildCaseNumberCondition('522/9583/16-Ц', 3)).toEqual({
      sql: "lower(regexp_replace(case_number, '\\s+', '', 'g')) = $3",
      values: ['522/9583/16-ц'],
    });
  });

  it('escapes LIKE metacharacters typed by the user', () => {
    expect(buildCaseNumberCondition('1_2%', 1).values[1]).toBe('1\\_2\\%-%');
  });

  it('uses the indexed expression, fills stage_name from cause_result and orders by real date', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ case_number: '522/9583/16-ц' }] }) };
    await new CourtStatusTools(db).executeTool('search_court_case_status', { case_number: '522/9583/16', limit: 5 });
    const [sql, values] = db.query.mock.calls[0];
    expect(sql).toContain("lower(regexp_replace(case_number, '\\s+', '', 'g')) LIKE $2");
    expect(sql).toContain("COALESCE(NULLIF(btrim(stage_name), ''), NULLIF(btrim(cause_result), '')) AS stage_name");
    expect(sql).toContain('substr(stage_date, 7, 4)');
    expect(values).toEqual(['522/9583/16', '522/9583/16-%', 5]);
  });
});

describe('search_vrp_judges_discipline judge_name (LEXAI-2108)', () => {
  it('takes the first "Surname I.I." after «судді», skipping complainants and prosecutors', () => {
    expect(extractJudgeNameFromDecisionTitle(
      'Про притягнення до дисциплінарної відповідальності судді Донецького окружного адміністративного суду Арестової Л.В.',
    )).toBe('Арестової Л.В.');
    expect(extractJudgeNameFromDecisionTitle(
      'Про задоволення клопотання заступника Генерального прокурора Войтенка А.Б. про тимчасове відсторонення судді Господарського суду Дніпропетровської області Бондарєва Е.М. від здійснення правосуддя',
    )).toBe('Бондарєва Е.М.');
    expect(extractJudgeNameFromDecisionTitle(
      'Про притягнення судді Касаційного адміністративного суду у складі Верховного Суду Князєва В.С. до дисциплінарної відповідальності',
    )).toBe('Князєва В.С.');
  });

  it('returns null when the title names no judge', () => {
    expect(extractJudgeNameFromDecisionTitle(null)).toBeNull();
    expect(extractJudgeNameFromDecisionTitle('Про затвердження плану роботи')).toBeNull();
    expect(extractJudgeNameFromDecisionTitle('Про звільнення судді у відставку')).toBeNull();
  });

  it('stems a nominative surname so it matches the genitive title', () => {
    expect(judgeSurnameStem('Арестова Л.В.')).toBe('Арестов');
    expect(judgeSurnameStem('Князєв')).toBe('Князєв');
    expect(judgeSurnameStem('Бо')).toBeNull();
  });

  it('fills a blank judge_name with provenance, keeps an own name, leaves null otherwise', () => {
    const title = 'Про притягнення до дисциплінарної відповідальності судді Кропивницького апеляційного суду Гончара В.М.';
    expect(fillJudgeNameFromDecision({ judge_name: '', vrp_decision_title: title })).toMatchObject({
      judge_name: 'Гончара В.М.', judge_name_source: 'vrp_decision_title',
    });
    expect(fillJudgeNameFromDecision({ judge_name: 'Іванов І.І.', vrp_decision_title: title }).judge_name).toBe('Іванов І.І.');
    const none = fillJudgeNameFromDecision({ judge_name: '', vrp_decision_title: null });
    expect(none.judge_name).toBeNull();
    expect(none).not.toHaveProperty('vrp_decision_title');
    expect(none).not.toHaveProperty('judge_name_source');
  });

  it('joins vrp_decisions by decision number and searches the title by surname stem', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await new OpenDataTools(db).executeTool('search_vrp_judges_discipline', { type: 'suspended', judge_name: 'Арестова' });
    const [sql, values] = db.query.mock.calls[0];
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('vd.decision_num =');
    expect(sql).toContain('d.title ILIKE $2');
    expect(values).toEqual(['%Арестова%', '%судді%Арестов%', 50]);
  });
});
