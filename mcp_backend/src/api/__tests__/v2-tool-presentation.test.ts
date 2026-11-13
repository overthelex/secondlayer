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
