/**
 * Sync plenary roll-call votes (9th convocation) from data.rada.gov.ua.
 *
 * Usage (inside the rada container):
 *   node dist/scripts/sync-voting.js                       # last DAYS_BACK days (default 14)
 *   START_DATE=2019-08-29 END_DATE=2026-10-24 node dist/scripts/sync-voting.js
 *
 * Only dates listed in /ogd/zal/ppz/skl9/dict/dates.txt are fetched, one at a
 * time with DELAY_MS between requests. Every row is an upsert keyed by RADA
 * id_event, so a run can be interrupted and repeated; nothing is deleted.
 * LEXAI-2094: voting had no schedule at all, the last import was 25.03.2026.
 */

import { Database } from '../database/database';
import { RadaAPIAdapter } from '../adapters/rada-api-adapter';
import { VotingService } from '../services/voting-service';
import { logger } from '../utils/logger';

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const convocation = parseInt(process.env.CONVOCATION || '9', 10);
  const daysBack = parseInt(process.env.DAYS_BACK || '14', 10);
  const startDate = process.env.START_DATE || isoDaysAgo(daysBack);
  const endDate = process.env.END_DATE || isoDaysAgo(0);
  const delayMs = parseInt(process.env.DELAY_MS || '1000', 10);
  const maxFailures = parseInt(process.env.MAX_FAILURES || '5', 10);

  const db = new Database();
  const adapter = new RadaAPIAdapter();
  const voting = new VotingService(db, adapter);

  await db.connect();
  try {
    const all = await adapter.fetchAvailableSessionDates(convocation);
    if (all.length === 0) {
      throw new Error('dates.txt returned no session dates');
    }
    const dates = all.filter((d) => d >= startDate && d <= endDate).sort();
    console.log(
      `RADA voting sync skl${convocation}: ${startDate}..${endDate}, ${dates.length} session days (of ${all.length})`
    );

    let rollCalls = 0;
    let failures = 0;
    for (const [i, date] of dates.entries()) {
      try {
        const records = await voting.getVotingByDate(date, convocation, true);
        const withVotes = records.filter((r) => r.votes && Object.keys(r.votes).length > 0).length;
        rollCalls += withVotes;
        console.log(`[${i + 1}/${dates.length}] ${date} rows=${records.length} roll_calls=${withVotes}`);
      } catch (error: any) {
        failures++;
        console.error(`[${i + 1}/${dates.length}] ${date} FAILED: ${error.message}`);
        if (failures >= maxFailures) {
          throw new Error(`${failures} dates failed, stopping`);
        }
      }
      if (i < dates.length - 1) await sleep(delayMs);
    }

    console.log(`Done: ${dates.length - failures} days, ${rollCalls} roll-calls, ${failures} failed`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('RADA voting sync failed', { error: error.message });
    console.error('Fatal:', error.message);
    process.exit(1);
  });
}
