/**
 * Streaming reader of ЄДР dumps of every era -> EdrSubject records (legal entities and
 * branches of foreign entities only; ФОП records are skipped).
 *
 * Formats (data.gov.ua; see docs in the PR / handoff):
 *   'subject'  <DATA><SUBJECT><RECORD/>...</SUBJECT>: current weekly UO/FSU (2026, no ADDRESS
 *              and no KVED under martial law) and the 2020-2022 full weekly dump
 *              (ZIP64, folder 17-ufop_full_DD.MM.YYYY/ with 17.1-EX_XML_EDR_UO_FULL_*.xml,
 *              ADDRESS + ACTIVITY_KINDS present). Verified on real files.
 *   'record'   <DATA><RECORD><NAME/><EDRPOU/><ADDRESS/><BOSS/><KVED/><STAN/><FOUNDERS/>: 2018-2019.
 *              EXPERIMENTAL: written from the format description, not yet run on a real dump.
 *   'row'      <ROWDATA><ROW> with Ukrainian tag (or attribute) names, 2016-2017.
 *              EXPERIMENTAL as above.
 *
 * A record element is SUBJECT, RECORD or ROW when not already inside a record (in the
 * current format RECORD is a leaf inside SUBJECT). Input: a .zip (every .xml member,
 * read with yauzl, which handles ZIP64; FOP members are skipped by name) or a plain .xml.
 * Text is decoded by the encoding the XML declaration names (windows-1251 in practice), and
 * references to control characters (&#24;) are dropped before sax sees them.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Readable, Transform, TransformCallback } from 'stream';
import iconv from 'iconv-lite';
import * as yauzl from 'yauzl';
import { forbiddenCharRefFilter } from '../../scripts/lib/xml-char-refs';
import { clean, EdrSubject, HeadSource, isOldBeneficiary, isStatement, uaDate } from './entries';

// sax ships no types; declaring the module globally would change how the scripts build types it.
interface SaxTag { name: string; attributes: Record<string, string> }
interface SaxParser {
  onopentag: (tag: SaxTag) => void;
  onclosetag: (name: string) => void;
  ontext: (text: string) => void;
  oncdata: (text: string) => void;
  onerror: (err: Error) => void;
  write(chunk: string): SaxParser;
  close(): SaxParser;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sax: { parser(strict: boolean, opt?: Record<string, unknown>): SaxParser } = require('sax');

export type DumpFormat = 'subject' | 'record' | 'row';

interface XNode { name: string; text: string; attrs: Record<string, string>; children: XNode[] }

const RECORD_TAGS: Record<string, DumpFormat> = { SUBJECT: 'subject', RECORD: 'record', ROW: 'row' };

function child(n: XNode, name: string): XNode | undefined {
  return n.children.find(c => c.name === name);
}

function txt(n: XNode, name: string): string | null {
  const c = child(n, name);
  if (c) return clean(c.text);
  return n.attrs[name] !== undefined ? clean(n.attrs[name]) : null;
}

function all(n: XNode, pathStr: string): XNode[] {
  let cur: XNode[] = [n];
  for (const p of pathStr.split('/')) cur = cur.flatMap(x => x.children.filter(c => c.name === p));
  return cur;
}

function kvedOf(n: XNode): string | null {
  const k = txt(n, 'KVED');
  if (k) return k;
  const kinds = all(n, 'ACTIVITY_KINDS/ACTIVITY_KIND');
  if (!kinds.length) return null;
  const primary = kinds.find(x => ['так', 'true', '1'].includes((txt(x, 'PRIMARY') || '').toLowerCase())) || kinds[0];
  return clean(`${txt(primary, 'CODE') || ''} ${txt(primary, 'NAME') || ''}`);
}

/** SUBJECT (2020-2026) or flat RECORD (2018-2019) -> EdrSubject; null for ФОП / no code. */
export function parseSubjectNode(n: XNode): EdrSubject | null {
  const edrpou = (txt(n, 'EDRPOU') || '').replace(/\s/g, '');
  if (!edrpou) return null;
  const kind = child(n, 'TYPE_SUBJECT') || child(n, 'TYPE_BRANCH') ? 'fsu' : 'uo';
  const founders: string[] = [];
  const beneficiaries: string[] = [];
  for (const f of all(n, 'FOUNDERS/FOUNDER')) {
    const raw = clean(f.text);
    if (!raw || isStatement(raw)) continue;
    (isOldBeneficiary(raw) ? beneficiaries : founders).push(raw);
  }
  for (const b of all(n, 'BENEFICIARIES/BENEFICIARY')) {
    const raw = clean(b.text);
    if (raw) beneficiaries.push(raw);
  }
  const heads: Array<[HeadSource, string]> = [];
  for (const s of all(n, 'SIGNERS/SIGNER')) { const r = clean(s.text); if (r) heads.push(['signer', r]); }
  for (const s of all(n, 'MEMBERS/MEMBER')) { const r = clean(s.text); if (r) heads.push(['member', r]); }
  const boss = txt(n, 'BOSS');
  if (boss) heads.push(['boss', boss]);
  return {
    kind,
    record: n.name === 'SUBJECT' ? txt(n, 'RECORD') : null,
    edrpou,
    name: txt(n, 'NAME'),
    short_name: txt(n, 'SHORT_NAME'),
    legal_form: txt(n, 'OPF'),
    status: txt(n, 'STAN'),
    address: txt(n, 'ADDRESS') || txt(n, 'LOCATION'),
    kved: kvedOf(n),
    capital: txt(n, 'AUTHORIZED_CAPITAL'),
    registered_on: uaDate(txt(n, 'REGISTRATION')),
    founders,
    beneficiaries,
    heads,
  };
}

// 2016-2017 ROW: Ukrainian names, as tags or attributes. Keys are normalised (lower case,
// '_' -> ' ', apostrophes dropped).
const ROW_MAP: Record<string, keyof EdrSubject | 'boss' | 'founder'> = {
  'найменування': 'name', 'повне найменування': 'name', 'назва': 'name',
  'скорочена назва': 'short_name', 'скорочене найменування': 'short_name',
  'код єдрпоу': 'edrpou', 'єдрпоу': 'edrpou', 'ідентифікаційний код': 'edrpou',
  'місцезнаходження': 'address', 'адреса': 'address',
  'піб керівника': 'boss', 'керівник': 'boss',
  'основний вид діяльності': 'kved', 'квед': 'kved', 'вид діяльності': 'kved',
  'стан': 'status', 'стан субєкта': 'status',
  'організаційно правова форма': 'legal_form', 'опф': 'legal_form',
  'засновник': 'founder', 'засновники': 'founder',
};

function rowKey(name: string): string {
  return name.toLowerCase().replace(/[_\-]+/g, ' ').replace(/['’ʼ]/g, '').replace(/\s+/g, ' ').trim();
}

/** 2016-2017 ROW (EXPERIMENTAL) -> EdrSubject; null without a code. */
export function parseRowNode(n: XNode): EdrSubject | null {
  const vals: Record<string, string[]> = {};
  const put = (k: string, v: string | null) => {
    const f = ROW_MAP[rowKey(k)];
    if (f && v) (vals[f] = vals[f] || []).push(v);
  };
  for (const [k, v] of Object.entries(n.attrs)) put(k, clean(v));
  for (const c of n.children) {
    if (c.children.length) for (const cc of c.children) put(c.name, clean(cc.text));
    else put(c.name, clean(c.text));
  }
  const edrpou = (vals.edrpou?.[0] || '').replace(/\s/g, '');
  if (!edrpou) return null;
  const founders: string[] = [];
  const beneficiaries: string[] = [];
  for (const raw of vals.founder || []) if (!isStatement(raw)) (isOldBeneficiary(raw) ? beneficiaries : founders).push(raw);
  return {
    kind: 'uo', record: null, edrpou,
    name: vals.name?.[0] || null, short_name: vals.short_name?.[0] || null,
    legal_form: vals.legal_form?.[0] || null, status: vals.status?.[0] || null,
    address: vals.address?.[0] || null, kved: vals.kved?.[0] || null, capital: null, registered_on: null,
    founders, beneficiaries, heads: (vals.boss || []).map(b => ['boss', b] as [HeadSource, string]),
  };
}

/**
 * Bytes -> text decoded by the encoding named in the XML declaration (looked up in the
 * first bytes; UTF-8 without a declaration or with a BOM).
 */
export function xmlDecoder(): Transform {
  let head: Buffer | null = Buffer.alloc(0);
  let decoder: { write(b: Buffer): string; end(): string | undefined } | null = null;
  const start = (buf: Buffer) => {
    const m = buf.subarray(0, 300).toString('latin1').match(/<\?xml[^>]*encoding\s*=\s*['"]([^'"]+)['"]/i);
    let enc = (m?.[1] || 'utf-8').toLowerCase();
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) enc = 'utf-8';
    if (!iconv.encodingExists(enc)) throw new Error(`Unsupported XML encoding: ${enc}`);
    decoder = iconv.getDecoder(enc) as any;
  };
  return new Transform({
    readableObjectMode: false,
    decodeStrings: true,
    encoding: 'utf8',
    transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback) {
      try {
        if (!decoder) {
          head = Buffer.concat([head!, chunk]);
          if (head.length < 300) return cb();
          start(head);
          const out = decoder!.write(head);
          head = null;
          return cb(null, out);
        }
        cb(null, decoder.write(chunk));
      } catch (e) { cb(e as Error); }
    },
    flush(cb: TransformCallback) {
      try {
        let out = '';
        if (!decoder && head && head.length) { start(head); out += decoder!.write(head); }
        if (decoder) out += (decoder as any).end() || '';
        cb(null, out);
      } catch (e) { cb(e as Error); }
    },
  });
}

export interface ReadStats {
  members: string[];
  skippedMembers: string[];
  formats: Record<DumpFormat, number>;
  noCode: number;
}

export type SubjectSink = (s: EdrSubject, fmt: DumpFormat) => void;

/**
 * Parse one XML byte stream, calling sink for every UO/FSU subject. `drain` is awaited
 * after every chunk so the caller can flush buffered rows (backpressure).
 */
export async function readXmlStream(
  bytes: Readable, sink: SubjectSink, stats: ReadStats, drain?: () => Promise<void>,
): Promise<void> {
  const parser = sax.parser(true, { trim: false, normalize: false, position: false });
  const stack: XNode[] = [];
  let fmt: DumpFormat | null = null;
  let error: Error | null = null;
  parser.onopentag = (tag) => {
    if (!stack.length) {
      const f = RECORD_TAGS[tag.name];
      if (!f) return;
      fmt = f;
    }
    const node: XNode = { name: tag.name, text: '', attrs: tag.attributes || {}, children: [] };
    if (stack.length) stack[stack.length - 1].children.push(node);
    stack.push(node);
  };
  parser.ontext = (t) => { if (stack.length) stack[stack.length - 1].text += t; };
  parser.oncdata = parser.ontext;
  parser.onclosetag = () => {
    if (!stack.length) return;
    const node = stack.pop()!;
    if (stack.length || !fmt) return;
    const s = fmt === 'row' ? parseRowNode(node) : parseSubjectNode(node);
    if (!s) { stats.noCode++; return; }
    sink(s, fmt);
    stats.formats[fmt]++;
  };
  parser.onerror = (e) => { error = e; };

  const text = bytes.pipe(xmlDecoder()).pipe(forbiddenCharRefFilter());
  for await (const chunk of text) {
    parser.write(typeof chunk === 'string' ? chunk : String(chunk));
    if (error) throw error;
    if (drain) await drain();
  }
  parser.close();
  if (error) throw error;
}

/** ФОП members are skipped: no code, private persons (17.2-EX_XML_EDR_FOP_FULL_*.xml, FOP_1.xml, ФОП_*.xml). */
export function isFopMember(name: string): boolean {
  const base = path.basename(name);
  return /(^|[_.\-\s])FOP([_.\-\s]|$)/i.test(base) || /ФОП/i.test(base);
}

function entryName(e: yauzl.Entry): string {
  if (typeof e.fileName === 'string') return e.fileName;
  // bit 11: UTF-8 names. Without it the 2017 archive still holds UTF-8 ('15-UFOP/ФОП_1.xml');
  // old Windows archivers wrote cp866, used when the bytes are not valid UTF-8.
  const utf8 = e.fileName.toString('utf8');
  if ((e.generalPurposeBitFlag & 0x800) || !utf8.includes('\uFFFD')) return utf8;
  return iconv.decode(e.fileName, 'cp866');
}

async function readZip(file: string, sink: SubjectSink, stats: ReadStats, drain?: () => Promise<void>): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, autoClose: true, decodeStrings: false }, (err, z) => (err ? reject(err) : resolve(z!))));
  await new Promise<void>((resolve, reject) => {
    let failed = false;
    const fail = (e: Error) => { if (!failed) { failed = true; zip.close(); reject(e); } };
    zip.on('error', fail);
    zip.on('end', () => { if (!failed) resolve(); });
    zip.on('entry', (entry: yauzl.Entry) => {
      const name = entryName(entry);
      if (name.endsWith('/') || !/\.xml$/i.test(name)) { zip.readEntry(); return; }
      if (isFopMember(name)) { stats.skippedMembers.push(name); zip.readEntry(); return; }
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) { fail(err || new Error(`cannot open ${name}`)); return; }
        stats.members.push(name);
        readXmlStream(stream, sink, stats, drain).then(() => zip.readEntry(), fail);
      });
    });
    zip.readEntry();
  });
}

export function newReadStats(): ReadStats {
  return { members: [], skippedMembers: [], formats: { subject: 0, record: 0, row: 0 }, noCode: 0 };
}

/** Records of a .zip (every non-ФОП .xml member) or a plain .xml file. */
export async function readDump(file: string, sink: SubjectSink, drain?: () => Promise<void>, stats = newReadStats()): Promise<ReadStats> {
  const fd = fs.openSync(file, 'r');
  const magic = Buffer.alloc(4);
  fs.readSync(fd, magic, 0, 4, 0);
  fs.closeSync(fd);
  if (magic[0] === 0x50 && magic[1] === 0x4b) {
    await readZip(file, sink, stats, drain);
  } else {
    stats.members.push(path.basename(file));
    await readXmlStream(fs.createReadStream(file, { highWaterMark: 1 << 20 }), sink, stats, drain);
  }
  return stats;
}
