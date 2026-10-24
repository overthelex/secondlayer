import { IpObjectsTools, deriveMarkTitle, niceSummary, markSearchName } from '../tools/ip-objects-tools.js';

type Call = { sql: string; params: any[] };

function makeDb(responder: (sql: string, params: any[]) => any) {
  const calls: Call[] = [];
  const db = {
    calls,
    query: jest.fn((sql: string, params: any[]) => {
      calls.push({ sql, params });
      return Promise.resolve(responder(sql, params));
    }),
  };
  return db;
}

const tmRow = {
  id: 1, obj_type: 4, obj_type_name: 'Торговельні марки', obj_state: 1,
  app_number: 'm202400890', app_date: '2024-01-10', registration_number: null,
  registration_date: null, expiry_date: null, status: 'active', title_ua: 'planet',
  class_system: 'nice', classes: ['34'], owner_name: 'ТОВ «Тест»',
  owner_edrpou: '38565147', owner_country: 'UA', owner_kind: 'legal_entity',
  owner_role: 'applicant', image_path: '/media/x.jpg', _total_count: 1,
};

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('IpObjectsTools', () => {
  it('exposes five read-only tools', () => {
    const tool = new IpObjectsTools(makeDb(() => ({ rows: [] })));
    const defs = tool.getToolDefinitions();
    expect(defs.map(d => d.name).sort()).toEqual(
      ['find_similar_trademarks', 'get_ip_object', 'get_trademark_dossier', 'search_ip_objects', 'search_trademarks'],
    );
    expect(defs.every(d => d.annotations?.readOnlyHint)).toBe(true);
  });

  it('returns null for an unknown tool name', async () => {
    const tool = new IpObjectsTools(makeDb(() => ({ rows: [] })));
    expect(await tool.executeTool('something_else', {})).toBeNull();
  });

  it('search_ip_objects builds ILIKE + class-overlap filters with parameters', async () => {
    const db = makeDb(() => ({ rows: [tmRow] }));
    const tool = new IpObjectsTools(db);
    const res = await tool.executeTool('search_ip_objects', { query: 'planet', obj_type: 4, classes: ['34'] });
    const call = db.calls[0];
    expect(call.sql).toContain('title_ua ILIKE');
    expect(call.sql).toContain('classes &&');
    expect(call.sql).toContain('COUNT(*) OVER()');
    expect(call.params).toContain('%planet%');
    expect(call.params).toContain(4);
    expect(call.params).toContainEqual(['34']);
    const parsed = parse(res);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.total_count).toBe(1);
    expect(parsed.results[0]._total_count).toBeUndefined();
  });

  it('search_ip_objects asks for a filter when none provided', async () => {
    const db = makeDb(() => ({ rows: [] }));
    const tool = new IpObjectsTools(db);
    const res = await tool.executeTool('search_ip_objects', {});
    expect(db.query).not.toHaveBeenCalled();
    expect(res!.content[0].text).toContain('фільтр');
  });

  it('search_ip_objects rejects an invalid obj_type', async () => {
    const tool = new IpObjectsTools(makeDb(() => ({ rows: [] })));
    const res = await tool.executeTool('search_ip_objects', { obj_type: 9 });
    expect(res!.isError).toBe(true);
  });

  it('search_trademarks pins obj_type=4 and maps nice_classes', async () => {
    const db = makeDb(() => ({ rows: [tmRow] }));
    const tool = new IpObjectsTools(db);
    await tool.executeTool('search_trademarks', { query: 'ELFA', nice_classes: ['34'] });
    const call = db.calls[0];
    expect(call.sql).toContain('obj_type = 4');
    expect(call.sql).toContain('classes &&');
    expect(call.params).toContain('%ELFA%');
    expect(call.params).toContainEqual(['34']);
  });

  it('search_trademarks requires at least one real criterion', async () => {
    const db = makeDb(() => ({ rows: [] }));
    const tool = new IpObjectsTools(db);
    await tool.executeTool('search_trademarks', {});
    expect(db.query).not.toHaveBeenCalled();
  });

  it('find_similar_trademarks requires an identifier', async () => {
    const db = makeDb(() => ({ rows: [] }));
    const tool = new IpObjectsTools(db);
    const res = await tool.executeTool('find_similar_trademarks', {});
    expect(db.query).not.toHaveBeenCalled();
    expect(res!.isError).toBe(true);
  });

  it('find_similar_trademarks requires classes when only query is given', async () => {
    const db = makeDb(() => ({ rows: [] }));
    const tool = new IpObjectsTools(db);
    const res = await tool.executeTool('find_similar_trademarks', { query: 'планета' });
    expect(db.query).not.toHaveBeenCalled();
    expect(res!.isError).toBe(true);
    expect(res!.content[0].text).toContain('клас');
  });

  it('find_similar_trademarks by query+classes uses similarity + class overlap', async () => {
    const db = makeDb(() => ({ rows: [{ ...tmRow, similarity: 0.6 }] }));
    const tool = new IpObjectsTools(db);
    const res = await tool.executeTool('find_similar_trademarks', { query: 'планета', classes: ['34'] });
    const call = db.calls[0];
    expect(call.sql).toContain('similarity(title_ua, $1)');
    expect(call.sql).toContain('classes && $2::text[]');
    expect(call.params[0]).toBe('планета');
    expect(call.params[1]).toEqual(['34']);
    expect(call.params[2]).toBe(0.3); // default threshold
    const parsed = parse(res);
    expect(parsed.results[0].similarity).toBe(0.6);
  });

  it('find_similar_trademarks by app_number loads the reference then excludes it', async () => {
    const db = makeDb((sql) =>
      sql.includes('LIMIT 1') && sql.includes('title_ua, classes')
        ? { rows: [{ title_ua: 'planet', classes: ['34'] }] }
        : { rows: [tmRow] },
    );
    const tool = new IpObjectsTools(db);
    await tool.executeTool('find_similar_trademarks', { app_number: 'm202401037' });
    // 1st call loads the reference mark, 2nd runs the similarity search
    expect(db.calls[0].sql).toContain('WHERE app_number = $1 AND obj_type = 4');
    const search = db.calls[1];
    expect(search.params[0]).toBe('planet');       // ref text
    expect(search.params[1]).toEqual(['34']);       // ref classes
    expect(search.sql).toContain('app_number <> $');
    expect(search.params).toContain('m202401037');  // excluded self
  });

  it('get_ip_object fetches a single record by app_number', async () => {
    const db = makeDb(() => ({ rows: [{ ...tmRow, raw_data: {} }] }));
    const tool = new IpObjectsTools(db);
    const res = await tool.executeTool('get_ip_object', { app_number: 'm202400890' });
    const call = db.calls[0];
    expect(call.sql).toContain('app_number = $1');
    expect(call.sql).toContain('LIMIT 1');
    expect(call.params).toEqual(['m202400890']);
    const parsed = parse(res);
    expect(parsed.app_number).toBe('m202400890');
  });

  it('get_ip_object attaches lifecycle events and derives legal_status', async () => {
    const db = makeDb((sql) =>
      sql.includes('ip_object_events')
        ? { rows: [{ event_date: '2025-07-24', event_kind: 'termination', doc_type: 'Повідомлення про припинення', direction: 'Outcoming', doc_number: 'НО-51' }] }
        : { rows: [{ ...tmRow, obj_state: 2, raw_data: {} }] });
    const tool = new IpObjectsTools(db);
    const res = await tool.executeTool('get_ip_object', { app_number: 'm202400890' });
    const parsed = parse(res);
    expect(db.calls[1].sql).toContain('ip_object_events');
    expect(parsed.events).toHaveLength(1);
    expect(parsed.legal_status).toBe('дію припинено');
  });

  it('get_ip_object errors without an identifier', async () => {
    const tool = new IpObjectsTools(makeDb(() => ({ rows: [] })));
    const res = await tool.executeTool('get_ip_object', {});
    expect(res!.isError).toBe(true);
  });

  it('wraps DB errors', async () => {
    const db = makeDb(() => { throw new Error('boom'); });
    const tool = new IpObjectsTools(db);
    const res = await tool.executeTool('search_ip_objects', { query: 'x' });
    expect(res!.isError).toBe(true);
    expect(res!.content[0].text).toContain('boom');
  });

  it('get_trademark_dossier errors without a number', async () => {
    const tool = new IpObjectsTools(makeDb(() => ({ rows: [] })));
    const res = await tool.executeTool('get_trademark_dossier', {});
    expect(res!.isError).toBe(true);
  });

  it('get_trademark_dossier assembles card + collisions + orchestrates enrichment', async () => {
    const db = makeDb((sql) => {
      if (sql.includes('ip_object_events')) return { rows: [] };
      if (sql.includes('similarity(title_ua')) {
        return { rows: [{ ...tmRow, id: 9, registration_number: '381898', title_ua: 'alienware', similarity: 0.6 }] };
      }
      if (sql.includes('obj_type = 4 ORDER BY obj_state')) {
        return { rows: [{ ...tmRow, obj_state: 2, raw_data: {} }] };
      }
      // disambiguation
      return { rows: [{ obj_type: 4, obj_type_name: 'Торговельні марки', obj_state: 2,
        app_number: 'm202400890', registration_number: '67482', title_ua: 'planet',
        owner_name: 'ТОВ', status: 'green' }] };
    });
    const registry = { executeTool: jest.fn(async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] })) };
    const tool = new IpObjectsTools(db, registry);
    const res = await tool.executeTool('get_trademark_dossier', { number: '67482' });
    const p = parse(res);
    expect(p.query_number).toBe('67482');
    expect(Array.isArray(p.disambiguation)).toBe(true);
    expect(p.trademark.legal_status).toBeDefined();
    expect(p.collisions[0].similarity).toBe(0.6);
    // enrichment tools were orchestrated via the registry
    const called = registry.executeTool.mock.calls.map((c: any[]) => c[0]);
    expect(called).toEqual(expect.arrayContaining(['search_court_decisions', 'get_legislation_section']));
  });

  it('get_trademark_dossier returns the card when a sub-tool hangs past its deadline', async () => {
    jest.useFakeTimers();
    try {
      const db = makeDb((sql) => {
        if (sql.includes('ip_object_events') || sql.includes('similarity(title_ua')) return { rows: [] };
        if (sql.includes('obj_type = 4 ORDER BY obj_state')) return { rows: [{ ...tmRow, obj_state: 2, raw_data: {} }] };
        return { rows: [{ obj_type: 4, app_number: 'm202400890', registration_number: '67482' }] };
      });
      const registry = {
        executeTool: jest.fn((name: string) => name === 'search_court_decisions'
          ? new Promise(() => { /* never settles */ })
          : Promise.resolve({ content: [{ type: 'text', text: '{"ok":true}' }] })),
      };
      const tool = new IpObjectsTools(db, registry);
      const pending = tool.executeTool('get_trademark_dossier', { number: '67482' });
      await jest.advanceTimersByTimeAsync(30_000);
      const p = parse(await pending);
      expect(p.trademark.app_number).toBe('m202400890');
      // every court probe timed out: explicit empty list with the reason, not null
      expect(p.court_practice.results).toEqual([]);
      expect(p.court_practice.queries.every((q: any) => q.status === 'timeout')).toBe(true);
      expect(p.court_practice.note).toContain('не відповів');
      expect(p.owner_check).toEqual({ ok: true });
    } finally {
      jest.useRealTimers();
    }
  });

  describe('LEXAI-2103 trademark title from verbal elements', () => {
    const v = (...texts: string[]) => texts.map((t, i) => ({ '#text': t, '@sequenceNumber': i + 1 }));

    it('collapses the word-by-word token bag to the full phrase (Моршинська, 388592)', () => {
      expect(deriveMarkTitle(v('відновлення', 'сила', 'моя', 'моршинська', 'моршинська. моя сила відновлення.')))
        .toBe('моршинська. моя сила відновлення.');
      expect(deriveMarkTitle(v('столична нерухомість', 'столична', 'нерухомість'))).toBe('столична нерухомість');
    });

    it('keeps genuinely distinct parts (transliterations, slogans) in sequence order', () => {
      expect(deriveMarkTitle(v('н2о', 'h2o'))).toBe('н2о / h2o');
      expect(deriveMarkTitle(v('peppell', 'ВРЕМЯ ИЗМЕНИТ ВСЕ', 'THE TIME WILL CHANGE EVERYTHING')))
        .toBe('peppell / ВРЕМЯ ИЗМЕНИТ ВСЕ / THE TIME WILL CHANGE EVERYTHING');
      expect(deriveMarkTitle(v('esport news', 'esport', 'news', 'GG'))).toBe('esport news / GG');
    });

    it('drops punctuation variants, symbols and 1-2 char fragments of longer parts', () => {
      expect(deriveMarkTitle(v('диквалан', 'дикват 150 г/л в.р.к.', 'дикват', '150', 'г/л', 'в.р.к.', 'врк')))
        .toBe('диквалан / дикват 150 г/л в.р.к.');
      expect(deriveMarkTitle(v('а5', 'a5', 'А', '5'))).toBe('а5 / a5');
      expect(deriveMarkTitle(v('2+0=1х2', '2', '0', '1', '+', '='))).toBe('2+0=1х2');
      expect(deriveMarkTitle(v('u.s.s.r.', 'ussr'))).toBe('u.s.s.r.');
    });

    it('orders by @sequenceNumber and falls back to the stored title without elements', () => {
      expect(deriveMarkTitle([{ '#text': 'b', '@sequenceNumber': 2 }, { '#text': 'aaa', '@sequenceNumber': 1 }])).toBe('aaa / b');
      expect(deriveMarkTitle(null, 'stored')).toBe('stored');
      expect(deriveMarkTitle([], 'stored')).toBe('stored');
      expect(deriveMarkTitle({ '#text': 'single' })).toBe('single');
    });

    it('search results show the derived title and never leak _verbal', async () => {
      const db = makeDb(() => ({ rows: [{ ...tmRow, title_ua: 'сила моя моя сила', _verbal: v('сила', 'моя', 'моя сила') }] }));
      const tool = new IpObjectsTools(db);
      const p = parse(await tool.executeTool('search_trademarks', { query: 'сила' }));
      expect(db.calls[0].sql).toContain('MarkSignificantVerbalElement');
      expect(p.results[0].title_ua).toBe('моя сила');
      expect(p.results[0]).not.toHaveProperty('_verbal');
    });

    it('get_ip_object returns the derived title', async () => {
      const db = makeDb((sql) => sql.includes('ip_object_events')
        ? { rows: [] }
        : { rows: [{ ...tmRow, title_ua: 'a b a b', _verbal: v('a b', 'a', 'b'), raw_data: {} }] });
      const p = parse(await new IpObjectsTools(db).executeTool('get_ip_object', { app_number: 'm202400890' }));
      expect(p.title_ua).toBe('a b');
      expect(p).not.toHaveProperty('_verbal');
    });
  });

  describe('LEXAI-2102 dossier: court practice, same-owner collisions, no raw_data', () => {
    const verbal = [
      { '#text': 'відновлення', '@sequenceNumber': 1 },
      { '#text': 'моршинська', '@sequenceNumber': 2 },
      { '#text': 'моршинська. моя сила відновлення.', '@sequenceNumber': 3 },
    ];
    const raw = {
      registration_status_color: 'green',
      GoodsServicesDetails: { GoodsServices: { ClassDescriptionDetails: { ClassDescription: [
        { ClassNumber: 35, ClassificationTermDetails: { ClassificationTerm: [
          { ClassificationTermText: 'Рекламування' }, { ClassificationTermText: ' маркетинг;' },
        ] } },
      ] } } },
      WordMarkSpecification: { MarkSignificantVerbalElement: verbal },
    };
    const card = {
      ...tmRow, obj_state: 2, app_number: 'm202417463', registration_number: '388592', classes: ['35'],
      owner_edrpou: '24364528', owner_name: 'ПрАТ «ІДС»',
      title_ua: 'відновлення моршинська моршинська. моя сила відновлення.', _verbal: verbal, raw_data: raw,
    };
    const collisionRows = [
      { ...tmRow, id: 2, app_number: 'm1', owner_edrpou: '24364528', owner_name: 'x', title_ua: 'own', similarity: 0.85 },
      { ...tmRow, id: 3, app_number: 'm2', owner_edrpou: null, owner_name: 'ПрАТ «ІДС»', title_ua: 'own2', similarity: 0.6 },
      { ...tmRow, id: 4, app_number: 'm3', owner_edrpou: null, owner_name: 'Інший ТОВ', title_ua: 'моршинська', similarity: 0.37 },
    ];
    const dossierDb = () => makeDb((sql) => {
      if (sql.includes('ip_object_events')) return { rows: [] };
      if (sql.includes('similarity(title_ua')) return { rows: collisionRows };
      if (sql.includes('obj_type = 4 ORDER BY obj_state')) return { rows: [card] };
      return { rows: [{ obj_type: 4, obj_state: 2, app_number: 'm202417463', registration_number: '388592',
        title_ua: card.title_ua, _verbal: verbal }] };
    });

    it('drops raw_data, adds a compact Nice summary and the derived title', async () => {
      const registry = { executeTool: jest.fn(async () => ({ content: [{ type: 'text', text: '{"results":[],"total":0}' }] })) };
      const p = parse(await new IpObjectsTools(dossierDb(), registry).executeTool('get_trademark_dossier', { number: '388592' }));
      expect(p.trademark).not.toHaveProperty('raw_data');
      expect(p.trademark).not.toHaveProperty('_verbal');
      expect(p.trademark.nice_classes).toEqual([{ class: '35', terms_count: 2, sample_terms: ['Рекламування', 'маркетинг'] }]);
      expect(p.trademark.title_ua).toBe('моршинська. моя сила відновлення.');
      expect(p.disambiguation[0].title_ua).toBe('моршинська. моя сила відновлення.');
      expect(p.trademark.legal_status).toBe('чинний');
    });

    it('flags same-owner collisions and lists other owners first', async () => {
      const db = dossierDb();
      const registry = { executeTool: jest.fn(async () => ({ content: [{ type: 'text', text: '{"results":[]}' }] })) };
      const p = parse(await new IpObjectsTools(db, registry).executeTool('get_trademark_dossier', { number: '388592' }));
      expect(p.collisions.map((c: any) => [c.app_number, c.same_owner])).toEqual([
        ['m3', false], ['m1', true], ['m2', true],
      ]);
      expect(p.collision_summary).toMatchObject({ other_owner: 1, same_owner: 2, shown: 3 });
      // similarity still compares the STORED titles (like with like)
      const sim = db.calls.find(c => c.sql.includes('similarity(title_ua'))!;
      expect(sim.params[0]).toBe(card.title_ua);
    });

    it('court practice runs exact probes on the numbers and mark name and merges by doc_id', async () => {
      const registry = {
        executeTool: jest.fn(async (name: string, args: any) => {
          if (name !== 'search_court_decisions') return { content: [{ type: 'text', text: '{"ok":true}' }] };
          const byQuery: Record<string, any[]> = {
            m202417463: [{ doc_id: '1', justice_kind: 3, adjudication_date: '2020-01-01' }],
            'моршинська торговельна марка': [
              { doc_id: '1', justice_kind: 3, adjudication_date: '2020-01-01' },
              { doc_id: '2', justice_kind: 2, adjudication_date: '2024-01-01' },
            ],
            'моршинська знак для товарів і послуг': [{ doc_id: '3', justice_kind: 3, adjudication_date: '2021-02-04' }],
          };
          const rows = byQuery[args.query] ?? [];
          return { content: [{ type: 'text', text: JSON.stringify({ mode: 'exact', total: rows.length, results: rows }) }] };
        }),
      };
      const p = parse(await new IpObjectsTools(dossierDb(), registry).executeTool('get_trademark_dossier', { number: '388592' }));
      const courtCalls = registry.executeTool.mock.calls.filter((c: any[]) => c[0] === 'search_court_decisions');
      expect(courtCalls.every((c: any[]) => c[1].mode === 'exact')).toBe(true);
      expect(courtCalls.map((c: any[]) => c[1].query)).toEqual([
        'm202417463', '388592 знак для товарів і послуг',
        'моршинська торговельна марка', 'моршинська знак для товарів і послуг',
      ]);
      // number match first, then commercial before criminal
      expect(p.court_practice.results.map((r: any) => r.doc_id)).toEqual(['1', '3', '2']);
      expect(p.court_practice.results[0].matched_by).toEqual(['app_number', 'mark_name']);
      expect(p.court_practice.total).toBe(3);
    });

    it('court practice says why it is empty when the search answered with no matches', async () => {
      const registry = { executeTool: jest.fn(async () => ({ content: [{ type: 'text', text: '{"mode":"exact","total":0,"results":[]}' }] })) };
      const p = parse(await new IpObjectsTools(dossierDb(), registry).executeTool('get_trademark_dossier', { number: '388592' }));
      expect(p.court_practice.results).toEqual([]);
      expect(p.court_practice.note).toContain('не знайдено');
      expect(p.court_practice.note).toContain('m202417463');
    });

    it('helpers: niceSummary tolerates a single class object; markSearchName picks the brand', () => {
      expect(niceSummary({ GoodsServicesDetails: { GoodsServices: { ClassDescriptionDetails: { ClassDescription:
        { ClassNumber: 5, ClassificationTermDetails: { ClassificationTerm: { ClassificationTermText: 'ліки' } } } } } } }))
        .toEqual([{ class: '5', terms_count: 1, sample_terms: ['ліки'] }]);
      expect(niceSummary(null)).toEqual([]);
      expect(markSearchName('моршинська. моя сила відновлення.')).toBe('моршинська');
      expect(markSearchName('столична нерухомість / x')).toBe('столична нерухомість');
      expect(markSearchName(null)).toBeNull();
    });
  });
});
