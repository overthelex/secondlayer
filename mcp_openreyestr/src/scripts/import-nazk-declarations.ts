/**
 * NAZK Declarations Import
 *
 * Two passes against public-api.nazk.gov.ua/v2:
 *
 * 1. List crawl (default): /documents/list by declaration_year × declaration_type.
 *    API limits: 100 results/page, max 100 pages = 10,000 per query. The list carries only
 *    step_0/step_1, so it fills name, position, workplace, post type/category, submission
 *    date and corruption_affected; property/income flags keep their value (NULL if unknown).
 * 2. Details (--details): /documents/{id} for rows already in the table. The full document
 *    has every section, so it fills has_real_estate / has_vehicles / has_securities /
 *    has_corporate_rights / has_income and total_income_declared.
 *
 * Both passes are UPSERT only (no DELETE/TRUNCATE) and resume from a checkpoint file.
 *
 * Usage:
 *   node dist/scripts/import-nazk-declarations.js                        # list crawl, all years
 *   node dist/scripts/import-nazk-declarations.js --year=2020-2024 --types=1,2
 *   node dist/scripts/import-nazk-declarations.js --year=2024 --types=1 --max-pages=1   # 100 docs
 *   node dist/scripts/import-nazk-declarations.js --resume               # continue from checkpoint
 *   node dist/scripts/import-nazk-declarations.js --details              # rows with has_income IS NULL
 *   node dist/scripts/import-nazk-declarations.js --details --all        # every row
 *   node dist/scripts/import-nazk-declarations.js --details --limit=100 --name=Железняк
 *
 * Env: NAZK_DELAY_MS (default 300) pause after each request per worker; NAZK_CONCURRENCY
 *      (default 2) parallel requests in --details; NAZK_CHECKPOINT checkpoint file path.
 */
import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import { Pool, PoolClient } from 'pg';
import https from 'https';

const API_ROOT = 'https://public-api.nazk.gov.ua/v2/documents';
const CURRENT_YEAR = new Date().getFullYear();
const DECLARATION_TYPES = [1, 2, 3, 4]; // annual, before dismissal, after dismissal, candidate
const TYPE_NAMES: Record<number, string> = {
  1: 'щорічна', 2: 'перед звільненням', 3: 'після звільнення', 4: 'кандидат'
};
const REQUEST_DELAY_MS = parseInt(process.env.NAZK_DELAY_MS || '300');
const CONCURRENCY = Math.max(1, parseInt(process.env.NAZK_CONCURRENCY || '2'));
const MAX_PAGES = 100;
const MAX_RETRIES = 6;

interface CliArgs {
  yearStart: number;
  yearEnd: number;
  types: number[];
  maxPages: number;
  resume: boolean;
  details: boolean;
  all: boolean;
  limit: number | null;
  name: string | null;
  checkpoint: string;
}

function parseArgs(): CliArgs {
  const args: CliArgs = {
    yearStart: 2015, yearEnd: CURRENT_YEAR, types: DECLARATION_TYPES, maxPages: MAX_PAGES,
    resume: false, details: false, all: false, limit: null, name: null, checkpoint: '',
  };

  for (const arg of process.argv.slice(2)) {
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const val = eq === -1 ? '' : arg.slice(eq + 1);
    if (key === '--year') {
      if (val.includes('-')) {
        const [s, e] = val.split('-').map(Number);
        args.yearStart = s;
        args.yearEnd = e;
      } else {
        args.yearStart = args.yearEnd = parseInt(val);
      }
    } else if (key === '--types') {
      args.types = val.split(',').map(Number).filter(t => DECLARATION_TYPES.includes(t));
    } else if (key === '--max-pages') {
      args.maxPages = Math.min(MAX_PAGES, parseInt(val));
    } else if (key === '--resume') {
      args.resume = true;
    } else if (key === '--details') {
      args.details = true;
    } else if (key === '--all') {
      args.all = true;
    } else if (key === '--limit') {
      args.limit = parseInt(val);
    } else if (key === '--name') {
      args.name = val;
    } else if (key === '--checkpoint') {
      args.checkpoint = val;
    }
  }
  if (!args.checkpoint) {
    args.checkpoint = process.env.NAZK_CHECKPOINT
      || (args.details ? 'nazk-details.checkpoint.json' : 'nazk-list.checkpoint.json');
  }
  return args;
}

class HttpError extends Error {
  constructor(public status: number, message: string, public retryAfter = 0) { super(message); }
}

function getJsonOnce(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const retryAfter = parseInt(String(res.headers['retry-after'] || '')) || 0;
          return reject(new HttpError(res.statusCode || 0, `HTTP ${res.statusCode}: ${data.substring(0, 120)}`, retryAfter));
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`JSON parse error: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/** GET with retries: 429 honours Retry-After, 5xx/network errors back off; 404 → null. */
async function getJson(url: string): Promise<any | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await getJsonOnce(url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 0;
      if (status === 404) return null;
      if (attempt >= MAX_RETRIES || (status >= 400 && status < 500 && status !== 429)) throw err;
      const wait = status === 429
        ? Math.max(5, (err as HttpError).retryAfter) * 1000 * attempt
        : REQUEST_DELAY_MS * 5 * 2 ** (attempt - 1);
      console.log(`\n  ${(err as Error).message.substring(0, 80)}; retry ${attempt} in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readCheckpoint<T>(path: string, fallback: T): T {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(path, 'utf8')) };
  } catch {
    return fallback;
  }
}

function writeCheckpoint(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, path);
}

/** Submission time from the API's `date`: an ISO string, or unix seconds in older payloads. */
export function parseNazkDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const asNumber = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : NaN;
  const d = Number.isFinite(asNumber) ? new Date(asNumber * 1000) : new Date(String(value));
  // Declarations exist from 2015; anything earlier is a parse error, not a date.
  if (isNaN(d.getTime()) || d.getUTCFullYear() < 2015) return null;
  return d.toISOString();
}

/**
 * NAZK sends post_type / post_category twice: as a numeric code on the document and as a
 * label in step_1. The label is authoritative; the code is a fallback. Pairs observed on
 * /v2/documents/list, 24.10.2026 (2016/2020/2024 annual and pre-dismissal pages).
 */
export const NAZK_POST_TYPE_LABELS: Record<string, string> = {
  '2': 'Посада державної служби',
  '3': 'Посада в органах місцевого самоврядування',
  '4': 'Посадова особа юридичної особи публічного права',
};
export const NAZK_POST_CATEGORY_LABELS: Record<string, string> = {
  '1': 'перша категорія', '2': 'друга категорія', '3': 'третя категорія',
  '4': 'четверта категорія', '5': "п'ята категорія", '6': 'шоста категорія',
  '7': 'сьома категорія', '8': 'А', '9': 'Б', '10': 'В',
};
const NOT_APPLICABLE = '[Не застосовується]';

/** step_1 label if it says something, else the document code mapped to a label, else the raw code. */
export function resolveNazkPostLabel(label: unknown, code: unknown, labels: Record<string, string>): string {
  const text = typeof label === 'string' ? label.trim() : '';
  if (text && text !== NOT_APPLICABLE) return text;
  const key = code === null || code === undefined ? '' : String(code).trim();
  if (key && key !== '0') return labels[key] || key;
  return text;
}

/** "12 345,67" / "12345.67" / 12345 → number; "[Не відомо]" and friends → null. */
export function parseNazkAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\s\u00a0]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return parseFloat(cleaned);
}

/**
 * corruption_affected is 1 (yes) / 2 (no) on the document; schema-1/2 declarations send 0 and
 * put the answer in step_1 as "Так"/"Ні" or as the name of the post category (= yes).
 * It used to be compared with `true`, so all 322 934 rows said "no".
 */
export function isCorruptionAffected(code: unknown, label: unknown): boolean {
  if (code === 1 || code === '1' || code === true) return true;
  if (code === 2 || code === '2') return false;
  const text = typeof label === 'string' ? label.trim() : '';
  if (!text || text === 'Ні' || text === '0' || text === NOT_APPLICABLE) return false;
  return true;
}

export function extractDeclarantInfo(doc: any): {
  name: string; position: string; workplace: string; region: string;
  postType: string; postCategory: string; corruptionAffected: boolean;
  hasRealEstate: boolean | null; hasVehicles: boolean | null; hasSecurities: boolean | null;
  hasCorporateRights: boolean | null; hasIncome: boolean | null; totalIncome: number | null;
} {
  const data = doc.data || {};

  // Step 1 (section 2.1): declarant info
  const step1 = data.step_1?.data || {};
  const name = [step1.lastname, step1.firstname, step1.middlename].filter(Boolean).join(' ').trim()
    || doc.user_declarant_full_name || '';
  // The position is step_1.workPost in every schema version (1-5); step_1.post.post never
  // existed, so 309 040 of 322 934 rows had an empty position.
  const position = String(step1.workPost || step1.post?.post || '').trim();
  const workplace = step1.workPlace || step1.post?.office || '';
  const region = step1.actual_region || step1.region || '';
  const postType = resolveNazkPostLabel(step1.postType, doc.post_type, NAZK_POST_TYPE_LABELS);
  const postCategory = resolveNazkPostLabel(step1.postCategory, doc.post_category, NAZK_POST_CATEGORY_LABELS);
  const corruptionAffected = isCorruptionAffected(doc.corruption_affected, step1.corruptionAffected);

  // Sections 3-11 are absent from the /documents/list response (it carries only step_0 and
  // step_1): absent = unknown (NULL). The full document (/documents/{id}) has every step as
  // { data: [...], isNotApplicable: 0|1 }; isNotApplicable = 1 or an empty list = "has none".
  const section = (step: string): any[] | Record<string, any> | null => {
    const s = data[step];
    if (!s || typeof s !== 'object') return null;
    if (s.isNotApplicable === 1 || s.isNotApplicable === '1') return [];
    return s.data || [];
  };
  const entries = (sec: any[] | Record<string, any> | null): any[] =>
    sec === null ? [] : Array.isArray(sec) ? sec : Object.values(sec);
  const present = (sec: any[] | Record<string, any> | null): boolean | null =>
    sec === null ? null : entries(sec).length > 0;

  const hasRealEstate = present(section('step_3'));
  const hasVehicles = present(section('step_6'));
  const hasSecurities = present(section('step_7'));
  const hasCorporateRights = present(section('step_8'));

  // Step 11: income of the declarant and family members, summed over every entry.
  const step11 = section('step_11');
  const hasIncome = present(step11);
  let totalIncome: number | null = null;
  if (hasIncome === false) totalIncome = 0;
  if (hasIncome) {
    let sum = 0;
    let any = false;
    for (const entry of entries(step11)) {
      const amount = parseNazkAmount(entry?.sizeIncome ?? entry?.size);
      if (amount !== null) { sum += amount; any = true; }
    }
    if (any) totalIncome = Math.round(sum * 100) / 100;
  }

  return {
    name, position, workplace, region, postType, postCategory, corruptionAffected,
    hasRealEstate, hasVehicles, hasSecurities, hasCorporateRights, hasIncome, totalIncome
  };
}

/** UPSERT one declaration from the list or the full document. Unknown values never overwrite known ones. */
async function upsertDeclaration(
  client: PoolClient, doc: any, fallbackType: number | null, fallbackYear: number | null,
): Promise<'insert' | 'update' | null> {
  const declId = doc.id || doc.declaration_id;
  if (!declId) return null;
  const info = extractDeclarantInfo(doc);
  // The API sends an ISO string ("2026-10-23T21:43:05+03:00"). parseInt read its year
  // as unix seconds, so every submission_date was 1970-01-01 00:33.
  const submissionDate = parseNazkDate(doc.date);

  const result = await client.query(
    `INSERT INTO nazk_declarations (
      declaration_id, declarant_id, declaration_type, declaration_year,
      declarant_name, declarant_position, declarant_workplace, declarant_region,
      post_type, post_category, corruption_affected, submission_date,
      has_real_estate, has_vehicles, has_securities, has_corporate_rights,
      has_income, total_income_declared
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    ON CONFLICT (declaration_id) DO UPDATE SET
      declarant_id = COALESCE(EXCLUDED.declarant_id, nazk_declarations.declarant_id),
      declarant_name = COALESCE(NULLIF(EXCLUDED.declarant_name, ''), nazk_declarations.declarant_name),
      declarant_position = COALESCE(NULLIF(EXCLUDED.declarant_position, ''), nazk_declarations.declarant_position),
      declarant_workplace = COALESCE(NULLIF(EXCLUDED.declarant_workplace, ''), nazk_declarations.declarant_workplace),
      declarant_region = COALESCE(NULLIF(EXCLUDED.declarant_region, ''), nazk_declarations.declarant_region),
      post_type = COALESCE(NULLIF(EXCLUDED.post_type, ''), nazk_declarations.post_type),
      post_category = COALESCE(NULLIF(EXCLUDED.post_category, ''), nazk_declarations.post_category),
      corruption_affected = EXCLUDED.corruption_affected,
      submission_date = COALESCE(EXCLUDED.submission_date, nazk_declarations.submission_date),
      has_real_estate = COALESCE(EXCLUDED.has_real_estate, nazk_declarations.has_real_estate),
      has_vehicles = COALESCE(EXCLUDED.has_vehicles, nazk_declarations.has_vehicles),
      has_securities = COALESCE(EXCLUDED.has_securities, nazk_declarations.has_securities),
      has_corporate_rights = COALESCE(EXCLUDED.has_corporate_rights, nazk_declarations.has_corporate_rights),
      has_income = COALESCE(EXCLUDED.has_income, nazk_declarations.has_income),
      total_income_declared = COALESCE(EXCLUDED.total_income_declared, nazk_declarations.total_income_declared),
      updated_at = CURRENT_TIMESTAMP
    RETURNING (xmax = 0) AS is_insert`,
    [
      String(declId),
      doc.user_declarant_id || null,
      Number(doc.declaration_type) || fallbackType,
      Number(doc.declaration_year) || fallbackYear,
      info.name,
      info.position,
      info.workplace,
      info.region,
      info.postType,
      info.postCategory,
      info.corruptionAffected,
      submissionDate,
      info.hasRealEstate,
      info.hasVehicles,
      info.hasSecurities,
      info.hasCorporateRights,
      info.hasIncome,
      info.totalIncome
    ]
  );
  return result.rows[0]?.is_insert ? 'insert' : 'update';
}

interface ListCheckpoint { done: string[]; current: string | null; page: number }

async function importList(pool: Pool, args: CliArgs) {
  const cp: ListCheckpoint = args.resume
    ? readCheckpoint<ListCheckpoint>(args.checkpoint, { done: [], current: null, page: 1 })
    : { done: [], current: null, page: 1 };
  const done = new Set(cp.done);
  if (args.resume) console.log(`Resume from ${args.checkpoint}: ${done.size} combos done, current ${cp.current} page ${cp.page}`);

  let totalImported = 0;
  let totalUpdated = 0;
  let totalErrors = 0;

  for (let year = args.yearStart; year <= args.yearEnd; year++) {
    for (const type of args.types) {
      const comboKey = `${year}_${type}`;
      if (done.has(comboKey)) {
        console.log(`\nSkipping ${year} type ${type} (${TYPE_NAMES[type]}): done in checkpoint`);
        continue;
      }

      console.log(`\n--- ${year}, type ${type} (${TYPE_NAMES[type]}) ---`);

      let page = cp.current === comboKey ? cp.page : 1;
      let comboImported = 0;
      let comboUpdated = 0;
      let comboErrors = 0;
      let pageFailures = 0;

      while (page <= args.maxPages) {
        let items: any[];
        try {
          const response = await getJson(`${API_ROOT}/list?declaration_year=${year}&declaration_type=${type}&page=${page}`);
          items = Array.isArray(response?.data) ? response.data
            : (response?.data?.items || response?.items || []);
        } catch (err) {
          console.error(`\n  Page ${page} fetch error:`, (err as Error).message);
          if (++pageFailures > 5) break;
          continue;
        }
        if (items.length === 0) break;

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (const doc of items) {
            try {
              await client.query('SAVEPOINT doc');
              const r = await upsertDeclaration(client, doc, type, year);
              await client.query('RELEASE SAVEPOINT doc');
              if (r === 'insert') comboImported++;
              else if (r === 'update') comboUpdated++;
            } catch (err) {
              await client.query('ROLLBACK TO SAVEPOINT doc');
              comboErrors++;
              if (comboErrors <= 3) console.error(`\n  Error:`, (err as Error).message?.substring(0, 200));
            }
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }

        process.stdout.write(`\r  Page ${page}/${args.maxPages} | New: ${comboImported} | Updated: ${comboUpdated} | Errors: ${comboErrors}`);
        page++;
        writeCheckpoint(args.checkpoint, { done: [...done], current: comboKey, page });
        if (items.length < 100) break;
        await sleep(REQUEST_DELAY_MS);
      }

      if (pageFailures > 5) {
        console.error(`\n  Too many page failures: ${year} type ${type} left unfinished in the checkpoint`);
      } else {
        done.add(comboKey);
        writeCheckpoint(args.checkpoint, { done: [...done], current: null, page: 1 });
      }
      console.log(`\n  Result: ${comboImported} new, ${comboUpdated} updated, ${comboErrors} errors (${page - 1} pages)`);
      totalImported += comboImported;
      totalUpdated += comboUpdated;
      totalErrors += comboErrors;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`TOTAL: ${totalImported} new, ${totalUpdated} updated, ${totalErrors} errors`);
}

interface DetailsCheckpoint { lastId: number; processed: number; missing: number; errors: number }

async function importDetails(pool: Pool, args: CliArgs) {
  const cp: DetailsCheckpoint = args.resume
    ? readCheckpoint<DetailsCheckpoint>(args.checkpoint, { lastId: 0, processed: 0, missing: 0, errors: 0 })
    : { lastId: 0, processed: 0, missing: 0, errors: 0 };

  // $1 is the cursor (id > lastId); the rest are fixed filters.
  const where: string[] = ['id > $1', 'declaration_year BETWEEN $2 AND $3', 'declaration_type = ANY($4)'];
  const filters: any[] = [args.yearStart, args.yearEnd, args.types];
  if (!args.all) where.push('has_income IS NULL');
  if (args.name) {
    filters.push(`${args.name}%`);
    where.push(`declarant_name ILIKE $${filters.length + 1}`);
  }
  const whereSql = where.join(' AND ');

  const todo = await pool.query(`SELECT COUNT(*)::int AS n FROM nazk_declarations WHERE ${whereSql}`, [cp.lastId, ...filters]);
  const target = args.limit ? Math.min(args.limit, todo.rows[0].n) : todo.rows[0].n;
  console.log(`Details: ${target} declarations to fetch (id > ${cp.lastId}), concurrency ${CONCURRENCY}`);

  const startedAt = Date.now();
  let session = 0;
  const BATCH = 200;

  while (!args.limit || session < args.limit) {
    const batchSize = args.limit ? Math.min(BATCH, args.limit - session) : BATCH;
    const rows = (await pool.query(
      `SELECT id, declaration_id, declaration_type, declaration_year FROM nazk_declarations
       WHERE ${whereSql} ORDER BY id LIMIT ${batchSize}`,
      [cp.lastId, ...filters],
    )).rows;
    if (rows.length === 0) break;

    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const row = rows[next++];
        try {
          const doc = await getJson(`${API_ROOT}/${encodeURIComponent(row.declaration_id)}`);
          if (!doc || !doc.data) {
            cp.missing++;
          } else {
            const client = await pool.connect();
            try {
              await upsertDeclaration(client, doc, row.declaration_type, row.declaration_year);
            } finally {
              client.release();
            }
          }
        } catch (err) {
          cp.errors++;
          if (cp.errors <= 20) console.error(`\n  ${row.declaration_id}: ${(err as Error).message?.substring(0, 160)}`);
        }
        cp.processed++;
        session++;
        await sleep(REQUEST_DELAY_MS);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

    cp.lastId = rows[rows.length - 1].id;
    writeCheckpoint(args.checkpoint, cp);

    const rate = session / Math.max(1, (Date.now() - startedAt) / 1000);
    const etaMin = Math.round((target - session) / Math.max(rate, 0.001) / 60);
    console.log(`  ${session}/${target} | ${rate.toFixed(1)} doc/s | ETA ${etaMin} min | lastId ${cp.lastId} | missing ${cp.missing} | errors ${cp.errors}`);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`DETAILS: ${session} fetched this run, ${cp.missing} missing on NAZK, ${cp.errors} errors (checkpoint ${args.checkpoint})`);
}

async function importNazk() {
  const args = parseArgs();
  console.log('='.repeat(60));
  console.log(`NAZK Declarations Import: ${args.details ? 'details (/documents/{id})' : 'list crawl'}`);
  console.log(`Years: ${args.yearStart}-${args.yearEnd}, Types: ${args.types.join(',')}`);
  console.log(`Delay between requests: ${REQUEST_DELAY_MS}ms, checkpoint: ${args.checkpoint}`);
  console.log('='.repeat(60));

  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
    max: CONCURRENCY + 2,
  });

  try {
    // A schema+data restore can leave the id sequence behind max(id) (on cthulhu it was at 1
    // with max(id) 436 184): every INSERT … ON CONFLICT (declaration_id) then fails on the
    // primary key before the conflict clause is reached, so a re-import updated nothing.
    // Only ever moves the sequence forward.
    const seq = await pool.query(
      `SELECT setval(pg_get_serial_sequence('nazk_declarations', 'id'), m) AS v
       FROM (SELECT MAX(id) AS m FROM nazk_declarations) t
       WHERE m > (SELECT last_value FROM nazk_declarations_id_seq)`
    );
    if (seq.rows.length) console.log(`id sequence was behind max(id); moved to ${seq.rows[0].v}`);

    if (args.details) await importDetails(pool, args);
    else await importList(pool, args);
    const count = await pool.query('SELECT COUNT(*) FROM nazk_declarations');
    console.log(`Total in database: ${count.rows[0].count}`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  importNazk().catch(e => { console.error(e); process.exit(1); });
}
