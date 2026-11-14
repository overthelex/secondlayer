import { V2_TOOL_NAMES } from '../curated-mcp-tools.js';
import {
  V2_ANNOTATION_OVERRIDES,
  V2_DESCRIPTION_OVERRIDES,
  presentV2Tools,
} from '../v2-tool-presentation.js';

describe('v2 tool presentation', () => {
  it('annotates every proxied v2 tool (they arrive without annotations)', () => {
    const proxied = [...V2_TOOL_NAMES].filter((n) => n.startsWith('openreyestr_') || n.startsWith('rada_'));
    expect(proxied.length).toBeGreaterThan(0);
    const missing = proxied.filter((n) => !V2_ANNOTATION_OVERRIDES[n]?.title);
    expect(missing).toEqual([]);
  });

  it('only overrides tools that are on the v2 whitelist', () => {
    const stray = [...Object.keys(V2_ANNOTATION_OVERRIDES), ...Object.keys(V2_DESCRIPTION_OVERRIDES)]
      .filter((n) => !V2_TOOL_NAMES.has(n));
    expect(stray).toEqual([]);
  });

  it('every override is declared read-only and non-destructive', () => {
    for (const [name, a] of Object.entries(V2_ANNOTATION_OVERRIDES)) {
      expect({ name, ro: a.readOnlyHint, destructive: a.destructiveHint }).toEqual({ name, ro: true, destructive: false });
    }
  });

  it('override descriptions name no other tool', () => {
    const names = [...V2_TOOL_NAMES];
    for (const [tool, text] of Object.entries(V2_DESCRIPTION_OVERRIDES)) {
      const mentioned = names.filter((n) => n !== tool && text.includes(n));
      expect({ tool, mentioned }).toEqual({ tool, mentioned: [] });
    }
  });

  it('replaces descriptions, normalises proxied text and leaves the input untouched', () => {
    const input = [
      { name: 'search_npa', description: 'Далі: get_npa_act', inputSchema: { type: 'object', properties: {} } },
      {
        name: 'openreyestr_search_debtors',
        description: '[OpenReyestr] Пошук боржників\n💰 Примерная стоимость: $0.001 USD',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'search_legislation',
        description: 'Семантичний пошук',
        inputSchema: { type: 'object', properties: {} },
        annotations: { title: 'Пошук законодавства', readOnlyHint: true },
      },
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = presentV2Tools(input);

    expect(out[0].description).toBe(V2_DESCRIPTION_OVERRIDES.search_npa);
    expect(out[1].description).toBe('Пошук боржників\n💰 Орієнтовна вартість: $0.001 USD');
    expect(out[1].annotations).toMatchObject({ title: 'Єдиний реєстр боржників', readOnlyHint: true, destructiveHint: false });
    expect(out[2]).toEqual(input[2]);
    expect(input).toEqual(snapshot);
  });
});

describe('applyListPrices', () => {
  const { applyListPrices } = require('../v2-tool-presentation');
  it('replaces the hand-written cost line with the list price, keeps unpriced tools', () => {
    const tools = [
      { name: 'openreyestr_get_by_edrpou', description: 'Пошук\n\n💰 Орієнтовна вартість: $0.001 USD\nІнше', inputSchema: {} },
      { name: 'get_company_dossier', description: 'Досьє', inputSchema: {} },
      { name: 'search_legal_precedents', description: 'LLM\n💰 Орієнтовна вартість: $0.01-$0.05 USD', inputSchema: {} },
    ];
    const out = applyListPrices(tools, new Map([['openreyestr_get_by_edrpou', 0.01100657], ['get_company_dossier', 0.17610517]]));
    expect(out[0].description).toBe('Пошук\n\n💰 Ціна за виклик: $0.011 USD за прайсом, плюс націнка тарифу (Startup +30%, Business +50%); якщо фактична вартість вища, списується вона.\nІнше');
    expect(out[1].description).toMatch(/Досьє\n\n💰 Ціна за виклик: \$0\.18 USD/);
    expect(out[2].description).toBe(tools[2].description);
    expect(applyListPrices(tools, new Map())).toBe(tools);
  });
});
