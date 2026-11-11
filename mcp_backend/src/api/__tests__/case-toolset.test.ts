import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import sharp from 'sharp';
import {
  CaseToolset, CaseToolsetDeps, LlmCall, sanitizeCaseFolder, documentFolderName, fetchFileSafely, isPrivateAddress,
} from '../private-tools/case-toolset.js';
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
  if (over.llm) {
    const inner = over.llm;
    deps.llm = async (c) => { calls.push(c); return inner(c); };
  }
  return { root, calls, toolset: new CaseToolset(new PrivateDocsToolset('cases', root, 'Справи'), deps) };
}

describe('CaseToolset definitions', () => {
  it('exposes seven tools under the cases_ prefix', () => {
    const { toolset } = makeToolset();
    expect(toolset.toolNames()).toHaveLength(7);
    expect(toolset.toolNames().every((n) => n.startsWith('cases_'))).toBe(true);
  });
});

describe('cases_upload_pages', () => {
  it('sanitises folder names', () => {
    expect(sanitizeCaseFolder('369/1234/26')).toBe('369_1234_26');
    expect(sanitizeCaseFolder('../etc')).toBe('_без-номера');
    expect(sanitizeCaseFolder(null)).toBe('_без-номера');
    expect(documentFolderName({ doc_date: '2026-10-15', doc_kind: 'ухвала', court: 'Святошинський районний суд м. Києва' }))
      .toBe('2026-10-15-ухвала-святошинський-районний-суд-м-києва');
    expect(documentFolderName({ doc_date: null, doc_kind: 'інше', court: null })).toBe('без-дати-інше');
  });

  it('refuses non-https and private download targets', async () => {
    await expect(fetchFileSafely('http://example.com/a.jpg')).rejects.toThrow(/https/);
    expect(isPrivateAddress('10.0.0.1')).toBe(true);
    expect(isPrivateAddress('172.16.5.5')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('169.254.1.1')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });

  it('writes jpg + txt + _meta.json, names the folder from the model, and reports pages', async () => {
    const { root, toolset, calls } = makeToolset();
    const r = await toolset.execute('cases_upload_pages', { files: [
      { download_url: 'https://files.example/1', file_id: 'f1', mime_type: 'image/jpeg', file_name: 'IMG_1.jpg' },
      { download_url: 'https://files.example/2', file_id: 'f2' },
    ] });
    const dir = path.join(root, '369_1234_26', '2026-10-15-ухвала-святошинський-районний-суд-м-києва');
    expect(readdirSync(dir).sort()).toEqual(['01.jpg', '01.txt', '02.jpg', '02.txt', '_meta.json']);
    const meta = JSON.parse(readFileSync(path.join(dir, '_meta.json'), 'utf8'));
    expect(meta.case_number).toBe('369/1234/26');
    expect(meta.pages).toHaveLength(2);
    expect(meta.pages[0].ocr).toBe('vision');
    expect(meta.uploaded_at).toBe('2026-11-11T10:00:00.000Z');
    expect(calls[0].tier).toBe('quick');
    expect(calls[0].imageJpeg).toBeInstanceOf(Buffer);
    expect(calls[0].json).toBe(true);
    const out = text(r);
    expect(out).toContain('369_1234_26/2026-10-15-ухвала-святошинський-районний-суд-м-києва');
    expect(out).toContain('Сторінок: 2');
    expect(out).not.toContain('files.example');
    expect(text(await toolset.execute('cases_search_documents', { query: '369/1234/26' }))).toContain('369_1234_26/');
  });

  it('keeps the document when one page fails and marks pages without text', async () => {
    let n = 0;
    const { root, toolset } = makeToolset({
      fetchFile: async () => { n++; if (n === 2) throw new Error('boom'); return { buffer: await jpeg(), mimeType: 'image/jpeg' }; },
      ocr: async () => '',
    });
    const r = await toolset.execute('cases_upload_pages', { files: [1, 2, 3].map((i) => ({ download_url: `https://f/${i}`, file_id: `f${i}` })) });
    const out = text(r);
    expect(r.isError).toBeUndefined();
    expect(out).toContain('стор. 2');
    expect(out).toMatch(/не вдалося|помилка/i);
    expect(out).toContain('без тексту');
    const docDir = path.join(root, '369_1234_26', readdirSync(path.join(root, '369_1234_26'))[0]);
    const meta = JSON.parse(readFileSync(path.join(docDir, '_meta.json'), 'utf8'));
    expect(meta.pages.map((p: any) => p.ocr)).toEqual(['none', 'failed', 'none']);
    expect(existsSync(path.join(docDir, '02.jpg'))).toBe(false);
  });

  it('falls back to _без-номера when the model answer is not JSON or has junk in it', async () => {
    const { root, toolset } = makeToolset({ llm: async () => 'Не можу визначити' });
    await toolset.execute('cases_upload_pages', { pages_base64: [{ data: (await jpeg()).toString('base64'), mime_type: 'image/jpeg' }] });
    expect(existsSync(path.join(root, '_без-номера'))).toBe(true);
    const { root: r2, toolset: t2 } = makeToolset({ llm: async () => JSON.stringify({ case_number: '../../x', court: null, doc_kind: 'ухвала', doc_date: 'вчора', parties: 'ні' }) });
    await t2.execute('cases_upload_pages', { pages_base64: [{ data: (await jpeg()).toString('base64'), mime_type: 'image/jpeg' }] });
    expect(readdirSync(r2)).toEqual(['_без-номера']);
    expect(readdirSync(path.join(r2, '_без-номера'))[0]).toMatch(/^без-дати-ухвала/);
  });

  it('appends -2 instead of overwriting a document uploaded twice', async () => {
    const { root, toolset } = makeToolset();
    const args = { pages_base64: [{ data: (await jpeg()).toString('base64'), mime_type: 'image/jpeg' }] };
    await toolset.execute('cases_upload_pages', args);
    await toolset.execute('cases_upload_pages', args);
    expect(readdirSync(path.join(root, '369_1234_26')).sort()).toEqual([
      '2026-10-15-ухвала-святошинський-районний-суд-м-києва', '2026-10-15-ухвала-святошинський-районний-суд-м-києва-2']);
  });

  it('rejects empty input, more than 15 pages, unsupported mime and oversize files', async () => {
    const { toolset } = makeToolset();
    expect((await toolset.execute('cases_upload_pages', {})).isError).toBe(true);
    expect((await toolset.execute('cases_upload_pages', { files: Array.from({ length: 16 }, (_, i) => ({ download_url: 'https://f/x', file_id: `f${i}` })) })).isError).toBe(true);
    const bad = await toolset.execute('cases_upload_pages', { pages_base64: [{ data: 'JVBERi0=', mime_type: 'application/pdf' }] });
    expect(bad.isError).toBe(true);
    const big = await toolset.execute('cases_upload_pages', { pages_base64: [{ data: Buffer.alloc(21 * 1024 * 1024).toString('base64'), mime_type: 'image/jpeg' }] });
    expect(big.isError).toBe(true);
  });
});

describe('cases_find_violations', () => {
  async function uploaded() {
    const t = makeToolset();
    await t.toolset.execute('cases_upload_pages', { pages_base64: [{ data: (await jpeg()).toString('base64'), mime_type: 'image/jpeg' }] });
    return { ...t, doc: '369_1234_26/2026-10-15-ухвала-святошинський-районний-суд-м-києва' };
  }

  it('checks a stored ruling against ЦПК articles as of the document date and prints article texts', async () => {
    const { toolset, calls, doc } = await uploaded();
    const asked: Array<[string, string[], string | undefined]> = [];
    (toolset as any).deps.legislation = { getMultipleArticles: async (r: string, n: string[], d?: string) => {
      asked.push([r, n, d]);
      return n.map((x) => ({ rada_id: r, article_number: x, title: `Стаття ${x}`, full_text: `Текст ${x}`, url: `https://zakon.rada.gov.ua/laws/show/${r}#n${x}`, metadata: { edition_date: '20261001' } }));
    } };
    calls.length = 0;
    (toolset as any).deps.llm = async (c: LlmCall) => {
      calls.push(c);
      return JSON.stringify({ findings: [
        { article: '260', requirement: 'ухвала містить мотиви', finding: 'порушення', quote: 'без мотивів', page: 1, severity: 'висока' },
        { article: '272', requirement: 'вручення копії', finding: 'не видно з фото', quote: '', page: null, severity: 'середня' },
      ] });
    };
    const out = text(await toolset.execute('cases_find_violations', { document: doc, code: 'цпк', doc_kind: 'ухвала' }));
    expect(asked[0]).toEqual(['1618-15', ['260', '272', '128', '187'], '2026-10-15']);
    expect(out).toContain('редакцією на 2026-10-15');
    expect(out).toContain('ст. 260');
    expect(out).toContain('Текст 260');
    expect(out).toContain('01.10.2026');
    expect(out).toContain('не видно з фото');
    expect(calls[0].tier).toBe('deep');
    expect(calls[0].user).toContain('Текст 260');
  });

  it('classifies code and kind with the quick model when not given, and says so when the date is unknown', async () => {
    const { toolset, calls } = makeToolset({ llm: async (c) => c.tier === 'quick'
      ? JSON.stringify({ code: 'купап', doc_kind: 'постанова' })
      : JSON.stringify({ findings: [] }) });
    const out = text(await toolset.execute('cases_find_violations', { text: 'ПОСТАНОВА про накладення адміністративного стягнення…' }));
    expect(calls.map((c) => c.tier)).toEqual(['quick', 'deep']);
    expect(out).toContain('за поточною редакцією');
    expect(out).toContain('КУпАП');
    expect(out).toContain('Порушень не знайдено');
  });

  it('refuses a document path outside the folder and an unknown combination', async () => {
    const { toolset } = makeToolset();
    expect((await toolset.execute('cases_find_violations', { document: '../x' })).isError).toBe(true);
    const r = await toolset.execute('cases_find_violations', { text: 'x', code: 'цпк', doc_kind: 'протокол' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('немає');
  });
});

describe('cases_complaint_norms', () => {
  it('returns the current texts of the complaint articles plus the court fee article', async () => {
    const { toolset, calls } = makeToolset();
    const out = text(await toolset.execute('cases_complaint_norms', { code: 'ЦПК', complaint_kind: 'апеляційна скарга на рішення' }));
    expect(calls).toHaveLength(0);
    for (const n of ['352', '354', '355', '356', '357']) expect(out).toContain(`ст. ${n}`);
    expect(out).toContain('3674-17');
    expect(out).toContain('Текст статті 4');
    expect(out).toMatch(/скаргу складає модель/i);
  });

  it('omits the fee for КУпАП and refuses combinations the code does not have', async () => {
    const { toolset } = makeToolset();
    const out = text(await toolset.execute('cases_complaint_norms', { code: 'купап', complaint_kind: 'скарга на постанову у справі про адмінправопорушення' }));
    expect(out).toContain('ст. 289');
    expect(out).not.toContain('3674-17');
    const r = await toolset.execute('cases_complaint_norms', { code: 'купап', complaint_kind: 'касаційна скарга' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('КУпАП');
  });
});

describe('review fixes', () => {
  it('records the calling user in _meta.json from the execution context, not from arguments', async () => {
    const { root, toolset } = makeToolset();
    const args = { pages_base64: [{ data: (await jpeg()).toString('base64'), mime_type: 'image/jpeg' }], __userId: 'spoofed' };
    await toolset.execute('cases_upload_pages', args, { userId: 'u-real' });
    const dir = path.join(root, '369_1234_26', readdirSync(path.join(root, '369_1234_26'))[0]);
    expect(JSON.parse(readFileSync(path.join(dir, '_meta.json'), 'utf8')).uploaded_by).toBe('u-real');
  });

  it('removes its staging folder when the upload fails midway', async () => {
    const { root, toolset } = makeToolset({ now: () => { throw new Error('clock'); } });
    const r = await toolset.execute('cases_upload_pages', { pages_base64: [{ data: (await jpeg()).toString('base64'), mime_type: 'image/jpeg' }] });
    expect(r.isError).toBe(true);
    expect(readdirSync(root).filter((n) => n.startsWith('.incoming-'))).toEqual([]);
  });

  it('survives two simultaneous uploads of the same document', async () => {
    const { root, toolset } = makeToolset();
    const args = { pages_base64: [{ data: (await jpeg()).toString('base64'), mime_type: 'image/jpeg' }] };
    const [a, b] = await Promise.all([toolset.execute('cases_upload_pages', args), toolset.execute('cases_upload_pages', args)]);
    expect(a.isError).toBeUndefined();
    expect(b.isError).toBeUndefined();
    expect(readdirSync(path.join(root, '369_1234_26')).sort()).toEqual([
      '2026-10-15-ухвала-святошинський-районний-суд-м-києва', '2026-10-15-ухвала-святошинський-районний-суд-м-києва-2']);
    expect(readdirSync(root).filter((n) => n.startsWith('.incoming-'))).toEqual([]);
  });
});
