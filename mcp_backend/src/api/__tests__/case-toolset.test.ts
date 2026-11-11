import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import sharp from 'sharp';
import { CaseToolset, CaseToolsetDeps, LlmCall } from '../private-tools/case-toolset.js';
import { PrivateDocsToolset } from '../private-tools/private-docs-toolset.js';

export const text = (r: any) => r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');

export async function jpeg(w = 60, h = 90): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#fff' } }).jpeg().toBuffer();
}

export function makeToolset(over: Partial<CaseToolsetDeps> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'cases-'));
  const calls: LlmCall[] = [];
  const deps: CaseToolsetDeps = {
    ocr: async () => 'УХВАЛА 15 жовтня 2026 року Святошинський районний суд м. Києва справа № 369/1234/26',
    llm: async (c) => {
      calls.push(c);
      return JSON.stringify({ case_number: '369/1234/26', court: 'Святошинський районний суд м. Києва', doc_kind: 'ухвала', doc_date: '2026-10-15', parties: ['Худик Б.І.'] });
    },
    legislation: {
      getMultipleArticles: async (radaId, nums, asOf) => nums.map((n) => ({
        rada_id: radaId, article_number: n, title: `Стаття ${n}`, full_text: `Текст статті ${n}`,
        url: `https://zakon.rada.gov.ua/laws/show/${radaId}#n${n}`,
        metadata: { edition_date: asOf ? asOf.replace(/-/g, '') : '20260101' },
      })),
    },
    fetchFile: async () => ({ buffer: await jpeg(), mimeType: 'image/jpeg' }),
    now: () => new Date('2026-11-11T10:00:00Z'),
    ...over,
  };
  return { root, calls, toolset: new CaseToolset(new PrivateDocsToolset('cases', root, 'Справи'), deps) };
}

// Referenced by later tasks' tests; keeps the imports used until then.
void readFileSync; void existsSync; void readdirSync;

describe('CaseToolset definitions', () => {
  it('exposes seven tools under the cases_ prefix', () => {
    const { toolset } = makeToolset();
    expect(toolset.toolNames()).toHaveLength(7);
    expect(toolset.toolNames().every((n) => n.startsWith('cases_'))).toBe(true);
  });
});
