/**
 * Registration tests for the Swiss (CH) tool surface.
 *
 * Covers:
 * - The seven ch_* tool names are present in the curated V2_TOOL_NAMES set exposed to
 *   external MCP clients.
 * - ChCourtTools / ChLegislationTools / ChRegistryTools expose exactly those names, each
 *   with a non-empty Ukrainian description and an object-typed inputSchema.
 * - Registering all three handlers into a fresh ToolRegistry surfaces all seven tools via
 *   getLocalToolDefinitions().
 */

import { ChCourtTools } from '../tools/ch-court-tools.js';
import { ChLegislationTools } from '../tools/ch-legislation-tools.js';
import { ChRegistryTools } from '../tools/ch-registry-tools.js';
import { ToolRegistry } from '../tool-registry.js';
import { V2_TOOL_NAMES } from '../curated-mcp-tools.js';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const CH_TOOL_NAMES = [
  'ch_search_court_decisions',
  'ch_get_court_decision',
  'ch_search_legislation',
  'ch_get_act_article',
  'ch_get_act_history',
  'ch_search_companies',
  'ch_get_company',
];

// Stub is only for construction (constructor(private db: any)) — executeTool is never
// called in this test.
const stubDb = {} as any;

function isCyrillic(text: string): boolean {
  return /[Ѐ-ӿ]/.test(text);
}

describe('CH tool surface registration', () => {
  it('V2_TOOL_NAMES contains the seven ch_* tools', () => {
    for (const name of CH_TOOL_NAMES) {
      expect(V2_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  describe('handler tool definitions', () => {
    it('ChCourtTools exposes exactly its two tools with Ukrainian descriptions', () => {
      const tool = new ChCourtTools(stubDb);
      const defs = tool.getToolDefinitions();
      expect(defs.map(d => d.name).sort()).toEqual(
        ['ch_get_court_decision', 'ch_search_court_decisions'].sort()
      );
      for (const def of defs) {
        expect(def.description).toBeTruthy();
        expect(isCyrillic(def.description)).toBe(true);
        expect(def.inputSchema.type).toBe('object');
      }
    });

    it('ChRegistryTools exposes exactly its two tools with Ukrainian descriptions', () => {
      const tool = new ChRegistryTools(stubDb);
      const defs = tool.getToolDefinitions();
      expect(defs.map(d => d.name).sort()).toEqual(
        ['ch_get_company', 'ch_search_companies'].sort()
      );
      for (const def of defs) {
        expect(def.description).toBeTruthy();
        expect(isCyrillic(def.description)).toBe(true);
        expect(def.inputSchema.type).toBe('object');
      }
    });

    it('ChLegislationTools exposes exactly its three tools with Ukrainian descriptions', () => {
      const tool = new ChLegislationTools(stubDb);
      const defs = tool.getToolDefinitions();
      expect(defs.map(d => d.name).sort()).toEqual(
        ['ch_get_act_article', 'ch_get_act_history', 'ch_search_legislation'].sort()
      );
      for (const def of defs) {
        expect(def.description).toBeTruthy();
        expect(isCyrillic(def.description)).toBe(true);
        expect(def.inputSchema.type).toBe('object');
      }
    });
  });

  describe('ToolRegistry registration', () => {
    it('getLocalToolDefinitions includes all seven ch_* tools after registering the handlers', () => {
      const registry = new ToolRegistry();
      registry.registerHandler(new ChCourtTools(stubDb));
      registry.registerHandler(new ChLegislationTools(stubDb));
      registry.registerHandler(new ChRegistryTools(stubDb));

      const names = registry.getLocalToolDefinitions().map(d => d.name);
      for (const name of CH_TOOL_NAMES) {
        expect(names).toContain(name);
      }
    });
  });
});
