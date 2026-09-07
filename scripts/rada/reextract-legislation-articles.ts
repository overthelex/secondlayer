#!/usr/bin/env npx tsx
/**
 * Re-extract curated legislation articles whose stored text predates the parser's
 * boundary fixes (LEXAI-1809 / LEXAI-1821).
 *
 * Those fixes bound the article scan at the "Прикінцеві та перехідні положення"
 * heading and terminate an article body at the next Розділ/Підрозділ/Глава/Книга.
 * The code carries them; rows extracted before they landed do not. On the Civil
 * Code, ст. 1308 holds 41,073 characters — its own two paragraphs followed by the
 * whole transitional block, the publication footer and every amendment note. The
 * current parser produces 273 characters for the same article.
 *
 * The article upsert keys on (legislation_id, article_number, version_date) and the
 * current edition always carries the 2000-01-01 sentinel, so re-running the fetch
 * REWRITES the rows in place. Nothing is deleted: the п.* rows come from
 * extractTransitionalProvisions and are refreshed by the same save.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/rada/reextract-legislation-articles.ts --damaged [--delay=4000] [--limit=N] [--dry-run]
 *   DATABASE_URL=... npx tsx scripts/rada/reextract-legislation-articles.ts --only=435-15,1618-15
 *
 * --damaged selects acts that still carry transitional text inside a numbered
 * article, which is the signature of the pre-fix parse. Rate-limited and
 * checkpointed: zakon.rada.gov.ua throttles, and a print page is ~2 MB.
 */

import * as fs from 'fs';
import * as path from 'path';
import pg from 'pg';
import { RadaLegislationAdapter } from '../../mcp_backend/src/adapters/rada-legislation-adapter';
import type { IDatabase, IQueryResult, ITransactionClient } from '../../mcp_backend/src/domain/ports/database';

const PROGRESS_FILE = path.join(__dirname, 'reextract-progress.json');

/**
 * An article number that is a bare number (or number-index), i.e. a real article
 * rather than a п.N transitional row, whose text contains a transitional heading.
 * Only the pre-fix parse could produce that.
 */
const DAMAGED_ACTS_SQL = `
  SELECT DISTINCT l.rada_id
  FROM legislation_articles a
  JOIN legislation l ON l.id = a.legislation_id
  WHERE a.is_current
    AND a.article_number ~ '^[0-9]+(-[0-9]+)?$'
    AND a.full_text ~ '(ПРИКІНЦЕВІ|ПЕРЕХІДНІ)\\s+(ТА\\s+(ПРИКІНЦЕВІ|ПЕРЕХІДНІ)\\s+)?ПОЛОЖЕННЯ'
  ORDER BY 1`;

class PgPoolDatabase implements IDatabase {
  constructor(private pool: pg.Pool) {}

  async query<T = any>(text: string, params?: unknown[]): Promise<IQueryResult<T>> {
    const r = await this.pool.query(text, params as any[]);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 } as IQueryResult<T>;
  }

  async transaction<T>(callback: (client: ITransactionClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txClient: ITransactionClient = {
        query: async (text: string, p?: unknown[]) => {
          const r = await client.query(text, p as any[]);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 } as any;
        },
      } as ITransactionClient;
      const result = await callback(txClient);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async connect(): Promise<void> { /* pool auto-connects */ }
  async close(): Promise<void> { await this.pool.end(); }
  getPool(): pg.Pool { return this.pool; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadProgress(): { done: string[]; failed: Record<string, string> } {
  if (fs.existsSync(PROGRESS_FILE)) return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  return { done: [], failed: {} };
}
function saveProgress(p: { done: string[]; failed: Record<string, string> }) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

/** Longest current article of an act, so before/after is measured, not assumed. */
async function maxArticleLen(db: PgPoolDatabase, radaId: string): Promise<{ n: string; len: number } | null> {
  const r = await db.query<{ article_number: string; len: string }>(
    `SELECT a.article_number, length(a.full_text) AS len
       FROM legislation_articles a JOIN legislation l ON l.id = a.legislation_id
      WHERE l.rada_id = $1 AND a.is_current AND a.article_number ~ '^[0-9]+(-[0-9]+)?$'
      ORDER BY length(a.full_text) DESC LIMIT 1`,
    [radaId],
  );
  return r.rows[0] ? { n: r.rows[0].article_number, len: Number(r.rows[0].len) } : null;
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.find((a) => a.startsWith('--only='))?.split('=')[1]?.split(',').map((s) => s.trim());
  const delay = parseInt(args.find((a) => a.startsWith('--delay='))?.split('=')[1] || '4000', 10);
  const cap = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] || '0', 10);
  const dryRun = args.includes('--dry-run');
  const damaged = args.includes('--damaged');

  if (!only && !damaged) {
    console.error('Pass --damaged to select acts automatically, or --only=<rada_id,...>');
    process.exit(1);
  }
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error('DATABASE_URL required'); process.exit(1); }

  const pool = new pg.Pool({ connectionString: dbUrl, max: 4 });
  const db = new PgPoolDatabase(pool);
  const adapter = new RadaLegislationAdapter(db);

  let work: string[];
  if (only) {
    work = only;
  } else {
    const r = await db.query<{ rada_id: string }>(DAMAGED_ACTS_SQL);
    work = r.rows.map((x) => x.rada_id);
  }

  const progress = loadProgress();
  work = work.filter((id) => !progress.done.includes(id));
  if (cap > 0) work = work.slice(0, cap);

  console.log(`${work.length} act(s) to re-extract, ${progress.done.length} already done, delay ${delay}ms`);
  if (dryRun) {
    console.log(work.join('\n'));
    await db.close();
    return;
  }

  let ok = 0, failed = 0;
  for (const [i, radaId] of work.entries()) {
    const before = await maxArticleLen(db, radaId);
    try {
      const { metadata, articles } = await adapter.fetchLegislation(radaId);
      if (articles.length === 0) throw new Error('parser returned 0 articles — refusing to save');
      await adapter.saveLegislationToDatabase(metadata, articles);
      const after = await maxArticleLen(db, radaId);
      ok++;
      console.log(
        `[${i + 1}/${work.length}] ${radaId}: ${articles.length} articles, ` +
        `longest ст.${before?.n ?? '?'} ${before?.len ?? '?'} -> ст.${after?.n ?? '?'} ${after?.len ?? '?'}`,
      );
      progress.done.push(radaId);
    } catch (err: any) {
      failed++;
      progress.failed[radaId] = String(err.message).slice(0, 300);
      console.error(`[${i + 1}/${work.length}] ${radaId}: FAILED ${err.message}`);
    }
    saveProgress(progress);
    if (i < work.length - 1) await sleep(delay);
  }

  console.log(`done: ${ok} ok, ${failed} failed`);
  await db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
