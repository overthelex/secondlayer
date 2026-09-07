/**
 * The curated v2 whitelist is shared by two deployments with different data:
 * legal.org.ua carries the Ukrainian corpora and empty ch_* tables, lawrider the
 * Swiss ones. Advertising the union on both meant legal.org.ua offered 18 Swiss
 * tools that could only answer "no results". MCP_TOOL_JURISDICTIONS gates the
 * slices; these tests pin the parsing and the resulting sets.
 */

import { parseToolJurisdictions, buildV2ToolNames } from '../curated-mcp-tools.js';

describe('parseToolJurisdictions', () => {
  it('serves every jurisdiction when unset or blank', () => {
    expect(parseToolJurisdictions(undefined)).toEqual(['ua', 'ch']);
    expect(parseToolJurisdictions('')).toEqual(['ua', 'ch']);
    expect(parseToolJurisdictions('   ')).toEqual(['ua', 'ch']);
  });

  it('reads a single jurisdiction', () => {
    expect(parseToolJurisdictions('ua')).toEqual(['ua']);
    expect(parseToolJurisdictions('ch')).toEqual(['ch']);
  });

  it('tolerates whitespace, case and duplicates', () => {
    expect(parseToolJurisdictions(' UA , ch ,ua')).toEqual(['ua', 'ch']);
  });

  it('falls back to every jurisdiction rather than serving nothing on a typo', () => {
    expect(parseToolJurisdictions('uka')).toEqual(['ua', 'ch']);
    expect(parseToolJurisdictions('de,fr')).toEqual(['ua', 'ch']);
  });

  it('keeps the recognised half of a partly mistyped list', () => {
    expect(parseToolJurisdictions('ua,de')).toEqual(['ua']);
  });
});

describe('buildV2ToolNames', () => {
  const ua = buildV2ToolNames(['ua']);
  const ch = buildV2ToolNames(['ch']);
  const both = buildV2ToolNames(['ua', 'ch']);

  it('drops every Swiss tool from a ua-only deployment', () => {
    expect([...ua].filter((n) => n.startsWith('ch_'))).toEqual([]);
    expect(ua.has('search_court_decisions')).toBe(true);
    expect(ua.has('openreyestr_search_entities')).toBe(true);
    expect(ua.has('rada_search_parliament_bills')).toBe(true);
  });

  it('serves only Swiss tools on a ch-only deployment', () => {
    expect([...ch].every((n) => n.startsWith('ch_'))).toBe(true);
    expect(ch.has('ch_semantic_search')).toBe(true);
    expect(ch.has('search_court_decisions')).toBe(false);
  });

  it('the two slices are disjoint and together are the whole list', () => {
    expect([...ua].filter((n) => ch.has(n))).toEqual([]);
    expect(both.size).toBe(ua.size + ch.size);
  });
});
