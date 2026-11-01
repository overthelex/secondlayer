/**
 * LEXAI-2175: get_court_decision lost the resolutive part of long Supreme Court rulings,
 * cut sections mid-word at 40K with no way to read on, and labelled the court's reasoning
 * PROCEDURAL_HISTORY. Fixture mirrors doc 90458880 (Велика Палата, 922/989/18).
 */
import { SectionType, type DocumentSection } from '../../types/index.js';
import {
  refineSections,
  sectionizeCourtDecision,
  planSectionBudget,
  cutAtBoundary,
  truncationMarker,
  MIN_PARTIAL_CHARS,
  MARKER_RESERVE,
  UNSECTIONED,
} from '../court-decision-sections.js';
import { CourtDecisionTools } from '../../api/tools/court-decision-tools.js';

function paragraphs(prefix: string, chars: number, startNo: number): string {
  const out: string[] = [];
  let n = startNo;
  let len = 0;
  while (len < chars) {
    const p = `\n\n ${n}. ${prefix} ${n}: суд першої інстанції зазначив, що земельна ділянка надавалася у постійне користування відповідно до статей 15-1, 22, 122 Земельного кодексу України.`;
    out.push(p);
    len += p.length;
    n++;
  }
  return out.join('');
}

/** A ВС ruling shaped like doc 90458880: ~78K chars, reasoning under a Grand Chamber heading. */
function buildRuling(opts: { withGuidedBy?: boolean; reasoningChars?: number } = {}): string {
  const withGuidedBy = opts.withGuidedBy ?? true;
  const reasoningChars = opts.reasoningChars ?? 30000;
  return [
    'ПОСТАНОВА\n\n Іменем України\n\n 23 червня 2020 року\n\n м. Київ\n\n Справа № 922/989/18\n\n Велика Палата Верховного Суду у складі судді-доповідача Уркевича В. Ю. розглянула справу за позовом СФГ «Берізка» до ГУ Держгеокадастру\n\n УСТАНОВИЛА:\n\n ІСТОРІЯ СПРАВИ',
    '\n\n Короткий зміст позовних вимог' + paragraphs('Позивач просив визнати право', 2000, 1),
    '\n\n Фактичні обставини справи, встановлені судами' + paragraphs('Встановлено', 5000, 3),
    '\n\n Короткий зміст рішень судів попередніх інстанцій',
    '\n\n 22. Рішенням Господарського суду Харківської області від 08 жовтня 2018 року у позові відмовлено. Суд постановив: у позові відмовити.' +
      paragraphs('Апеляційний суд', 30000, 23),
    '\n\n ПОЗИЦІЯ ВЕЛИКОЇ ПАЛАТИ ВЕРХОВНОГО СУДУ' + paragraphs('Велика Палата вважає', reasoningChars, 200),
    '\n\n Висновки за результатами розгляду касаційної скарги\n\n 90. Касаційна скарга підлягає задоволенню.',
    withGuidedBy
      ? '\n\n Керуючись статтями 300-302, 308, 311 Господарського процесуального кодексу України, Велика Палата Верховного Суду'
      : '',
    '\n\n П О С Т А Н О В И Л А:\n\n 1. Касаційну скаргу задовольнити.\n\n 2. Постанову Східного апеляційного господарського суду від 19 серпня 2019 року скасувати.\n\n Постанова набирає законної сили з дати її прийняття.\n\n Суддя-доповідач В. Ю. Уркевич',
  ].join('');
}

/**
 * Stand-in for the core SemanticSectionizer with its real failure modes: first match per
 * marker only, no ВС reasoning headings, no feminine/spaced «ПОСТАНОВИЛА», and every section
 * ended at start + 50,000 with the rest dropped.
 */
const CORE_MARKERS: Array<[SectionType, RegExp]> = [
  [SectionType.CLAIMS, /\n\s*Короткий зміст позовних вимог/],
  [SectionType.FACTS, /\n\s*Фактичні обставини/],
  [SectionType.PROCEDURAL_HISTORY, /\n\s*Короткий зміст рішень/],
  [SectionType.PROCEDURAL_HISTORY, /\n\s*(?:\d+\.\s*)?Рішенням\s+.{1,60}суду\s+.{1,40}від\s+\d/],
  [SectionType.DECISION, /\n\s*Керуючись\s+/],
];
function coreLike(text: string): DocumentSection[] {
  const b = CORE_MARKERS.map(([type, re]) => ({ type, m: re.exec(text) }))
    .filter((x) => x.m)
    .map((x) => ({ type: x.type, index: x.m!.index }))
    .sort((a, b2) => a.index - b2.index);
  const out: DocumentSection[] = [];
  if (b.length && b[0].index > 50) {
    out.push({ type: SectionType.HEADER, text: text.slice(0, b[0].index).trim(), start_index: 0, end_index: b[0].index, confidence: 0.9 });
  }
  b.forEach((x, i) => {
    const next = i + 1 < b.length ? b[i + 1].index : text.length;
    const end = Math.min(next, x.index + 50000);
    out.push({ type: x.type, text: text.slice(x.index, end), start_index: x.index, end_index: end, confidence: 0.8 });
  });
  return out;
}
const fakeSectionizer = { extractSections: jest.fn(async (t: string, _useLLM?: boolean) => coreLike(t)) };

describe('refineSections', () => {
  const text = buildRuling();
  const sections = refineSections(text, coreLike(text));

  it('reproduces the bug in the stand-in: core loses text past 50K and has no reasoning section', () => {
    const core = coreLike(text);
    const covered = core.reduce((a, s) => a + s.text.length, 0);
    expect(covered).toBeLessThan(text.length - 1000);
    expect(core.map((s) => s.type)).not.toContain(SectionType.COURT_REASONING);
  });

  it('labels the Grand Chamber assessment COURT_REASONING and keeps a trailing DECISION', () => {
    expect(sections.map((s) => s.type)).toEqual([
      SectionType.HEADER,
      SectionType.CLAIMS,
      SectionType.FACTS,
      SectionType.PROCEDURAL_HISTORY,
      SectionType.COURT_REASONING,
      SectionType.DECISION,
    ]);
    const reasoning = sections[4].text;
    expect(reasoning.trim().startsWith('ПОЗИЦІЯ ВЕЛИКОЇ ПАЛАТИ ВЕРХОВНОГО СУДУ')).toBe(true);
    expect(reasoning).toContain('Висновки за результатами розгляду касаційної скарги');
    const decision = sections[5].text.trim();
    expect(decision.startsWith('Керуючись статтями')).toBe(true);
    expect(decision).toContain('П О С Т А Н О В И Л А:');
    expect(decision).toContain('Касаційну скаргу задовольнити');
  });

  it('is contiguous and lossless: sections concatenate back to the full text', () => {
    expect(sections.map((s) => s.text).join('')).toBe(text);
    for (let i = 1; i < sections.length; i++) expect(sections[i].start).toBe(sections[i - 1].end);
  });

  it('folds a bare heading line into the section it introduces', () => {
    const history = sections[3].text.trim();
    expect(history.startsWith('Короткий зміст рішень судів попередніх інстанцій')).toBe(true);
    expect(history).toContain('22. Рішенням Господарського суду');
  });

  it('finds the resolutive part from «П О С Т А Н О В И Л А:» when core found no DECISION', () => {
    const noPreamble = buildRuling({ withGuidedBy: false });
    const s = refineSections(noPreamble, coreLike(noPreamble));
    const last = s[s.length - 1];
    expect(last.type).toBe(SectionType.DECISION);
    expect(last.text.trim().startsWith('П О С Т А Н О В И Л А:')).toBe(true);
  });

  it('does not take a quoted resolutive verb in running text as the decision', () => {
    // «Суд постановив: у позові відмовити.» sits inside paragraph 22.
    const decisions = sections.filter((s) => s.type === SectionType.DECISION);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].start).toBeGreaterThan(text.length - 1000);
  });

  it('accepts masculine, plural and plain forms on their own line', () => {
    for (const verb of ['ПОСТАНОВИВ:', 'УХВАЛИЛИ:', 'вирішив:', 'У Х В А Л И В :']) {
      const t = 'Шапка рішення суду у справі № 1/1\n\n Фактичні обставини справи' + paragraphs('Факт', 500, 1) + `\n\n ${verb}\n\n Позов задовольнити.`;
      const s = refineSections(t, []);
      expect(s[s.length - 1].type).toBe(SectionType.DECISION);
    }
  });

  it('returns unstructured text as one UNSECTIONED section (budgeted like the rest), [] only for no text', () => {
    const t = 'Короткий текст без жодних заголовків.';
    expect(refineSections(t, [])).toEqual([{ type: UNSECTIONED, start: 0, end: t.length, text: t }]);
    expect(refineSections('', [])).toEqual([]);
  });

  it('keeps a HEADER-only sectionizer result as HEADER + UNSECTIONED instead of dropping it', () => {
    const head = 'ПОСТАНОВА Іменем України 23 червня 2020 року Справа № 922/989/18 Велика Палата Верховного Суду';
    const t = head + '\n\n' + 'Текст без розпізнаних заголовків. '.repeat(50);
    const s = refineSections(t, [
      { type: SectionType.HEADER, text: head, start_index: 0, end_index: head.length, confidence: 0.9 },
    ]);
    expect(s.map((x) => x.type)).toEqual([SectionType.HEADER, UNSECTIONED]);
    expect(s.map((x) => x.text).join('')).toBe(t);
  });

  it('treats a core COURT_REASONING boundary as the start of the assessment, too', () => {
    const t =
      'Шапка рішення суду у справі № 1/1 від 01 січня 2020 року, склад суду: головуючий, судді; сторони: позивач і відповідач.' +
      '\n\n Фактичні обставини справи' + paragraphs('Факт', 600, 1) +
      '\n\n Суд вважає, що позов підлягає задоволенню' + paragraphs('Оцінка', 600, 50) +
      '\n\n Короткий зміст рішень цитата всередині мотивування' + paragraphs('Цитата', 600, 90);
    const factsAt = t.indexOf('\n\n Фактичні');
    const reasoningAt = t.indexOf('\n\n Суд вважає');
    const quoteAt = t.indexOf('\n\n Короткий зміст рішень');
    const core: DocumentSection[] = [
      { type: SectionType.FACTS, text: t.slice(factsAt, reasoningAt), start_index: factsAt, end_index: reasoningAt, confidence: 0.8 },
      { type: SectionType.COURT_REASONING, text: t.slice(reasoningAt, quoteAt), start_index: reasoningAt, end_index: quoteAt, confidence: 0.8 },
      { type: SectionType.PROCEDURAL_HISTORY, text: t.slice(quoteAt), start_index: quoteAt, end_index: t.length, confidence: 0.8 },
    ];
    const s = refineSections(t, core);
    expect(s.map((x) => x.type)).toEqual([SectionType.HEADER, SectionType.FACTS, SectionType.COURT_REASONING]);
    expect(s[2].end).toBe(t.length);
  });

  it('survives LLM-style sections with made-up indices', () => {
    const bogus: DocumentSection[] = [
      { type: SectionType.FACTS, text: 'нема такого тексту в документі', start_index: 5, end_index: 40, confidence: 0.7 },
    ];
    const s = refineSections(text, bogus);
    expect(s.map((x) => x.text).join('')).toBe(text);
    expect(s[s.length - 1].type).toBe(SectionType.DECISION);
  });
});

describe('planSectionBudget', () => {
  const sec = (type: SectionType, len: number) => ({ type, text: 'слово '.repeat(Math.ceil(len / 6)).slice(0, len) });

  it('always returns DECISION, at any depth', () => {
    const s = [sec(SectionType.HEADER, 1000), sec(SectionType.PROCEDURAL_HISTORY, 5000), sec(SectionType.DECISION, 1500)];
    for (const maxOther of [0, 1, 5]) {
      const plan = planSectionBudget(s, { budget: 40000, maxOther });
      expect(plan.returned.find((r) => r.index === 2)?.take).toBe(1500);
    }
  });

  it('drops the middle sections first and keeps head, reasoning and the resolutive part', () => {
    const s = [
      sec(SectionType.HEADER, 1000),
      sec(SectionType.CLAIMS, 2200),
      sec(SectionType.FACTS, 6100),
      sec(SectionType.PROCEDURAL_HISTORY, 7900),
      sec(SectionType.COURT_REASONING, 38900),
      sec(SectionType.DECISION, 1500),
    ];
    const plan = planSectionBudget(s, { budget: 40000, maxOther: 5 });
    expect(plan.returned.map((r) => r.index)).toEqual([0, 4, 5]);
    expect(plan.returned[1].take).toBeLessThan(38900);
    expect(plan.omitted.map((o) => o.index)).toEqual([1, 2, 3]);
    const total = plan.returned.reduce((a, r) => a + r.take + (r.take < s[r.index].text.length ? MARKER_RESERVE : 0), 0);
    expect(total).toBeLessThanOrEqual(40000);
  });

  it('charges per-section overhead and markers against the budget', () => {
    const s = [sec(SectionType.COURT_REASONING, 5000), sec(SectionType.DECISION, 900)];
    const plan = planSectionBudget(s, { budget: 3000, overhead: 24 });
    const cost = plan.returned.reduce((a, r) => a + r.take + 24 + (r.take < s[r.index].text.length ? MARKER_RESERVE : 0), 0);
    expect(cost).toBeLessThanOrEqual(3000);
    expect(plan.returned.find((r) => r.index === 1)?.take).toBe(900);
  });

  it('reports sections beyond depth as omitted for depth, not budget', () => {
    const s = [sec(SectionType.HEADER, 100), sec(SectionType.FACTS, 100), sec(SectionType.DECISION, 100)];
    const plan = planSectionBudget(s, { budget: 40000, maxOther: 1 });
    expect(plan.omitted).toEqual([{ index: 1, reason: 'depth' }]);
  });

  it('does not slice a section thinner than MIN_PARTIAL_CHARS', () => {
    const s = [sec(SectionType.HEADER, 39000 - MIN_PARTIAL_CHARS + 100), sec(SectionType.FACTS, 5000), sec(SectionType.DECISION, 1000)];
    const plan = planSectionBudget(s, { budget: 40000 });
    expect(plan.omitted).toEqual([{ index: 1, reason: 'budget' }]);
  });
});

describe('truncationMarker', () => {
  it('labels the real range and fits in MARKER_RESERVE', () => {
    const m = truncationMarker(9999999999, 99, 1234567, 1274567, 9999999);
    expect(m).toContain('показано символи 1234567–1274567 з 9999999');
    expect(m).toContain('"offset": 1274567');
    expect(m.length).toBeLessThanOrEqual(MARKER_RESERVE);
  });
});

describe('cutAtBoundary', () => {
  it('never cuts mid-word when a boundary is near', () => {
    const t = 'на посилання статті 15-1, 22, 122 Земельного кодексу України';
    const n = cutAtBoundary(t, 40);
    expect(t.slice(0, n)).toBe('на посилання статті 15-1, 22, 122');
  });
  it('prefers a paragraph break', () => {
    const t = 'перший абзац тексту\n\n другий абзац тексту довгий';
    expect(t.slice(0, cutAtBoundary(t, 30))).toBe('перший абзац тексту\n');
  });
});

describe('sectionizeCourtDecision', () => {
  it('runs the given sectionizer and refines its output', async () => {
    const text = buildRuling();
    const s = await sectionizeCourtDecision(fakeSectionizer, text);
    expect(s[s.length - 1].type).toBe(SectionType.DECISION);
  });
});

// ---------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------

function makeTools(text: string) {
  const db = {
    query: jest.fn(async (sql: string) => {
      if (/FROM edrsr_documents d/.test(sql)) {
        return { rows: [{ doc_id: 90458880, cause_num: '922/989/18', judge: 'Уркевич', adjudication_date: '2020-06-23', full_text: text }] };
      }
      return { rows: [] };
    }),
  };
  const zo: any = { saveDocumentsToDatabase: jest.fn(async () => undefined) };
  return new CourtDecisionTools(zo, zo, fakeSectionizer as any, {} as any, {} as any, db);
}

function parse(result: any): any {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

describe('get_court_decision (LEXAI-2175)', () => {
  const text = buildRuling();

  it('depth 5: DECISION present, response within budget, cut section marked with the call to read on', async () => {
    const out = parse(await makeTools(text).executeTool('get_court_decision', { doc_id: 90458880, depth: 5 }));
    const types = out.sections.map((s: any) => s.type);
    expect(types).toContain('DECISION');
    expect(types).toContain('COURT_REASONING');
    expect(types).not.toContain(undefined);
    const total = out.sections.reduce((a: number, s: any) => a + s.text.length, 0);
    expect(total).toBeLessThanOrEqual(40000);

    const cut = out.sections.find((s: any) => s.text_truncated);
    expect(cut).toBeDefined();
    expect(cut.text).toContain('ОБРІЗАНО');
    expect(cut.continue_with).toEqual({
      tool: 'get_court_decision',
      arguments: { doc_id: 90458880, section: cut.index, offset: cut.next_offset },
    });
    expect(out.sections_index).toHaveLength(6);
    // The middle (case history) is what gets cut; head, reasoning and the resolutive part are whole.
    expect(cut.type).toBe('PROCEDURAL_HISTORY');
    const returned = Object.fromEntries(out.sections_index.map((s: any) => [s.type, s.returned]));
    expect(returned).toMatchObject({ HEADER: 'full', COURT_REASONING: 'full', DECISION: 'full', PROCEDURAL_HISTORY: 'partial' });
    expect(out.full_text_hint).toContain('section');
  });

  it('lists sections left out by depth with the call that fetches each', async () => {
    const out = parse(await makeTools(text).executeTool('get_court_decision', { doc_id: 90458880, depth: 1 }));
    expect(out.sections.map((s: any) => s.type)).toEqual(['HEADER', 'DECISION']);
    expect(out.omitted_sections.map((o: any) => o.type)).toEqual(['CLAIMS', 'FACTS', 'PROCEDURAL_HISTORY', 'COURT_REASONING']);
    for (const o of out.omitted_sections) {
      expect(o.reason).toBe('depth');
      expect(o.continue_with.arguments).toEqual({ doc_id: 90458880, section: o.index, offset: 0 });
    }
  });

  it('depth 1 and default depth still carry the resolutive part', async () => {
    for (const depth of [1, undefined]) {
      const out = parse(await makeTools(text).executeTool('get_court_decision', { doc_id: 90458880, depth }));
      const decision = out.sections.find((s: any) => s.type === 'DECISION');
      expect(decision.text).toContain('Касаційну скаргу задовольнити');
    }
  });

  it('section + offset pages through a section longer than the budget with nothing lost', async () => {
    const big = buildRuling({ reasoningChars: 90000 });
    const tools = makeTools(big);
    const first = parse(await tools.executeTool('get_court_decision', { doc_id: 90458880, depth: 5 }));
    const reasoning = first.sections_index.find((x: any) => x.type === 'COURT_REASONING');
    expect(reasoning.length).toBeGreaterThan(80000);
    const shown = first.sections.find((x: any) => x.index === reasoning.index);
    expect(shown.text_truncated).toBe(true);

    let offset = 0;
    let assembled = '';
    let pages = 0;
    for (;;) {
      const page = parse(await tools.executeTool('get_court_decision', { doc_id: 90458880, section: reasoning.index, offset }));
      pages++;
      expect(page.offset).toBe(offset);
      expect(page.sections).toHaveLength(1);
      const p = page.sections[0];
      expect(p.text.length).toBeLessThanOrEqual(40000);
      if (!page.next_offset) {
        assembled += p.text;
        break;
      }
      expect(p.continue_with.arguments.offset).toBe(page.next_offset);
      expect(p.text).toContain(`показано символи ${offset}–${page.next_offset} з ${reasoning.length}`);
      assembled += p.text.slice(0, p.text.indexOf('\n\n[… ОБРІЗАНО'));
      expect(assembled.length).toBe(page.next_offset);
      offset = page.next_offset;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(assembled).toBe(big.slice(reasoning.start, reasoning.start + reasoning.length));
  });

  it('sections the same way for every reasoning_budget, so paging coordinates are stable', async () => {
    fakeSectionizer.extractSections.mockClear();
    const tools = makeTools(text);
    const std = parse(await tools.executeTool('get_court_decision', { doc_id: 90458880 }));
    const deep = parse(await tools.executeTool('get_court_decision', { doc_id: 90458880, reasoning_budget: 'deep' }));
    expect(deep.sections_index).toEqual(std.sections_index);
    expect(fakeSectionizer.extractSections.mock.calls.length).toBeGreaterThan(0);
    for (const call of fakeSectionizer.extractSections.mock.calls) expect(call[1]).toBe(false);
  });

  it('normalizes depth to an integer in 1..5', async () => {
    const tools = makeTools(text);
    const cases: Array<[unknown, number]> = [[2.7, 2], ['3', 3], ['abc', 2], [0, 2], [99, 5], [-4, 1]];
    for (const [given, want] of cases) {
      const out = parse(await tools.executeTool('get_court_decision', { doc_id: 90458880, depth: given }));
      expect(out.depth).toBe(want);
    }
  });

  it('budgets an unstructured decision instead of returning the whole full_text', async () => {
    const plain = 'Текст рішення без жодних розпізнаних заголовків і структури. '.repeat(2500);
    const out = parse(await makeTools(plain).executeTool('get_court_decision', { doc_id: 90458880 }));
    expect(out.sections_index).toEqual([
      expect.objectContaining({ index: 0, type: 'UNSECTIONED', length: plain.length, returned: 'partial' }),
    ]);
    expect(out.sections).toEqual([]);
    expect(out.full_text.length).toBeLessThanOrEqual(40000);
    expect(out.full_text).toContain('ОБРІЗАНО');
    expect(out.full_text_truncated).toBe(true);
    expect(out.continue_with.arguments).toEqual({ doc_id: 90458880, section: 0, offset: out.next_offset });
  });

  it('rejects a section index that does not exist, in Ukrainian', async () => {
    const res = await makeTools(text).executeTool('get_court_decision', { doc_id: 90458880, section: 42 });
    expect(res!.isError).toBe(true);
    expect(res!.content[0].text).toContain('Секції 42 немає');
  });

  it('declares section and offset in the schema (the gateway rejects unknown arguments)', () => {
    const def = makeTools(text).getToolDefinitions().find((d) => d.name === 'get_court_decision')!;
    expect(Object.keys((def.inputSchema as any).properties)).toEqual(
      expect.arrayContaining(['doc_id', 'depth', 'section', 'offset']),
    );
  });
});

describe('load_full_texts return_texts (LEXAI-2175)', () => {
  it('keeps [DECISION] in a small snippet budget instead of head-truncating it away', async () => {
    const text = buildRuling();
    const out = parse(
      await makeTools(text).executeTool('load_full_texts', { doc_ids: [90458880], return_texts: true, snippet_chars: 4000 }),
    );
    const doc = out.documents[0];
    expect(doc.excerpt_source).toBe('sections');
    expect(doc.text).toContain('[DECISION]');
    expect(doc.text).toContain('Касаційну скаргу задовольнити');
    expect(doc.text).toContain('[COURT_REASONING]');
    expect(doc.truncated).toBe(true);
    expect(doc.text).toContain('ОБРІЗАНО');
  });

  it('never returns more than snippet_chars, labels and markers included', async () => {
    const tools = makeTools(buildRuling({ reasoningChars: 60000 }));
    for (const snippet_chars of [500, 1000, 2500, 4000, 20000]) {
      const out = parse(await tools.executeTool('load_full_texts', { doc_ids: [90458880], return_texts: true, snippet_chars }));
      expect(out.documents[0].text.length).toBeLessThanOrEqual(snippet_chars);
      expect(out.documents[0].text).toContain('[DECISION]');
    }
  });
});
