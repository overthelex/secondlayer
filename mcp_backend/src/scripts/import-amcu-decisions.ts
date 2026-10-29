/**
 * Import АМКУ «Рішення та рекомендації» documents into opendata_amcu_decisions.
 *
 * Reads /data/opendata/amcu/rishennia-ta-rekomendatsii/ : zip archives of doc/docx,
 * loose doc/docx, and annual index XLSX. One row per document file.
 *   - .docx  → text extracted via mammoth
 *   - .doc   → legacy binary; metadata only (extracted=false)
 *   - .odt   → OpenDocument (zip); text extracted from content.xml
 *   - .7z    → extracted via the system `7z` binary, then doc/docx/odt processed
 *   - .xlsx  → annual list; recorded as doc_kind='list', no text
 *
 * Nested archives (a .zip/.7z/.rar *inside* another archive) are extracted
 * recursively — 7z handles .zip/.7z and, with p7zip-full, .rar. Partial
 * extraction (e.g. RAR5 entries p7zip cannot decompress) still yields metadata
 * rows for the affected documents. doc_file for a nested doc is the chain
 * `<outer>!<inner>!…!<doc>` so it stays unique.
 *
 * Requires the `7z` CLI on PATH (p7zip) for .7z/.rar archives and nested
 * archives; if absent, those are skipped.
 *
 * Usage:
 *   npx tsx src/scripts/import-amcu-decisions.ts [dir]
 *   default: /data/opendata/amcu/rishennia-ta-rekomendatsii
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import AdmZip from 'adm-zip';
import mammoth from 'mammoth';
import { fileDateOf, resolveDecisionDate } from './amcu-dates.js';

const DEFAULT_DIR = '/data/opendata/amcu/rishennia-ta-rekomendatsii';
const BATCH_SIZE = 100;

const ARCHIVE_EXT = new Set(['.zip', '.7z', '.rar']);
const DOC_EXT = new Set(['.doc', '.docx', '.odt']);

interface Stats { docxOk: number; docLegacy: number; }
type PushFn = (row: any) => Promise<void>;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  user: process.env.POSTGRES_USER || 'secondlayer',
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB || 'secondlayer_prod',
  max: 5,
});

// adm-zip decodes zip entry names as UTF-8, but legacy Ukrainian archives store
// them in DOS cp866 when the UTF-8 general-purpose flag (bit 11) is unset, so
// entryName comes out as mojibake. Re-decode the raw bytes from cp866 in that
// case — used for CLASSIFICATION ONLY; doc_file keeps the raw entryName so the
// upsert key stays stable. cp866 drops the Ukrainian і/ї/є/ґ (renders them as a
// filler char), which is why kindOf matches on the lossy stem (р.?шен) below.
const cp866 = new TextDecoder('ibm866');
function displayName(en: any): string {
  const flags = (en.header && typeof en.header.flags === 'number') ? en.header.flags : 0;
  if (flags & 0x800) return en.entryName;
  const raw: Buffer | undefined = en.rawEntryName;
  if (raw && raw.some((b: number) => b >= 0x80)) {
    try { return cp866.decode(raw); } catch { /* fall through to entryName */ }
  }
  return en.entryName;
}

function kindOf(name: string): string {
  const n = name.toLowerCase();
  // recommendations (latin translit + cyrillic)
  if (/rekomend|recomend|рекоменд/.test(n)) return 'rekomendatsii';
  // explicit index/list tokens
  if (/спис|перел|spisok|perelik/.test(n)) return 'list';
  // decisions / orders (latin translit + cyrillic). `р.?шен` tolerates the lossy
  // і in cp866-decoded «рішення» (comes out as «р_шення»).
  if (/р.?шен|розпор|rish|rise|rozpor/.test(n)) return 'rishennia';
  // bare latin "list" as a whole token only (avoid "listopad" = November)
  if (/(?:^|[_\-. (])list(?:[_\-. )]|$)/.test(n)) return 'list';
  return 'other';
}


function decisionNoOf(name: string): string | null {
  // Cyrillic form: «№ 470-р», «№728-р», «№ 561-р Витяг», «№ 552-563»
  let m = name.match(/№\s*(\d+)\s*[-–—]?\s*([а-яіїєґ]{0,3})/i);
  if (m) return m[2] ? `${m[1]}-${m[2].toLowerCase()}` : m[1];
  // Latin translit: «no-8-rk», «no_525»
  m = name.match(/no[-_ ]?(\d+[-_ ]?[a-zа-я]*)/i);
  if (m) return m[1];
  // trailing decision markers: «728-р», «6_rp», «29-rk»
  m = name.match(/(\d+)[-_](rk|rp|р[кп])/i);
  if (m) return m[1];
  return null;
}

function walkAllFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkAllFiles(p));
    else out.push(p);
  }
  return out;
}

let sevenZipAvailable: boolean | null = null;
function has7z(): boolean {
  if (sevenZipAvailable !== null) return sevenZipAvailable;
  try { execFileSync('7z', ['i'], { stdio: 'ignore' }); sevenZipAvailable = true; }
  catch { sevenZipAvailable = false; }
  return sevenZipAvailable;
}

async function extractDocx(buf: Buffer): Promise<string | null> {
  try {
    const res = await mammoth.extractRawText({ buffer: buf });
    return (res.value || '').trim() || null;
  } catch {
    return null;
  }
}

/** ODT is a zip container; readable text lives in content.xml. Strip the XML. */
async function extractOdt(buf: Buffer): Promise<string | null> {
  try {
    const entry = new AdmZip(buf).getEntry('content.xml');
    if (!entry) return null;
    const xml = entry.getData().toString('utf8');
    let stripped = xml
      .replace(/<\/text:(?:p|h)>/g, '\n')     // paragraph/heading breaks
      .replace(/<text:tab\/?>/g, '\t')
      .replace(/<text:line-break\/?>/g, '\n');
    // Drop remaining tags, looping until stable so overlapping constructs
    // (e.g. `<<a>a>`) cannot reconstitute a tag after a single pass.
    let prev: string;
    do {
      prev = stripped;
      stripped = stripped.replace(/<[^>]+>/g, '');
    } while (stripped !== prev);
    const text = stripped
      .replace(/&apos;/g, "'").replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

async function extractBody(ext: string, buf: Buffer): Promise<string | null> {
  if (ext === '.docx') return extractDocx(buf);
  if (ext === '.odt') return extractOdt(buf);
  return null; // .doc legacy binary: metadata only
}

/**
 * Recursively process an extracted directory tree: doc/docx/odt files become
 * rows; nested archives are extracted (partial extraction tolerated) and
 * recursed into. `docPrefix` is the accumulated `outer!inner!…` chain and
 * `archiveFile` is the original top-level archive name recorded on each row.
 */
async function processDir(
  rootDir: string,
  docPrefix: string,
  archiveFile: string,
  push: PushFn,
  stats: Stats,
): Promise<void> {
  for (const fp of walkAllFiles(rootDir)) {
    const rel = path.relative(rootDir, fp);
    const ext = path.extname(fp).toLowerCase();

    if (ARCHIVE_EXT.has(ext)) {
      if (!has7z()) continue;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amcunest-'));
      try {
        try {
          execFileSync('7z', ['x', '-y', '-bd', `-o${tmp}`, fp], { stdio: 'ignore' });
        } catch (e: any) {
          // Partial extraction (e.g. RAR5 methods p7zip can't decode) still
          // leaves usable files/metadata on disk; process whatever came out.
          console.warn(`   ⚠️ nested ${rel}: ${e.message}`);
        }
        await processDir(tmp, `${docPrefix}!${rel}`, archiveFile, push, stats);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    } else if (DOC_EXT.has(ext)) {
      const body = await extractBody(ext, fs.readFileSync(fp));
      const extracted = body != null;
      if (extracted) stats.docxOk++; else stats.docLegacy++;
      const df = `${docPrefix}!${rel}`;
      await push({
        archive_file: archiveFile,
        doc_file: df,
        // classify on the full chain — the top-level archive name (e.g.
        // "rishennia-117-132", "recommendations_...") is the strongest signal,
        // and docs nested deep in sub-archives lose their folder context.
        doc_kind: kindOf(df),
        // decision number lives in the leaf filename; the full path may carry
        // stray numbers from folder names (e.g. "…№724-731/…№724-р.doc").
        decision_no: decisionNoOf(path.basename(rel)),
        decision_date: resolveDecisionDate(df, body),
        body_text: body,
        extracted,
      });
    }
  }
}

async function insertBatch(rows: any[]): Promise<number> {
  if (rows.length === 0) return 0;
  const values: any[] = [];
  const placeholders: string[] = [];
  let i = 1;
  for (const r of rows) {
    const cols = [r.archive_file, r.doc_file, r.doc_kind, r.decision_no, r.decision_date, r.body_text, r.extracted];
    placeholders.push(`(${cols.map(() => `$${i++}`).join(',')})`);
    values.push(...cols);
  }
  const sql = `
    INSERT INTO opendata_amcu_decisions
      (archive_file, doc_file, doc_kind, decision_no, decision_date, body_text, extracted)
    VALUES ${placeholders.join(',')}
    ON CONFLICT (doc_file) DO UPDATE SET
      archive_file = EXCLUDED.archive_file,
      doc_kind = EXCLUDED.doc_kind,
      decision_no = EXCLUDED.decision_no,
      decision_date = EXCLUDED.decision_date,
      body_text = COALESCE(EXCLUDED.body_text, opendata_amcu_decisions.body_text),
      extracted = EXCLUDED.extracted OR opendata_amcu_decisions.extracted,
      imported_at = NOW()
  `;
  const res = await pool.query(sql, values);
  return res.rowCount || 0;
}

/**
 * Legacy .doc rows get their body_text later (scripts/amcu/04_backfill_doc_texts.py),
 * and the upsert keeps that text while overwriting decision_date with a value
 * computed WITHOUT it. Re-resolve every row from its stored text so a re-import
 * never regresses a header-derived date back to a mistyped file name (LEXAI-2118).
 */
async function redateFromStoredText(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT id, doc_file, left(body_text, 2000) AS head, decision_date::text AS decision_date
       FROM opendata_amcu_decisions WHERE doc_kind <> 'list'`,
  );
  let n = 0;
  for (const r of rows) {
    const want = resolveDecisionDate(r.doc_file, r.head);
    if (want && want !== r.decision_date) {
      await pool.query('UPDATE opendata_amcu_decisions SET decision_date = $1 WHERE id = $2', [want, r.id]);
      n++;
    }
  }
  return n;
}

async function main(): Promise<void> {
  const dir = process.argv[2] || DEFAULT_DIR;
  console.log(`📥 АМКУ decisions import from ${dir}`);
  if (!fs.existsSync(dir)) { console.error(`❌ Dir not found: ${dir}`); process.exit(1); }
  await pool.query('SELECT 1');

  const files = fs.readdirSync(dir);
  let total = 0, sevenZip = 0;
  const stats: Stats = { docxOk: 0, docLegacy: 0 };
  let batch: any[] = [];

  const push: PushFn = async (row) => {
    batch.push(row);
    if (batch.length >= BATCH_SIZE) { total += await insertBatch(batch); batch = []; }
  };

  for (const f of files) {
    const full = path.join(dir, f);
    const ext = path.extname(f).toLowerCase();

    if (ext === '.7z') {
      if (!has7z()) { sevenZip++; continue; }
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amcu7z-'));
      try {
        try {
          execFileSync('7z', ['x', '-y', '-bd', `-o${tmp}`, full], { stdio: 'ignore' });
        } catch (e: any) {
          console.warn(`   ⚠️ 7z ${f}: ${e.message}`);
        }
        await processDir(tmp, f, f, push, stats);
        sevenZip++;
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      continue;
    }

    if (ext === '.zip') {
      let entries: any[];
      try { entries = new AdmZip(full).getEntries(); } catch (e: any) { console.warn(`   ⚠️ ${f}: ${e.message}`); continue; }
      for (const en of entries) {
        if (en.isDirectory) continue;
        const en2 = en.entryName;
        const e2 = path.extname(en2).toLowerCase();

        if (ARCHIVE_EXT.has(e2)) {
          // Nested archive inside a top-level zip: dump bytes to a temp file,
          // extract with 7z and recurse (handles .zip/.7z/.rar, any depth).
          if (!has7z()) continue;
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amcuzn-'));
          try {
            const arcPath = path.join(tmp, path.basename(en2));
            fs.writeFileSync(arcPath, en.getData());
            const outDir = path.join(tmp, '_out');
            fs.mkdirSync(outDir);
            try {
              execFileSync('7z', ['x', '-y', '-bd', `-o${outDir}`, arcPath], { stdio: 'ignore' });
            } catch (e: any) {
              console.warn(`   ⚠️ nested ${f}!${en2}: ${e.message}`);
            }
            await processDir(outDir, `${f}!${en2}`, f, push, stats);
          } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
          }
          continue;
        }

        if (DOC_EXT.has(e2)) {
          const body = await extractBody(e2, en.getData());
          const extracted = body != null;
          if (extracted) stats.docxOk++; else stats.docLegacy++;
          const df = `${f}!${en2}`;
          const disp = displayName(en); // cp866-decoded name for classification (doc_file stays raw)
          await push({
            archive_file: f, doc_file: df, doc_kind: kindOf(disp),
            decision_no: decisionNoOf(path.basename(disp)), decision_date: resolveDecisionDate(df, body), body_text: body, extracted,
          });
        }
      }
      continue;
    }

    if (DOC_EXT.has(ext)) {
      const body = await extractBody(ext, fs.readFileSync(full));
      const extracted = body != null;
      if (extracted) stats.docxOk++; else stats.docLegacy++;
      await push({ archive_file: null, doc_file: f, doc_kind: kindOf(f), decision_no: decisionNoOf(f), decision_date: resolveDecisionDate(f, body), body_text: body, extracted });
      continue;
    }

    if (ext === '.xlsx' || ext === '.xls') {
      await push({ archive_file: null, doc_file: f, doc_kind: 'list', decision_no: null, decision_date: fileDateOf(f), body_text: null, extracted: false });
    }
  }
  if (batch.length) total += await insertBatch(batch);
  const redated = await redateFromStoredText();

  const zMsg = has7z() ? `${sevenZip} .7z archives extracted` : `${sevenZip} .7z archives skipped (7z binary not found)`;
  console.log(`✅ АМКУ decisions: ${total} rows (docx/odt text ${stats.docxOk}, legacy/no-text ${stats.docLegacy}); ${zMsg}; ${redated} re-dated from stored text`);
  await pool.end();
}

main().catch(err => { console.error('❌ Fatal:', err); process.exit(1); });
