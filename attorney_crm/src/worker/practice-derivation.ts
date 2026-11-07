// Daily driver for the ЄДРСР practice derivation. The logic lives in SQL
// (sql/001_practice_derivation.sql: attorney_crm_derive_batch); this file only
// loops it year by year and refreshes the stats view at the end.
import type { Queryable } from '../db';

export interface DerivationOptions {
  years: number[];
  batch: number;
  lagDays: number;
  pauseMs: number;
  log: (line: string) => void;
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

export function defaultYears(now: Date = new Date()): number[] {
  const out: number[] = [];
  for (let y = 2024; y <= now.getFullYear(); y++) out.push(y);
  return out;
}

export async function runDerivation(pool: Queryable, o: DerivationOptions): Promise<{ docs: number; hits: number }> {
  let docs = 0;
  let hits = 0;
  const stems = await pool.query<{ attorney_crm_refresh_stems: number }>('SELECT attorney_crm_refresh_stems()');
  o.log(`stems snapshot: ${stems.rows[0]?.attorney_crm_refresh_stems ?? '?'} advocates`);
  for (const year of o.years) {
    let yearDocs = 0;
    let yearHits = 0;
    try {
      for (;;) {
        // One batch per transaction with its own timeout; a timeout leaves the cursor untouched.
        await pool.query('BEGIN');
        let r;
        try {
          await pool.query("SET LOCAL statement_timeout = '180s'");
          r = await pool.query<{ out_docs: number; out_with_text: number; out_hits: number; out_last_doc_id: string }>(
            'SELECT out_docs, out_with_text, out_hits, out_last_doc_id FROM attorney_crm_derive_batch($1, $2, $3)',
            [year, o.batch, o.lagDays],
          );
          await pool.query('COMMIT');
        } catch (err) {
          await pool.query('ROLLBACK').catch(() => undefined);
          throw err;
        }
        const row = r.rows[0];
        const n = Number(row?.out_docs ?? 0);
        if (n === 0) break;
        yearDocs += n;
        yearHits += Number(row.out_hits ?? 0);
        await sleep(o.pauseMs);
      }
      o.log(`year ${year}: done, ${yearDocs} docs, ${yearHits} hits`);
    } catch (err) {
      o.log(`year ${year}: abandoned after ${yearDocs} docs: ${(err as Error).message}`);
    }
    docs += yearDocs;
    hits += yearHits;
  }
  try {
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY attorney_crm_practice_stats');
    o.log('practice stats refreshed');
  } catch (err) {
    o.log(`refresh failed: ${(err as Error).message}`);
  }
  return { docs, hits };
}

export interface ScheduleOptions {
  initialDelayMs: number;
  intervalMs: number;
  log: (line: string) => void;
  run: () => Promise<{ docs: number; hits: number }>;
}

/** Runs once after initialDelayMs, then every intervalMs; never overlaps; never throws out of the timer. */
export function scheduleDerivation(o: ScheduleOptions): { stop: () => void } {
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (running) {
      o.log('derivation still running, skipping this tick');
      return;
    }
    running = true;
    try {
      const r = await o.run();
      o.log(`derivation run finished: ${r.docs} docs, ${r.hits} hits`);
    } catch (err) {
      o.log(`derivation run failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => {
    void tick();
    timer = setInterval(() => void tick(), o.intervalMs);
  }, o.initialDelayMs);
  return {
    stop: () => {
      clearTimeout(first);
      if (timer) clearInterval(timer);
    },
  };
}
