import { IpObjectsTools } from '../tools/ip-objects-tools.js';

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
    // legal entity: owner check via EDRPOU, no skip marker
    expect(called).toContain('openreyestr_get_by_edrpou');
    expect(p.owner_check).toEqual({ ok: true });
  });

  // A dossier DB mock: disambiguation + card (customisable) + no events/collisions.
  function makeDossierDb(cardRow: any) {
    return makeDb((sql) => {
      if (sql.includes('ip_object_events')) return { rows: [] };
      if (sql.includes('similarity(title_ua')) return { rows: [] };
      if (sql.includes('obj_type = 4 ORDER BY obj_state')) return { rows: [cardRow] };
      return { rows: [{ obj_type: 4, obj_type_name: 'Торговельні марки', obj_state: 2,
        app_number: cardRow.app_number, registration_number: cardRow.registration_number,
        title_ua: cardRow.title_ua, owner_name: cardRow.owner_name, status: 'green' }] };
    });
  }

  it('get_trademark_dossier marks owner_check as service_unavailable when the EDRPOU lookup fails', async () => {
    const db = makeDossierDb({ ...tmRow, obj_state: 2, registration_number: '67482', raw_data: {} });
    const registry = { executeTool: jest.fn(async (name: string) =>
      name === 'openreyestr_get_by_edrpou'
        ? { isError: true, content: [{ type: 'text', text: 'down' }] }
        : { content: [{ type: 'text', text: '{"ok":true}' }] }) };
    const tool = new IpObjectsTools(db, registry);
    const p = parse(await tool.executeTool('get_trademark_dossier', { number: '67482' }));
    expect(p.owner_check).toEqual({ skipped: true, reason: 'service_unavailable' });
  });

  it('get_trademark_dossier fans out by name for an individual owner (no EDRPOU)', async () => {
    const individual = {
      ...tmRow, obj_state: 2, registration_number: '67482',
      owner_name: 'Дьяконенко Олександр Євгенович', owner_edrpou: null, owner_kind: 'individual',
      raw_data: { HolderDetails: { Holder: [{ HolderAddressBook: { FormattedNameAddress: {
        Address: { AddressCountryCode: 'UA', FreeFormatAddress: { FreeFormatAddressLine: 'вул. Тестова, 1, м. Київ' } },
      } } }] } },
    };
    const db = makeDossierDb(individual);
    const registry = { executeTool: jest.fn(async (name: string) =>
      name === 'openreyestr_search_debtors'
        ? { content: [{ type: 'text', text: '{"results":[{"debtor_name":"Дьяконенко О.Є."}]}' }] }
        : { content: [{ type: 'text', text: '{"results":[]}' }] }) };
    const tool = new IpObjectsTools(db, registry);
    const p = parse(await tool.executeTool('get_trademark_dossier', { number: '67482' }));

    const check = p.owner_check;
    expect(check.skipped).toBeUndefined();
    expect(check.match_basis).toBe('name_only');
    expect(check.owner_address).toBe('вул. Тестова, 1, м. Київ');
    expect(check.probable_matches.debtors.results[0].debtor_name).toBe('Дьяконенко О.Є.');
    expect(Object.keys(check.probable_matches)).toEqual(expect.arrayContaining([
      'debtors', 'enforcement_proceedings', 'bankruptcy_cases', 'sanctions',
      'business_entities', 'ip_portfolio', 'court_hearings',
    ]));

    const calls = registry.executeTool.mock.calls;
    const byTool = (n: string) => calls.filter((c: any[]) => c[0] === n).map((c: any[]) => c[1]);
    expect(calls.map((c: any[]) => c[0])).not.toContain('openreyestr_get_by_edrpou');
    expect(byTool('openreyestr_search_debtors')[0]).toMatchObject({ query: 'Дьяконенко Олександр Євгенович' });
    expect(byTool('search_registry')[0]).toMatchObject({ registry: 'sanctions', filters: { name: 'Дьяконенко Олександр Євгенович' } });
    expect(byTool('search_ip_objects')[0]).toMatchObject({ owner: 'Дьяконенко Олександр Євгенович' });
    expect(byTool('search_court_hearing_schedule')[0]).toMatchObject({ participant: 'Дьяконенко Олександр Євгенович' });
    // volume capped per source
    for (const [name, args] of calls as unknown as Array<[string, any]>) {
      if (name !== 'search_court_decisions' && name !== 'get_legislation_section') {
        expect(args.limit).toBeLessThanOrEqual(10);
      }
    }
  });

  it('get_trademark_dossier marks a failed fan-out source without failing the dossier', async () => {
    const individual = { ...tmRow, obj_state: 2, registration_number: '67482',
      owner_name: 'Дьяконенко Олександр Євгенович', owner_edrpou: null, raw_data: {} };
    const db = makeDossierDb(individual);
    const registry = { executeTool: jest.fn(async (name: string) => {
      if (name === 'openreyestr_search_debtors') throw new Error('service down');
      return { content: [{ type: 'text', text: '{"results":[]}' }] };
    }) };
    const tool = new IpObjectsTools(db, registry);
    const p = parse(await tool.executeTool('get_trademark_dossier', { number: '67482' }));
    expect(p.owner_check.probable_matches.debtors).toEqual({ skipped: true, reason: 'service_unavailable' });
    expect(p.owner_check.probable_matches.sanctions).toEqual({ results: [] });
  });

  it('get_trademark_dossier skips owner_check with a reason when there is no owner at all', async () => {
    const db = makeDossierDb({ ...tmRow, obj_state: 2, registration_number: '67482',
      owner_name: null, owner_edrpou: null, raw_data: {} });
    const registry = { executeTool: jest.fn(async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] })) };
    const tool = new IpObjectsTools(db, registry);
    const p = parse(await tool.executeTool('get_trademark_dossier', { number: '67482' }));
    expect(p.owner_check).toEqual({ skipped: true, reason: 'no_owner_identifier' });
  });
});
