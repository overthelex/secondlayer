/**
 * Registration tests for the Swiss (CH) tool surface.
 *
 * Covers:
 * - The eight ch_* tool names are present in the curated V2_TOOL_NAMES set exposed to
 *   external MCP clients.
 * - ChCourtTools / ChLegislationTools / ChRegistryTools expose exactly those names, each
 *   with a non-empty Ukrainian description and an object-typed inputSchema.
 * - Registering all three handlers into a fresh ToolRegistry surfaces all eight tools via
 *   getLocalToolDefinitions().
 */

import { ChCitationTools } from '../tools/ch-citation-tools.js';
import { ChVerificationTools } from '../tools/ch-verification-tools.js';
import { ChCourtTools } from '../tools/ch-court-tools.js';
import { ChLegislationTools } from '../tools/ch-legislation-tools.js';
import { ChRegistryTools } from '../tools/ch-registry-tools.js';
import { ChCommentaryTools } from '../tools/ch-commentary-tools.js';
import { ChMaterialsTools } from '../tools/ch-materials-tools.js';
import { ChSemanticTools } from '../tools/ch-semantic-tools.js';
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
  'ch_get_act_text',
  'ch_get_decision_legislation',
  'ch_search_companies',
  'ch_get_company',
  'ch_get_citation_graph',
  'ch_check_precedent_status',
  'ch_verify_citations',
  'ch_get_commentary',
  'ch_search_commentary',
  'ch_search_materials',
  'ch_get_material',
  'ch_get_article_purpose',
  'ch_semantic_search',
];

// Stub is only for construction (constructor(private db: any)) — executeTool is never
// called in this test.
const stubDb = {} as any;

function isCyrillic(text: string): boolean {
  return /[Ѐ-ӿ]/.test(text);
}

describe('CH tool surface registration', () => {
  it('V2_TOOL_NAMES contains the eight ch_* tools', () => {
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

    it('documents legal_form with the German labels the column actually holds', () => {
      // legal_form is filtered with a case-insensitive PREFIX match against
      // ch_zefix_companies.legal_form, and that column is the label the LINDAS graph
      // publishes — German, always, and sometimes a composite ("Gesellschaft mit
      // beschränkter Haftung GMBH / SARL"), which is why the match is a prefix and not
      // an equality. Offering 'Société anonyme' as an example would document a filter
      // that can only return nothing.
      const tool = new ChRegistryTools(stubDb);
      const search = tool.getToolDefinitions().find(d => d.name === 'ch_search_companies')!;
      const doc = `${search.description} ${(search.inputSchema as any).properties.legal_form.description}`;

      expect(doc).toContain('Aktiengesellschaft');
      expect(doc).toContain('Gesellschaft mit beschränkter Haftung');
      expect(doc).not.toMatch(/Société|Sàrl|Sagl|società|anonima/i);
    });

    it('ChCitationTools exposes exactly its two tools with Ukrainian descriptions', () => {
      const tool = new ChCitationTools(stubDb);
      const defs = tool.getToolDefinitions();
      expect(defs.map(d => d.name).sort()).toEqual(
        ['ch_check_precedent_status', 'ch_get_citation_graph'].sort()
      );
      for (const def of defs) {
        expect(def.description).toBeTruthy();
        expect(isCyrillic(def.description)).toBe(true);
        expect(def.inputSchema.type).toBe('object');
      }
    });

    it('ChVerificationTools exposes exactly its one tool with a Ukrainian description', () => {
      const tool = new ChVerificationTools(stubDb);
      const defs = tool.getToolDefinitions();
      expect(defs.map(d => d.name)).toEqual(['ch_verify_citations']);
      for (const def of defs) {
        expect(def.description).toBeTruthy();
        expect(isCyrillic(def.description)).toBe(true);
        expect(def.inputSchema.type).toBe('object');
      }
    });

    it('ChCommentaryTools exposes exactly its two tools with Ukrainian descriptions', () => {
      const tool = new ChCommentaryTools(stubDb);
      const defs = tool.getToolDefinitions();
      expect(defs.map(d => d.name).sort()).toEqual(
        ['ch_get_commentary', 'ch_search_commentary'].sort()
      );
      for (const def of defs) {
        expect(def.description).toBeTruthy();
        expect(isCyrillic(def.description)).toBe(true);
        expect(def.inputSchema.type).toBe('object');
        // CC BY: the description must tell the caller the text is attributed and licensed.
        expect(def.description).toContain('CC BY 4.0');
      }
    });

    it('ChMaterialsTools exposes exactly its three tools with Ukrainian descriptions', () => {
      const tool = new ChMaterialsTools(stubDb);
      const defs = tool.getToolDefinitions();
      expect(defs.map(d => d.name).sort()).toEqual(
        ['ch_get_article_purpose', 'ch_get_material', 'ch_search_materials'].sort()
      );
      for (const def of defs) {
        expect(def.description).toBeTruthy();
        expect(isCyrillic(def.description)).toBe(true);
        expect(def.inputSchema.type).toBe('object');
      }
    });

    it('ChLegislationTools exposes exactly its five tools with Ukrainian descriptions', () => {
      const tool = new ChLegislationTools(stubDb);
      const defs = tool.getToolDefinitions();
      expect(defs.map(d => d.name).sort()).toEqual(
        ['ch_get_act_article', 'ch_get_act_history', 'ch_get_act_text', 'ch_get_decision_legislation', 'ch_search_legislation'].sort()
      );
      for (const def of defs) {
        expect(def.description).toBeTruthy();
        expect(isCyrillic(def.description)).toBe(true);
        expect(def.inputSchema.type).toBe('object');
      }
    });
  });

  describe('handler tool definitions (semantic)', () => {
    it('ChSemanticTools exposes ch_semantic_search with an English description', () => {
      const tool = new ChSemanticTools(stubDb);
      const defs = tool.getToolDefinitions();
      expect(defs.map(d => d.name)).toEqual(['ch_semantic_search']);
      const def = defs[0];
      expect(def.description).toBeTruthy();
      // Swiss tools are documented in English (user ruling 2026-09-03).
      expect(isCyrillic(def.description)).toBe(false);
      expect(def.inputSchema.type).toBe('object');
      expect(def.inputSchema.required).toEqual(['query']);
    });
  });

  describe('ToolRegistry registration', () => {
    it('getLocalToolDefinitions includes all eight ch_* tools after registering the handlers', () => {
      const registry = new ToolRegistry();
      registry.registerHandler(new ChCourtTools(stubDb));
      registry.registerHandler(new ChLegislationTools(stubDb));
      registry.registerHandler(new ChRegistryTools(stubDb));
      registry.registerHandler(new ChCitationTools(stubDb));
      registry.registerHandler(new ChVerificationTools(stubDb));
      registry.registerHandler(new ChCommentaryTools(stubDb));
      registry.registerHandler(new ChMaterialsTools(stubDb));
      registry.registerHandler(new ChSemanticTools(stubDb));

      const names = registry.getLocalToolDefinitions().map(d => d.name);
      for (const name of CH_TOOL_NAMES) {
        expect(names).toContain(name);
      }
    });
  });
});
