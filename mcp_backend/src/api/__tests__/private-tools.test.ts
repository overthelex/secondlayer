import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import sharp from 'sharp';
import { PrivateDocsToolset, resolveInsideRoot, PathOutsideRootError, decodeText } from '../private-tools/private-docs-toolset.js';
import {
  setConfiguredToolsetsForTest, privateToolDefinitionsFor, executePrivateTool, isPrivateToolName,
} from '../private-tools/index.js';
import type { PrivateToolset } from '../private-tools/index.js';
import { CaseToolset } from '../private-tools/case-toolset.js';

let root: string;
let outside: string;
let toolset: PrivateDocsToolset;

const text = (r: any) => r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'pdocs-'));
  outside = mkdtempSync(path.join(tmpdir(), 'pdocs-out-'));
  writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
  mkdirSync(path.join(root, 'case-1'));
  await sharp({ create: { width: 40, height: 60, channels: 3, background: '#fff' } })
    .jpeg().toFile(path.join(root, 'case-1', 'IMG_1__dohovir-ipoteky.jpg'));
  writeFileSync(path.join(root, 'case-1', 'IMG_1__dohovir-ipoteky.txt'), 'Договір іпотеки УкрСиббанк кадастровий 1234567890:01:001:0326');
  writeFileSync(path.join(root, 'notes'), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xb3, 0xf2])); // "Привіт" in cp1251
  writeFileSync(path.join(root, 'claim.docx'), 'binary');
  mkdirSync(path.join(root, '.text'));
  writeFileSync(path.join(root, '.text', 'claim.docx.txt'), 'Позовна заява про скасування іпотеки');
  writeFileSync(path.join(root, 'letter.eml'), 'X'.repeat(3 * 1024 * 1024)); // over the plain-text cap
  writeFileSync(path.join(root, '.text', 'letter.eml.txt'), 'Лист з позовом, вкладення: угода');
  writeFileSync(path.join(root, 'pack.zip'), 'PK');
  writeFileSync(path.join(root, '.text', 'pack.zip.txt'), 'Архів розпаковано: ухвала слідчого судді');
  writeFileSync(path.join(root, '_rename-map.tsv'), 'old\tnew\ttitle_uk\tdoc_date\nIMG_1.jpg\tcase-1/IMG_1__dohovir-ipoteky.jpg\tДоговір іпотеки, стор. 1\t\n');
  writeFileSync(path.join(root, 'Thumbs.db'), 'x');
  writeFileSync(path.join(root, 'case-1', 'IMG_2__dohovir-ipoteky-st2.txt'), 'Сторінка друга договору');
  await sharp({ create: { width: 40, height: 60, channels: 3, background: '#fff' } })
    .jpeg().toFile(path.join(root, 'case-1', 'IMG_2__dohovir-ipoteky-st2.jpg'));
  writeFileSync(path.join(root, '_index.json'), JSON.stringify({
    version: 1,
    folders: [
      { path: '', summary: 'Корінь: позов і нотатки.', documents: [
        { id: 'D001', title: 'Позовна заява про скасування іпотеки', date: '2015-08-16', kind: 'pozov', summary: 'Позов до банку.', files: ['claim.docx'] },
      ] },
      { path: 'case-1', summary: 'Договір іпотеки з банком.', documents: [
        { id: 'D002', title: 'Договір іпотеки УкрСиббанк', date: '2007-04-05', kind: 'dohovir', summary: 'Іпотека земельної ділянки 0326.', files: ['case-1/IMG_1__dohovir-ipoteky.jpg', 'case-1/IMG_2__dohovir-ipoteky-st2.jpg'] },
      ] },
    ],
  }));
  symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  toolset = new PrivateDocsToolset('gorenichi', root, 'Тест');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  setConfiguredToolsetsForTest(null);
});

describe('resolveInsideRoot', () => {
  it('rejects traversal, absolute paths escaping and symlinks out of the folder', async () => {
    await expect(resolveInsideRoot(root, '../' + path.basename(outside) + '/secret.txt')).rejects.toBeInstanceOf(PathOutsideRootError);
    await expect(resolveInsideRoot(root, 'case-1/../../etc/passwd')).rejects.toBeInstanceOf(PathOutsideRootError);
    await expect(resolveInsideRoot(root, 'link.txt')).rejects.toBeInstanceOf(PathOutsideRootError);
    await expect(resolveInsideRoot(root, 'a\0b')).rejects.toBeInstanceOf(PathOutsideRootError);
  });

  it('treats a leading slash as relative to the folder', async () => {
    expect(await resolveInsideRoot(root, '/notes')).toMatch(/notes$/);
  });
});

describe('PrivateDocsToolset', () => {
  it('lists documents with titles, hides OCR sidecars, service files and dot dirs', async () => {
    const r = await toolset.execute('gorenichi_list_documents', {});
    const t = text(r);
    expect(t).toContain('case-1/IMG_1__dohovir-ipoteky.jpg');
    expect(t).toContain('Договір іпотеки, стор. 1');
    expect(t).not.toContain('IMG_1__dohovir-ipoteky.txt');
    expect(t).not.toContain('_rename-map.tsv');
    expect(t).not.toContain('_index.json');
    expect(t).toContain('D002');
    expect(t).not.toContain('Thumbs.db');
    expect(t).not.toContain('.text');
  });

  it('searches OCR, extracted office text and cp1251 plain files; all words must match', async () => {
    expect(text(await toolset.execute('gorenichi_search_documents', { query: 'укрсиббанк 0326' }))).toContain('IMG_1__dohovir-ipoteky.jpg');
    expect(text(await toolset.execute('gorenichi_search_documents', { query: 'позовна іпотеки' }))).toContain('claim.docx');
    expect(text(await toolset.execute('gorenichi_search_documents', { query: 'привіт' }))).toContain('notes');
    expect(text(await toolset.execute('gorenichi_search_documents', { query: 'укрсиббанк позовна' }))).toContain('нічого не знайдено');
  });

  it('reads mail and archives through their host-side text rendering', async () => {
    expect(text(await toolset.execute('gorenichi_read_document', { path: 'letter.eml' }))).toContain('Лист з позовом');
    expect(text(await toolset.execute('gorenichi_read_document', { path: 'pack.zip' }))).toContain('ухвала слідчого судді');
    expect(text(await toolset.execute('gorenichi_search_documents', { query: 'ухвала слідчого' }))).toContain('pack.zip');
  });

  it('reads an image as OCR text plus the image itself', async () => {
    const r = await toolset.execute('gorenichi_read_document', { path: 'case-1/IMG_1__dohovir-ipoteky.jpg' });
    expect(text(r)).toContain('Договір іпотеки УкрСиббанк');
    expect(r.content.some((c: any) => c.type === 'image' && c.mimeType === 'image/jpeg' && c.data.length > 0)).toBe(true);
    const noImg = await toolset.execute('gorenichi_read_document', { path: 'case-1/IMG_1__dohovir-ipoteky.jpg', include_image: false });
    expect(noImg.content.every((c: any) => c.type === 'text')).toBe(true);
  });

  it('never reads outside the folder or hidden service files', async () => {
    for (const p of ['../' + path.basename(outside) + '/secret.txt', 'link.txt', '.text/claim.docx.txt', '_rename-map.tsv']) {
      const r = await toolset.execute('gorenichi_read_document', { path: p });
      expect(r.isError).toBe(true);
      expect(text(r)).not.toContain('SECRET');
    }
  });

  it('serves a two-level catalog: folder overview, then documents of a folder', async () => {
    const overview = text(await toolset.execute('gorenichi_get_index', {}));
    expect(overview).toContain('2 документів у 2 папках');
    expect(overview).toContain('## case-1');
    expect(overview).toContain('Договір іпотеки з банком.');
    expect(overview).not.toContain('D002');
    const folder = text(await toolset.execute('gorenichi_get_index', { folder: 'case-1' }));
    expect(folder).toContain('D002 | 2007-04-05 | dohovir | 2 стор. | Договір іпотеки УкрСиббанк');
    const missing = await toolset.execute('gorenichi_get_index', { folder: 'nope' });
    expect(missing.isError).toBe(true);
  });

  it('reads a whole document by id with page markers and no images', async () => {
    const r = await toolset.execute('gorenichi_read_document', { document_id: 'd002' });
    const t = text(r);
    expect(t).toContain('Документ D002: Договір іпотеки УкрСиббанк');
    expect(t).toContain('=== стор. 1/2: case-1/IMG_1__dohovir-ipoteky.jpg ===');
    expect(t).toContain('Сторінка друга договору');
    expect(r.content.every((c: any) => c.type === 'text')).toBe(true);
    expect((await toolset.execute('gorenichi_read_document', { document_id: 'D999' })).isError).toBe(true);
    expect((await toolset.execute('gorenichi_read_document', {})).isError).toBe(true);
  });

  it('finds documents by catalog summary and tags hits with the document id', async () => {
    const t = text(await toolset.execute('gorenichi_search_documents', { query: 'земельної ділянки 0326' }));
    expect(t).toContain('[D002]');
  });

  it('hides _meta.json and rebuilds the index after invalidate()', async () => {
    mkdirSync(path.join(root, 'sprava-x', '2026-10-15-ухвала-святошинський'), { recursive: true });
    writeFileSync(path.join(root, 'sprava-x', '2026-10-15-ухвала-святошинський', '_meta.json'),
      JSON.stringify({ case_number: '369/1234/26', court: 'Святошинський районний суд м. Києва', doc_kind: 'ухвала', doc_date: '2026-10-15', parties: ['Худик'], pages: [{ file: '01.jpg', chars: 0, ocr: 'none' }] }));
    writeFileSync(path.join(root, 'sprava-x', '2026-10-15-ухвала-святошинський', '01.txt'), 'Ухвала про відкриття провадження');
    await sharp({ create: { width: 40, height: 60, channels: 3, background: '#fff' } })
      .jpeg().toFile(path.join(root, 'sprava-x', '2026-10-15-ухвала-святошинський', '01.jpg'));
    expect(text(await toolset.execute('gorenichi_list_documents', { folder: 'sprava-x' }))).not.toContain('_meta.json');
    toolset.invalidate();
    expect(text(await toolset.execute('gorenichi_search_documents', { query: 'відкриття провадження' }))).toContain('sprava-x/');
  });

  it('serves an overview from _meta.json folders when there is no _index.json', async () => {
    const metaRoot = mkdtempSync(path.join(tmpdir(), 'pdocs-meta-'));
    mkdirSync(path.join(metaRoot, '369_1234_26', '2026-10-15-ухвала-святошинський'), { recursive: true });
    writeFileSync(path.join(metaRoot, '369_1234_26', '2026-10-15-ухвала-святошинський', '_meta.json'),
      JSON.stringify({ case_number: '369/1234/26', court: 'Святошинський районний суд', doc_kind: 'ухвала', doc_date: '2026-10-15', parties: [], pages: [{ file: '01.jpg', chars: 120, ocr: 'vision' }] }));
    const t = new PrivateDocsToolset('cases', metaRoot, 'Справи');
    const out = text(await t.execute('cases_get_index', {}));
    expect(out).toContain('369_1234_26');
    expect(out).toContain('ухвала');
    expect(out).toContain('2026-10-15');
    const folder = text(await t.execute('cases_get_index', { folder: '369_1234_26' }));
    expect(folder).toContain('369_1234_26/2026-10-15-ухвала-святошинський');
    expect(folder).toContain('1 стор.');
  });

  it('decodes Windows-1251 when the bytes are not UTF-8', () => {
    expect(decodeText(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xb3, 0xf2]))).toBe('Привіт');
    expect(decodeText(Buffer.from('Привіт', 'utf8'))).toBe('Привіт');
  });
});

describe('private tool grants', () => {
  const GRANTED = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';
  const db = {
    query: async (_sql: string, params: unknown[]) =>
      ({ rows: params[0] === GRANTED ? [{ toolset: 'gorenichi' }] : [] }),
  };
  const failingDb = { query: async () => { throw new Error('relation does not exist'); } };

  beforeEach(() => setConfiguredToolsetsForTest(new Map([['gorenichi', toolset]])));

  it('advertises the tools only to the granted user', async () => {
    expect((await privateToolDefinitionsFor(db, GRANTED)).map((t) => t.name)).toEqual([
      'gorenichi_get_index', 'gorenichi_list_documents', 'gorenichi_search_documents', 'gorenichi_read_document',
    ]);
    expect(await privateToolDefinitionsFor(db, OTHER)).toEqual([]);
    expect(await privateToolDefinitionsFor(db, undefined)).toEqual([]);
  });

  it('refuses execution without a grant and fails closed when the grant table is missing', async () => {
    expect(await executePrivateTool(db, OTHER, 'gorenichi_list_documents', {})).toBeNull();
    expect(await executePrivateTool(failingDb, GRANTED, 'gorenichi_list_documents', {})).toBeNull();
    setConfiguredToolsetsForTest(new Map([['gorenichi', toolset]])); // drop the cached failed lookup
    expect(await executePrivateTool(db, GRANTED, 'gorenichi_list_documents', {})).not.toBeNull();
  });

  it('is off entirely when the deployment does not mount the folder', async () => {
    setConfiguredToolsetsForTest(new Map());
    expect(await privateToolDefinitionsFor(db, GRANTED)).toEqual([]);
    expect(await executePrivateTool(db, GRANTED, 'gorenichi_read_document', { path: 'notes' })).toBeNull();
  });

  it('advertises cases_* with the upload tool carrying openai/fileParams, only to the cases grantee', async () => {
    const casesRoot = mkdtempSync(path.join(tmpdir(), 'cases-'));
    const cases = new CaseToolset(new PrivateDocsToolset('cases', casesRoot, 'Справи'), null);
    setConfiguredToolsetsForTest(new Map<string, PrivateToolset>([['gorenichi', toolset], ['cases', cases]]));
    const casesDb = { query: async (_s: string, p: unknown[]) => ({ rows: p[0] === 'u-cases' ? [{ toolset: 'cases' }] : [] }) };
    const defs = await privateToolDefinitionsFor(casesDb, 'u-cases');
    expect(defs.map((d) => d.name).sort()).toEqual([
      'cases_complaint_norms', 'cases_find_violations', 'cases_get_index', 'cases_list_documents',
      'cases_read_document', 'cases_search_documents', 'cases_upload_pages',
    ]);
    expect(defs.find((d) => d.name === 'cases_upload_pages')!._meta).toEqual({ 'openai/fileParams': ['files'] });
    expect(await privateToolDefinitionsFor(casesDb, 'u-other')).toEqual([]);
    expect(isPrivateToolName('cases_upload_pages')).toBe(true);
    const r = await executePrivateTool(casesDb, 'u-cases', 'cases_upload_pages', { files: [] });
    expect(r?.isError).toBe(true);
    expect(text(r)).toContain('не налаштовано');
  });

  it('recognises private names by anchored prefix only', () => {
    expect(isPrivateToolName('gorenichi_read_document')).toBe(true);
    expect(isPrivateToolName('search_gorenichi_x')).toBe(false);
  });
});
