#!/usr/bin/env npx tsx
/**
 * Import Historical Legislation Editions
 *
 * Downloads all historical editions from zakon.rada.gov.ua/laws/show/{radaId}/ed{YYYYMMDD}
 * and imports them into PostgreSQL with proper version_date tracking.
 *
 * Usage:
 *   npx tsx scripts/rada/import-historical-editions.ts --code=ЦК
 *   npx tsx scripts/rada/import-historical-editions.ts --all
 *   npx tsx scripts/rada/import-historical-editions.ts --resume
 *   npx tsx scripts/rada/import-historical-editions.ts --code=ЦК --from=20100101 --to=20200101
 */

import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import pg from 'pg';
import { ARTICLE_NUMBER_PATTERN, normalizeArticleNumber } from '../../mcp_backend/src/services/act-number.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const SCRIPTS_DIR = path.resolve(__dirname);
const PROGRESS_FILE = process.env.PROGRESS_FILE || path.join(SCRIPTS_DIR, 'historical-editions-progress.json');
const BASE_URL = 'https://zakon.rada.gov.ua';
// Tunable via env. Defaults chosen to stay under Rada's throttle (sustained 2 req/s + retries tripped HTTP 429).
const RATE_LIMIT = Number(process.env.RADA_RATE_LIMIT || 1.5); // global requests per second (shared across workers)
const CONCURRENCY = Number(process.env.RADA_CONCURRENCY || 4); // parallel workers saturating the shared rate budget
const MAX_RETRIES = Number(process.env.RADA_MAX_RETRIES || 6);
const CHECKPOINT_INTERVAL = 5;

const CODES: Array<{ rada_id: string; short_title: string }> = [
  { rada_id: '254к/96-ВР', short_title: 'КУ' },
  { rada_id: '2947-14', short_title: 'СК' },
  { rada_id: '1129-15', short_title: 'КВК' },
  { rada_id: '2768-14', short_title: 'ЗК' },
  { rada_id: '322-08', short_title: 'КЗпП' },
  { rada_id: '2755-17', short_title: 'ПК' },
  { rada_id: '436-15', short_title: 'ГК' },
  { rada_id: '1798-12', short_title: 'ГПК' },
  { rada_id: '2747-15', short_title: 'КАС' },
  { rada_id: '2341-14', short_title: 'КК' },
  { rada_id: '80731-10', short_title: 'КУпАП' },
  { rada_id: '4651-17', short_title: 'КПК' },
  { rada_id: '1618-15', short_title: 'ЦПК' },
  { rada_id: '4495-17', short_title: 'МК' },
  { rada_id: '435-15', short_title: 'ЦК' },
  { rada_id: '5403-17', short_title: 'КЦЗ' },
  // Group A: substantive laws that already have current article text loaded
  // (total_articles > 0) but no historical editions yet.
  { rada_id: '1058-15', short_title: 'ПЕНС-ЗДПС' },     // Про загальнообов'язкове державне пенсійне страхування
  { rada_id: '389-19', short_title: 'ВОЄННИЙ-СТАН' },   // Про правовий режим воєнного стану
  { rada_id: '1576-12', short_title: 'ГОСП-ТОВ' },      // Про господарські товариства
  { rada_id: '2262-12', short_title: 'ПЕНС-ВІЙСЬК' },   // Про пенсійне забезпечення осіб, звільнених з військової служби
  { rada_id: '2275-19', short_title: 'ТОВ-ТДВ' },       // Про товариства з обмеженою та додатковою відповідальністю
  { rada_id: '2778-17', short_title: 'КУЛЬТУРА' },      // Про культуру
  { rada_id: '1023-12', short_title: 'ЗПС' },           // Про захист прав споживачів
  { rada_id: '2011-12', short_title: 'ЗАХ-ВІЙСЬК' },    // Про соціальний і правовий захист військовослужбовців
  // Group B (codes): base current text loaded on-demand, then editions backfilled.
  { rada_id: '2597-19', short_title: 'КЗПБ' },          // Кодекс України з процедур банкрутства
  { rada_id: '3852-12', short_title: 'ЛК' },            // Лісовий кодекс України
];

// ─── Token Bucket Rate Limiter ───────────────────────────────────────────────

class TokenBucket {
  private tokens: number;
  private waiters: Array<() => void> = [];
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(private rate: number, private maxTokens: number) {
    this.tokens = maxTokens;
    this.interval = setInterval(() => this.refill(), 1000 / rate);
  }

  private refill(): void {
    if (this.tokens < this.maxTokens) {
      this.tokens++;
    }
    if (this.waiters.length > 0 && this.tokens > 0) {
      this.tokens--;
      const resolve = this.waiters.shift()!;
      resolve();
    }
  }

  async acquire(): Promise<void> {
    if (this.tokens > 0) {
      this.tokens--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  destroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    for (const resolve of this.waiters) resolve();
    this.waiters = [];
  }
}

// ─── HTTP Client ─────────────────────────────────────────────────────────────

function createHttpClient(): AxiosInstance {
  // Optional: bind outbound sockets to a specific source IP (LOCAL_ADDRESS).
  // Used to split scraping across multiple egress IPs (each behind its own EIP)
  // so Rada's per-IP throttling is sidestepped and throughput scales ~N×.
  const localAddress = process.env.LOCAL_ADDRESS || undefined;
  const agentOpts: http.AgentOptions = { keepAlive: true, ...(localAddress ? { localAddress } : {}) };
  return axios.create({
    timeout: 60000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'uk,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate',
    },
    decompress: true,
    validateStatus: () => true,
    httpAgent: new http.Agent(agentOpts),
    httpsAgent: new https.Agent(agentOpts),
  });
}

// ─── Status-aware fetch with backoff ─────────────────────────────────────────
// httpClient uses validateStatus:()=>true, so 429/5xx come back as normal
// responses (NOT thrown). We must inspect status here and back off — honoring
// Retry-After when Rada sends it — otherwise throttling looks like a hard fail.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function fetchWithBackoff(
  httpClient: AxiosInstance,
  bucket: TokenBucket,
  url: string,
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await bucket.acquire();
    let response;
    try {
      response = await httpClient.get(url);
    } catch (err: any) {
      // network-level error (timeout/reset) — back off and retry
      if (attempt === MAX_RETRIES) throw err;
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 60000) + Math.floor(Math.random() * 1000);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    if (response.status === 200) return response.data as string;

    if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
      // Honor Retry-After (seconds or HTTP-date); else exponential backoff + jitter
      const ra = response.headers?.['retry-after'];
      let delay = Math.min(2000 * Math.pow(2, attempt - 1), 60000) + Math.floor(Math.random() * 1000);
      if (ra) {
        const raSec = Number(ra);
        if (!Number.isNaN(raSec)) delay = Math.max(delay, raSec * 1000);
        else { const t = Date.parse(ra); if (!Number.isNaN(t)) delay = Math.max(delay, t - Date.now()); }
      }
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  throw new Error(`Exhausted ${MAX_RETRIES} retries for ${url}`);
}

// ─── Progress Tracking ───────────────────────────────────────────────────────

interface CodeProgress {
  rada_id: string;
  short_title: string;
  total_editions: number;
  completed_editions: string[];
  failed_editions: string[];
}

interface OverallProgress {
  codes: CodeProgress[];
  started_at: string;
  last_updated: string;
}

function loadProgress(): OverallProgress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return { codes: [], started_at: new Date().toISOString(), last_updated: new Date().toISOString() };
}

function saveProgress(progress: OverallProgress): void {
  progress.last_updated = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function getCodeProgress(progress: OverallProgress, radaId: string, shortTitle: string): CodeProgress {
  let cp = progress.codes.find(c => c.rada_id === radaId);
  if (!cp) {
    cp = { rada_id: radaId, short_title: shortTitle, total_editions: 0, completed_editions: [], failed_editions: [] };
    progress.codes.push(cp);
  }
  return cp;
}

// ─── Article Parser ──────────────────────────────────────────────────────────

function extractArticlesFromEditionHtml(html: string): Array<{ article_number: string; title?: string; full_text: string; byte_size: number }> {
  const articles: Array<{ article_number: string; title?: string; full_text: string; byte_size: number }> = [];
  const seen = new Set<string>();

  // Try <pre><b> format first (historical editions)
// The index is separated by a hyphen that Rada often surrounds with spaces and
// sometimes writes as an en/em dash: the stored ЦПК heading is «Стаття 350 - 1 .».
// The old pattern allowed neither, so it captured «350», collided with the real
// article 350 and was dropped by ON CONFLICT DO NOTHING — which is why every ЦПК
// edition from 2004 to 2028 held exactly 500 articles and not one with an index,
// against 525 in npa.article. 1 018 in-force indexed articles had no row at all
// (LEXAI-1957). normalizeArticleNumber folds the dashes and strips the spaces so
// the stored value matches npa.article.art_no character for character.
  const preBoldRegex = new RegExp(
    `<b>Стаття\\s+(${ARTICLE_NUMBER_PATTERN})\\.?</b>\\s*([\\s\\S]*?)(?=<b>Стаття\\s+\\d|</pre>\\s*$|$)`, 'g');
  let match;
  while ((match = preBoldRegex.exec(html)) !== null) {
    const artNum = normalizeArticleNumber(match[1]);
    if (seen.has(artNum)) continue;
    seen.add(artNum);

    let body = match[2];
    body = body.replace(/<br\s*\/?>/gi, '\n');
    body = body.replace(/<b>([^<]*)<\/b>/g, '$1');
    body = body.replace(/<[^>]+>/g, ' ');
    body = body.replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/&amp;/g, '&');
    body = body.replace(/\{[^}]*\}/g, '');
    body = body.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
    if (body.length < 5) continue;

    const firstLine = body.split('\n')[0].trim();
    articles.push({
      article_number: artNum,
      title: firstLine.length < 200 ? firstLine : undefined,
      full_text: body,
      byte_size: Buffer.byteLength(body, 'utf8'),
    });
  }

  if (articles.length >= 3) return articles;

  // Fallback: <span class=rvts9> format (current /print pages)
  seen.clear();
  articles.length = 0;
  const rvtsRegex = new RegExp(
    `<span\\s+class=["']?rvts9["']?>\\s*Стаття\\s+(${ARTICLE_NUMBER_PATTERN})\\.?\\s*([^<]*)</span>\\s*([\\s\\S]*?)(?=<span\\s+class=["']?rvts9["']?>\\s*Стаття\\s+\\d|$)`, 'g');
  while ((match = rvtsRegex.exec(html)) !== null) {
    const artNum = normalizeArticleNumber(match[1]);
    if (seen.has(artNum)) continue;
    seen.add(artNum);

    const inlineTitle = match[2]?.trim();
    let body = match[3];
    const $body = cheerio.load(body);
    $body('script, style').remove();
    body = $body.text().replace(/\s+/g, ' ').replace(/\{[^}]*\}/g, '').trim();
    if (body.length < 10) continue;

    articles.push({
      article_number: artNum,
      title: inlineTitle && inlineTitle.length > 2 ? inlineTitle : undefined,
      full_text: body,
      byte_size: Buffer.byteLength(body, 'utf8'),
    });
  }

  // Last fallback: plain text Стаття N. pattern
  if (articles.length < 3) {
    seen.clear();
    articles.length = 0;
    const plainRegex = new RegExp(
      `Стаття\\s+(${ARTICLE_NUMBER_PATTERN})\\.\\s*([^\\n]{3,200})`, 'g');
    while ((match = plainRegex.exec(html)) !== null) {
      const artNum = normalizeArticleNumber(match[1]);
      if (!seen.has(artNum)) {
        seen.add(artNum);
        articles.push({
          article_number: artNum,
          title: match[2].trim(),
          full_text: match[2].trim(),
          byte_size: Buffer.byteLength(match[2], 'utf8'),
        });
      }
    }
  }

  // Statute fallback: military statutes (Статут внутрішньої служби, Стройовий,
  // Гарнізонної служби, Дисциплінарний — 548..551) are NOT structured with
  // "Стаття N" headers. Their articles are continuously-numbered points ("9.",
  // "10.", ...) grouped under "Розділ" headings; the only "Стаття" tokens are
  // {amendment notes} in curly braces, which we strip. Extract the numbered
  // points as articles.
  if (articles.length < 3) {
    seen.clear();
    articles.length = 0;
    const text = html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/&amp;/g, '&')
      .replace(/\{[^}]*\}/g, ' ')          // drop amendment annotations
      .replace(/[ \t]+/g, ' ');
    // A point starts at a line boundary: "N. " followed by a capital letter or «.
    // Body runs until the next such point, a Розділ/Глава heading, or end.
    const pointRegex = /(?:^|\n)\s*(\d{1,3})\.\s+([А-ЯІЇЄҐ«][\s\S]*?)(?=\n\s*\d{1,3}\.\s+[А-ЯІЇЄҐ«]|\n\s*(?:Розділ|РОЗДІЛ|Глава|ГЛАВА)\s|$)/g;
    let pm: RegExpExecArray | null;
    while ((pm = pointRegex.exec(text)) !== null) {
      const num = pm[1];
      if (seen.has(num)) continue;
      const body = pm[2].replace(/\n\s*\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
      if (body.length < 15) continue;
      seen.add(num);
      articles.push({
        article_number: num,
        title: undefined,
        full_text: body,
        byte_size: Buffer.byteLength(body, 'utf8'),
      });
    }
    // Guard against spurious matches: require a real run of points.
    if (articles.length < 5) articles.length = 0;
  }

  return articles;
}

// ─── Edition Discovery ───────────────────────────────────────────────────────

async function fetchEditionDates(httpClient: AxiosInstance, bucket: TokenBucket, radaId: string): Promise<string[]> {
  const url = `${BASE_URL}/laws/show/${radaId}/card4`;
  console.log(`  Fetching edition dates from ${url}`);
  const html = await fetchWithBackoff(httpClient, bucket, url);
  // Match /ed{YYYYMMDD} links — rada_id may appear URL-encoded in HTML
  const edRegex = /\/ed(\d{8})/g;
  const dates = new Set<string>();
  let match;
  while ((match = edRegex.exec(html)) !== null) dates.add(match[1]);

  // Fallback: some codices (e.g. КУпАП 80731-10) list editions in the card4
  // history table with empty \"Текст редакції\" cells, so there are no /ed
  // links. Each edition row has <span class=\"dat1\">DD.MM.YYYY</span> and the
  // event cell text contains \"Редакція\". Parse those dates and build ed-keys
  // (the text exists at /ed{YYYYMMDD}/print even without a card4 hyperlink).
  if (dates.size === 0) {
    const rowRegex = /<span class=\"dat1\">(\d{2})\.(\d{2})\.(\d{4})<\/span>([\s\S]*?)(?=<span class=\"dat1\">|<\/tbody>|$)/g;
    let row;
    while ((row = rowRegex.exec(html)) !== null) {
      const [, dd, mm, yyyy, rest] = row;
      if (/редакц/i.test(rest)) dates.add(`${yyyy}${mm}${dd}`);
    }
    if (dates.size > 0) console.log(`  (fallback) parsed ${dates.size} edition dates from card4 history table`);
  }

  // Drop implausible / sentinel dates: Rada uses year 3000 (ed3000XXXX) for
  // editions with no fixed effective date; real editions fall within 1900-2099.
  const plausible = [...dates].filter((k) => {
    const y = Number(k.slice(0, 4));
    return y >= 1900 && y <= 2099;
  });
  return plausible.sort();
}

// ─── Import One Edition ──────────────────────────────────────────────────────

async function importEdition(
  httpClient: AxiosInstance,
  bucket: TokenBucket,
  pool: pg.Pool,
  legislationId: number,
  radaId: string,
  editionDate: string,
): Promise<number> {
  const url = `${BASE_URL}/laws/show/${radaId}/ed${editionDate}/print`;
  const html = await fetchWithBackoff(httpClient, bucket, url);
  const articles = extractArticlesFromEditionHtml(html);
  if (articles.length === 0) return 0;

  const versionDate = `${editionDate.substring(0, 4)}-${editionDate.substring(4, 6)}-${editionDate.substring(6, 8)}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const art of articles) {
      const titleEsc = art.title || null;
      await client.query(
        `INSERT INTO legislation_articles (legislation_id, article_number, title, full_text, byte_size, is_current, version_date, metadata)
         VALUES ($1, $2, $3, $4, $5, false, $6, $7)
         ON CONFLICT (legislation_id, article_number, version_date) DO NOTHING`,
        [legislationId, art.article_number, titleEsc, art.full_text, art.byte_size, versionDate,
         JSON.stringify({ edition_date: editionDate, extraction_method: 'edition_pre_bold' })],
      );
    }

    // Record edition in legislation_editions
    await client.query(
      `INSERT INTO legislation_editions (legislation_id, edition_date, edition_key, article_count)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (legislation_id, edition_date) DO NOTHING`,
      [legislationId, versionDate, editionDate, articles.length],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return articles.length;
}

// ─── Reconcile current redaction ─────────────────────────────────────────────
// After importing editions for a code, flag exactly the current redaction
// (latest edition effective on/before today; future-dated editions are ignored)
// as is_current=true and demote all others. Keeps is_current-filtered consumers
// (citation resolution, LegislationService, get_legislation_section) working.
// Idempotent: safe to re-run.
async function reconcileCurrentEdition(pool: pg.Pool, legislationId: number): Promise<void> {
  const chosen = await pool.query(
    `SELECT version_date
       FROM legislation_articles
      WHERE legislation_id = $1
      ORDER BY (version_date::date <= CURRENT_DATE) DESC, version_date DESC
      LIMIT 1`,
    [legislationId],
  );
  if (chosen.rows.length === 0) return;
  const currentVersion: Date = chosen.rows[0].version_date;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Demote any rows wrongly flagged on other editions.
    await client.query(
      `UPDATE legislation_articles
          SET is_current = false
        WHERE legislation_id = $1 AND is_current = true AND version_date <> $2`,
      [legislationId, currentVersion],
    );
    // Promote the chosen current redaction.
    const res = await client.query(
      `UPDATE legislation_articles
          SET is_current = true, updated_at = NOW()
        WHERE legislation_id = $1 AND version_date = $2 AND is_current = false`,
      [legislationId, currentVersion],
    );
    await client.query('COMMIT');
    const d = new Date(currentVersion).toISOString().slice(0, 10);
    console.log(`  Flagged current redaction ${d}: ${res.rowCount} articles is_current=true`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const codeArg = args.find(a => a.startsWith('--code='))?.split('=')[1];
  const codesArg = args.find(a => a.startsWith('--codes='))?.split('=')[1];
  const codesList = codesArg ? codesArg.split(',').map(s => s.trim()).filter(Boolean) : null;
  const idsFileArg = args.find(a => a.startsWith('--ids-file='))?.split('=')[1];
  const allArg = args.includes('--all');
  const resumeArg = args.includes('--resume');
  const fromArg = args.find(a => a.startsWith('--from='))?.split('=')[1];
  const toArg = args.find(a => a.startsWith('--to='))?.split('=')[1];
  const dryRun = args.includes('--dry-run');

  // --ids-file: import editions for arbitrary acts by rada_id (one per line),
  // independent of the hardcoded CODES list. short_title defaults to the rada_id.
  const idsFromFile: Array<{ rada_id: string; short_title: string }> | null = idsFileArg
    ? fs.readFileSync(idsFileArg, 'utf-8')
        .split('\n').map(s => s.trim()).filter(Boolean)
        .map(rada_id => ({ rada_id, short_title: rada_id }))
    : null;

  if (!codeArg && !codesList && !allArg && !resumeArg && !idsFromFile) {
    console.log('Usage:');
    console.log('  --code=ЦК              Import one code');
    console.log('  --codes=ПК,КК,ЗК       Import a specific subset (disjoint split across machines)');
    console.log('  --ids-file=PATH         Import editions for rada_ids listed in a file (one per line)');
    console.log('  --all                   Import all 16 codes');
    console.log('  --resume                Resume from checkpoint');
    console.log('  --from=YYYYMMDD         Start from this edition date');
    console.log('  --to=YYYYMMDD           Stop at this edition date');
    console.log('  --dry-run               Discover editions but do not import');
    process.exit(0);
  }

  const dbUrl = process.env.DATABASE_URL || 'postgresql://secondlayer:secondlayer@localhost:5432/secondlayer_prod';
  const pool = new pg.Pool({ connectionString: dbUrl, max: Math.max(CONCURRENCY + 2, 5) });

  // Ensure migration tables exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS legislation_editions (
      id SERIAL PRIMARY KEY,
      legislation_id INTEGER NOT NULL REFERENCES legislation(id) ON DELETE CASCADE,
      edition_date DATE NOT NULL,
      edition_key VARCHAR(8) NOT NULL,
      article_count INTEGER DEFAULT 0,
      imported_at TIMESTAMPTZ DEFAULT NOW(),
      metadata JSONB DEFAULT '{}',
      UNIQUE(legislation_id, edition_date)
    )
  `);

  const httpClient = createHttpClient();
  const bucket = new TokenBucket(RATE_LIMIT, RATE_LIMIT);
  const progress = loadProgress();

  let codesToProcess: typeof CODES;
  if (idsFromFile) {
    codesToProcess = idsFromFile;
  } else if (codeArg) {
    const found = CODES.find(c => c.short_title === codeArg || c.rada_id === codeArg);
    if (!found) {
      console.error(`Unknown code: ${codeArg}. Available: ${CODES.map(c => c.short_title).join(', ')}`);
      process.exit(1);
    }
    codesToProcess = [found];
  } else if (codesList) {
    codesToProcess = codesList.map(token => {
      const found = CODES.find(c => c.short_title === token || c.rada_id === token);
      if (!found) {
        console.error(`Unknown code: ${token}. Available: ${CODES.map(c => c.short_title).join(', ')}`);
        process.exit(1);
      }
      return found;
    });
  } else {
    codesToProcess = CODES;
  }

  let totalEditionsImported = 0;
  let totalArticlesImported = 0;

  for (const code of codesToProcess) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Processing: ${code.short_title} (${code.rada_id})`);
    console.log('='.repeat(60));

    // Get legislation_id from DB
    const legResult = await pool.query('SELECT id FROM legislation WHERE rada_id = $1', [code.rada_id]);
    if (legResult.rows.length === 0) {
      console.error(`  Legislation ${code.rada_id} not found in DB, skipping`);
      continue;
    }
    const legislationId = legResult.rows[0].id;

    // Discover edition dates
    let editionDates: string[];
    try {
      editionDates = await fetchEditionDates(httpClient, bucket, code.rada_id);
    } catch (err: any) {
      console.error(`  Failed to fetch edition dates: ${err.message}`);
      continue;
    }
    console.log(`  Found ${editionDates.length} editions`);

    // Apply date filters
    if (fromArg) editionDates = editionDates.filter(d => d >= fromArg);
    if (toArg) editionDates = editionDates.filter(d => d <= toArg);

    // Filter already-imported editions
    const cp = getCodeProgress(progress, code.rada_id, code.short_title);
    cp.total_editions = editionDates.length;

    const alreadyImported = new Set(cp.completed_editions);
    // Also check DB for editions imported in previous runs
    const dbEditions = await pool.query(
      'SELECT edition_key FROM legislation_editions WHERE legislation_id = $1',
      [legislationId],
    );
    for (const row of dbEditions.rows) alreadyImported.add(row.edition_key);

    const toImport = editionDates.filter(d => !alreadyImported.has(d));
    console.log(`  To import: ${toImport.length} editions (${alreadyImported.size} already done)`);

    if (dryRun) {
      console.log(`  [DRY RUN] Would import: ${toImport.join(', ')}`);
      continue;
    }

    // Worker pool: CONCURRENCY workers share the single global rate bucket,
    // so they saturate the safe req/s budget without exceeding it.
    let progressCount = 0;
    const runPool = async (items: string[], label: string): Promise<string[]> => {
      const failed: string[] = [];
      let idx = 0;
      const worker = async () => {
        for (;;) {
          const i = idx++;
          if (i >= items.length) break;
          const edDate = items[i];
          try {
            const artCount = await importEdition(httpClient, bucket, pool, legislationId, code.rada_id, edDate);
            cp.completed_editions.push(edDate);
            totalEditionsImported++;
            totalArticlesImported += artCount;
            progressCount++;
            if (progressCount % CHECKPOINT_INTERVAL === 0) {
              saveProgress(progress);
              const pct = ((alreadyImported.size + progressCount) / editionDates.length * 100).toFixed(1);
              console.log(`  [${progressCount}/${toImport.length}] ${label} ed${edDate}: ${artCount} articles (${pct}% of ${code.short_title})`);
            }
          } catch (err: any) {
            console.error(`  FAILED ${label} ed${edDate}: ${err.message}`);
            failed.push(edDate);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(CONCURRENCY, items.length)) }, () => worker()));
      return failed;
    };

    let failed = await runPool(toImport, 'main');
    if (failed.length > 0) {
      console.log(`  Retrying ${failed.length} failed editions for ${code.short_title}...`);
      failed = await runPool(failed, 'retry');
    }
    for (const f of failed) cp.failed_editions.push(f);
    const editionsDone = toImport.length - failed.length;

    // Update total_editions on legislation table
    await pool.query(
      `UPDATE legislation SET total_editions = (
        SELECT COUNT(*) FROM legislation_editions WHERE legislation_id = $1
      ) WHERE id = $1`,
      [legislationId],
    );

    // Flag the current redaction so is_current-filtered consumers
    // (citation resolution, LegislationService, get_legislation_section) work.
    // This importer inserts every edition with is_current=false; without this
    // step a code imported ONLY here would have zero current articles (LEXAI-1770).
    await reconcileCurrentEdition(pool, legislationId);

    saveProgress(progress);
    console.log(`  Done: ${editionsDone} editions imported for ${code.short_title}`);
  }

  bucket.destroy();
  await pool.end();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`COMPLETE: ${totalEditionsImported} editions, ${totalArticlesImported} articles imported`);
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
