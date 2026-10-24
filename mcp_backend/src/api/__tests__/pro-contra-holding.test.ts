import { ProceduralTools } from '../tools/procedural-tools';

/**
 * Regression for compare_practice_pro_contra holding classification (LEXAI-1751): the legacy
 * keyword suffix could put the same decision on both sides with a header-only snippet. The new
 * path retrieves candidates once and classifies each holding via the LLM into supports / opposes
 * / not_on_point — a decision can only land on the side the LLM assigns, and not_on_point is dropped.
 */
function makeTools(opts: {
  hits: any[];
  classifications: any[];
  ftsResults?: any[]; // when set, also stub the FTS service (enables the contra-seed leg)
}): ProceduralTools {
  const edsrVectorizer: any = {
    semanticSearch: jest.fn().mockResolvedValue(opts.hits),
  };
  const llm: any = {
    chatCompletion: jest.fn().mockResolvedValue({
      content: JSON.stringify({ classifications: opts.classifications }),
    }),
  };
  const ftsService: any = opts.ftsResults
    ? { searchFulltext: jest.fn().mockResolvedValue({ results: opts.ftsResults }) }
    : undefined;
  const db: any = opts.ftsResults ? {} : undefined;
  // Required ctor args are unused on this path — stub them.
  return new ProceduralTools(
    {} as any, {} as any, {} as any, {} as any, {} as any,
    llm, ftsService, db, edsrVectorizer,
  );
}

function ftsRow(doc_id: number, court_code: number, headline: string) {
  return { doc_id, court_code, adjudication_date: '2025-02-02', cause_num: `c/${doc_id}`, headline };
}

function hit(doc_id: number, court_code: number, text: string) {
  return {
    doc_id,
    score: 0.9,
    text,
    metadata: { court_code, adjudication_date: '2025-01-01', cause_num: `c/${doc_id}` },
  };
}

async function run(tools: ProceduralTools, args: any) {
  const res = await (tools as any).comparePracticeProContra(args);
  return JSON.parse(res.content[0].text);
}

describe('comparePracticeProContra — LLM holding classification', () => {
  it('splits pro/contra by LLM stance and drops not_on_point', async () => {
    const tools = makeTools({
      hits: [hit(101, 9921, 'frag A'), hit(102, 9921, 'frag B'), hit(103, 1370, 'frag C')],
      classifications: [
        { doc_id: 101, stance: 'supports', quote: 'суд погодився', confidence: 0.9 },
        { doc_id: 102, stance: 'opposes', quote: 'суд відмовив', confidence: 0.8 },
        { doc_id: 103, stance: 'not_on_point', quote: '', confidence: 0.4 },
      ],
    });
    const out = await run(tools, { procedure_code: 'cac', query: 'теза' });

    expect(out.search_method).toBe('llm_holding_semantic_hnsw');
    expect(out.pro.map((c: any) => c.doc_id)).toEqual([101]);
    expect(out.contra.map((c: any) => c.doc_id)).toEqual([102]);
    expect(out.total_pro).toBe(1);
    expect(out.total_contra).toBe(1);
    // A doc never appears on both sides.
    expect(out.pro.map((c: any) => c.doc_id)).not.toEqual(out.contra.map((c: any) => c.doc_id));
    // Snippet is the cited quote, not a header.
    expect(out.pro[0].snippet).toBe('суд погодився');
    expect(out.insufficient_practice).toBeUndefined();
  });

  it('flags insufficient_practice when one side is empty', async () => {
    const tools = makeTools({
      hits: [hit(201, 9921, 'frag A'), hit(202, 9921, 'frag B')],
      classifications: [
        { doc_id: 201, stance: 'supports', quote: 'за', confidence: 0.9 },
        { doc_id: 202, stance: 'supports', quote: 'теж за', confidence: 0.7 },
      ],
    });
    const out = await run(tools, { procedure_code: 'cac', query: 'теза' });
    expect(out.total_pro).toBe(2);
    expect(out.total_contra).toBe(0);
    expect(out.insufficient_practice).toBe(true);
  });

  it('degrades to unclassified relevant practice when the LLM response is unparseable', async () => {
    // Both the initial classify call and the repair retry return non-JSON, so classifyHoldings
    // gives up. Instead of discarding the good semantic candidates and dropping to keyword-FTS,
    // the tool returns them as relevant practice with stances unlabeled.
    const edsrVectorizer: any = {
      semanticSearch: jest.fn().mockResolvedValue([hit(301, 9921, 'frag A'), hit(302, 9921, 'frag B')]),
    };
    const llm: any = {
      chatCompletion: jest.fn().mockResolvedValue({ content: 'вибачте, не можу' }),
    };
    const tools = new ProceduralTools(
      {} as any, {} as any, {} as any, {} as any, {} as any,
      llm, undefined, undefined, edsrVectorizer,
    );
    const out = await run(tools, { procedure_code: 'cac', query: 'теза' });

    expect(out.stance_classification_unavailable).toBe(true);
    expect(out.search_method).toBe('semantic_semantic_hnsw_unclassified');
    expect(out.pro).toEqual([]);
    expect(out.contra).toEqual([]);
    expect(out.relevant_practice.map((c: any) => c.doc_id)).toEqual([301, 302]);
    // Repair retry was attempted (2 calls: initial + repair).
    expect(llm.chatCompletion).toHaveBeenCalledTimes(2);
  });

  it('applies court_level=SC filter — non-99* candidates never reach classification', async () => {
    const tools = makeTools({
      // 9921 and 9901 are Supreme Court (99*); 1370 is a first-instance court.
      hits: [hit(101, 9921, 'frag A'), hit(102, 1370, 'frag B'), hit(103, 9901, 'frag C')],
      classifications: [
        { doc_id: 101, stance: 'supports', quote: 'ВС за', confidence: 0.9 },
        { doc_id: 102, stance: 'opposes', quote: 'перша інстанція проти', confidence: 0.8 },
        { doc_id: 103, stance: 'opposes', quote: 'ВП проти', confidence: 0.8 },
      ],
    });
    const out = await run(tools, { procedure_code: 'cac', query: 'теза', court_level: 'SC' });

    expect(out.court_level_filter).toBe('SC');
    // 102 (court 1370) is filtered out before classification — it cannot appear on either side.
    const allDocs = [...out.pro, ...out.contra].map((c: any) => c.doc_id);
    expect(allDocs).not.toContain(102);
    expect(out.pro.map((c: any) => c.doc_id)).toEqual([101]);
    expect(out.contra.map((c: any) => c.doc_id)).toEqual([103]);
  });

  it('fetches each candidate dispositive, feeds it to the classifier and labels the outcome', async () => {
    // The semantic snippet only restates the norm; the operative outcome lives in the
    // dispositive. We assert (a) the dispositive text reaches the classifier prompt and
    // (b) the programmatic outcome label is attached to the output row.
    const edsrVectorizer: any = {
      semanticSearch: jest.fn().mockResolvedValue([
        hit(601, 9921, 'підставою недійсності є недодержання вимог ст. 203 ЦК'),
      ]),
    };
    const llm: any = {
      chatCompletion: jest.fn().mockResolvedValue({
        content: JSON.stringify({
          classifications: [{ doc_id: 601, stance: 'opposes', quote: 'у задоволенні позову відмовлено', confidence: 0.9 }],
        }),
      }),
    };
    const db: any = {
      query: jest.fn().mockResolvedValue({
        rows: [{ doc_id: 601, full_text: 'мотивувальна частина ... ПОСТАНОВИВ: у задоволенні позову про визнання правочину недійсним відмовити.' }],
      }),
    };
    const tools = new ProceduralTools(
      {} as any, {} as any, {} as any, {} as any, {} as any,
      llm, undefined, db, edsrVectorizer,
    );
    const out = await run(tools, { procedure_code: 'cpc', query: 'теза' });

    // Dispositive was queried by doc_id and its text was placed into the classifier prompt.
    expect(db.query).toHaveBeenCalled();
    const userPrompt = llm.chatCompletion.mock.calls[0][0].messages[1].content;
    expect(userPrompt).toContain('Резолютивна частина:');
    expect(userPrompt).toContain('у задоволенні позову');
    // Programmatic outcome label is surfaced on the row.
    expect(out.contra[0].doc_id).toBe(601);
    expect(out.contra[0].outcome).toBe('denied');
  });

  it('seeds contra practice via FTS when the semantic pool skews pro', async () => {
    const tools = makeTools({
      // Semantic leg returns only thesis-agreeing decisions.
      hits: [hit(401, 9921, 'за тезу A'), hit(402, 9921, 'за тезу B')],
      // FTS contra-seed surfaces a refusal decision the semantic leg missed.
      ftsResults: [ftsRow(501, 9921, 'суд відмовив у задоволенні позову')],
      classifications: [
        { doc_id: 401, stance: 'supports', quote: 'за', confidence: 0.9 },
        { doc_id: 402, stance: 'supports', quote: 'теж за', confidence: 0.8 },
        { doc_id: 501, stance: 'opposes', quote: 'відмовлено', confidence: 0.85 },
      ],
    });
    const out = await run(tools, { procedure_code: 'cac', query: 'теза' });

    expect(out.search_method).toBe('llm_holding_semantic_hnsw+contra_seed');
    expect(out.pro.map((c: any) => c.doc_id).sort()).toEqual([401, 402]);
    expect(out.contra.map((c: any) => c.doc_id)).toEqual([501]);
    expect(out.total_contra).toBe(1);
    // No longer a one-sided insufficient_practice result.
    expect(out.insufficient_practice).toBeUndefined();
  });
});

describe('appeal boilerplate (24.10.2026: a custody case counted as "pro" on an appeal-deadline thesis)', () => {
  const { stripAppealBoilerplate } = require('../tools/procedural-tools');
  const tail =
    'Рішення суду може бути оскаржене до Одеського апеляційного суду протягом тридцяти днів з дня складення повного тексту рішення суду. ' +
    'Учасник справи, якому повне рішення не було вручене у день його складання, має право на поновлення строку на апеляційне оскарження шляхом подання апеляційної скарги протягом тридцяти днів з дня вручення йому повного рішення суду. ' +
    'Повний текст судового рішення буде складений 18.02.2022 року.';

  it('strips the closing appeal formula and keeps reasoning about appealability', () => {
    const r = stripAppealBoilerplate(`Визначити місце проживання дитини з матір'ю. ${tail}`);
    expect(r.removed).toBe(true);
    expect(r.text).toBe("Визначити місце проживання дитини з матір'ю.");
    // A Qdrant chunk cut mid-sentence: «Учасник справи, якому» is in the previous chunk.
    const chunk = ' повне рішення не було вручене у день його складання, має право на поновлення строку на апеляційне оскарження шляхом подання апеляційної скарги протягом тридцяти днів з дня вручення йому повного рішення суду.\n\nПовний текст судового рішення буде складений 18.02.2022 року.\n\nСУДДЯ';
    expect(stripAppealBoilerplate(chunk)).toEqual({ text: 'СУДДЯ', removed: true });
    // Live semantic hits 24.10.2026: the notice without «йому», plus its «може бути також поновлений» sentence.
    const notice2 = ' право на поновлення пропущеного строку на апеляційне оскарження рішення суду - якщо апеляційна скарга подана протягом тридцяти днів з дня вручення повного рішення суду.\n\nСтрок на апеляційне оскарження може бути також поновлений в разі пропуску з інших поважних причин, крім випадків, зазначених у частині другій статті 358 ЦПК України.\n\nСуддя  Красовський О.О.';
    expect(stripAppealBoilerplate(notice2)).toEqual({ text: 'Суддя Красовський О.О.', removed: true });
    // Live chunks that survived #2536: cut right after «право», «пропущенного» typo, «Повне судове рішення».
    for (const [cut, rest] of [
      [' на поновлення строку на апеляційне оскарження шляхом подання апеляційної скарги протягом тридцяти днів з дня вручення йому повного рішення суду.\n\nПовне судове рішення буде складено 27.01.2022 року.\n\nСУДДЯ', 'СУДДЯ'],
      [' поновлення пропущеного строку на апеляційне оскарження на рішення суду якщо апеляційна скарга подана протягом тридцяти днів з дня вручення йому повного рішення суду.\n\nСтрок на апеляційне оскарження може бути також поновлений в разі пропуску з інших поважних причин.\n\nПовний текст рішення буде складено 01 березня 2022 року.\n\nСуддя С.І. Колесник', 'Суддя С.І. Колесник'],
      [' рішення суду не було вручене у день його проголошення або складення, має право на поновлення пропущенного строку на апеляційне оскарження якщо апеляційна скарга подана протягом тридцяти днів з дня вручення йому повного рішення суду.\n\nПовний текст судового рішення буде складено 16.08.2021 року.\n\nСуддя', 'Суддя'],
    ]) {
      expect(stripAppealBoilerplate(cut)).toEqual({ text: rest, removed: true });
    }
    // Default-judgment notice cut before «з дня вручення», and the «1) …; 2) …» enumeration.
    expect(stripAppealBoilerplate(' право на поновлення пропущеного строку на апеляційне оскарження, якщо апеляційна скарга подана протягом тридцяти днів з дня вручення йому повного рішення суду.\n\nЗаочне рішення може бути переглянуто судом, що його ухвалив, за письмовою заявою відповідача, поданою протягом тридцяти днів з дня його проголошення.\n\nУчасник справи, якому повне заочне рішення не було вручене у день його проголошення, має право на поновлення пропущеного строку на подання заяви про його перегляд, якщо така заява подана ').text).toBe('');
    expect(stripAppealBoilerplate(' право на поновлення пропущеного строку на апеляційне оскарження: 1) на рішення суду - якщо апеляційна скарга подана протягом тридцяти днів з дня вручення йому повного рішення суду; 2) на ухвали суду - якщо апеляційна скарга подана протягом пятнадцяти днів з дня вручення йому відповідної ухвали суду.\n\nЗгідно з положеннями ст. 355').text).toBe('Згідно з положеннями ст. 355');
    const reasoning = 'Ухвала про забезпечення позову може бути оскаржена окремо від рішення суду.';
    expect(stripAppealBoilerplate(reasoning)).toEqual({ text: reasoning, removed: false });
  });

  it('drops a semantic hit that was only the appeal paragraph and never shows it to the classifier', async () => {
    const tools = makeTools({
      hits: [hit(301, 1503, tail), hit(302, 9921, 'Суд визнав поважною причиною пропуску строку отримання повного тексту рішення через три місяці після його складення.')],
      classifications: [{ doc_id: 302, stance: 'supports', quote: 'визнав поважною', confidence: 0.9 }],
    });
    const out = await run(tools, { procedure_code: 'cpc', query: 'пізнє отримання повного тексту — поважна причина' });
    expect(out.candidates_considered).toBe(1);
    expect(out.pro.map((c: any) => c.doc_id)).toEqual([302]);
    const prompt = ((tools as any).llm.chatCompletion as jest.Mock).mock.calls[0][0].messages[1].content;
    expect(prompt).not.toContain('Учасник справи, якому повне');
  });
});
