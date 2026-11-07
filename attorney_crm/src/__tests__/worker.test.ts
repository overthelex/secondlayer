import { runDerivation, scheduleDerivation } from '../worker/practice-derivation';

function fakePool(batchOutcomes: (number | Error)[], populated = true) {
  const calls: { text: string; values?: unknown[] }[] = [];
  let i = 0;
  return {
    calls,
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      if (text.includes('attorney_crm_derive_batch')) {
        const o = batchOutcomes[i++] ?? 0;
        if (o instanceof Error) throw o;
        return { rows: [{ out_docs: o, out_with_text: o, out_hits: Math.floor(o / 20), out_last_doc_id: 100 + i }], rowCount: 1 };
      }
      if (text.includes('attorney_crm_refresh_stems')) return { rows: [{ attorney_crm_refresh_stems: 73981 }], rowCount: 1 };
      if (text.includes('relispopulated')) return { rows: [{ relispopulated: populated }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('runs batches for a year until out_docs = 0, then refreshes the view once', async () => {
  const pool = fakePool([2000, 2000, 0]);
  const log: string[] = [];
  const r = await runDerivation(pool as any, { years: [2026], batch: 2000, lagDays: 30, pauseMs: 0, log: (s) => log.push(s) });
  const batches = pool.calls.filter((c) => c.text.includes('attorney_crm_derive_batch'));
  expect(batches).toHaveLength(3);
  expect(batches[0].values).toEqual([2026, 2000, 30]);
  expect(pool.calls.some((c) => c.text.includes('attorney_crm_refresh_stems'))).toBe(true);
  expect(pool.calls.filter((c) => c.text.includes('REFRESH MATERIALIZED VIEW CONCURRENTLY attorney_crm_practice_stats'))).toHaveLength(1);
  expect(pool.calls.some((c) => c.text.includes("statement_timeout"))).toBe(true);
  expect(r).toEqual({ docs: 4000, hits: 200 });
});

test('an unpopulated stats view gets a plain (non-concurrent) refresh', async () => {
  const pool = fakePool([0], false);
  await runDerivation(pool as any, { years: [2026], batch: 2000, lagDays: 30, pauseMs: 0, log: () => undefined });
  const refreshes = pool.calls.filter((c) => c.text.includes('REFRESH MATERIALIZED VIEW'));
  expect(refreshes).toHaveLength(1);
  expect(refreshes[0].text).not.toContain('CONCURRENTLY');
});

test('a batch error is logged and the year abandoned without throwing; next year still runs', async () => {
  const pool = fakePool([new Error('canceling statement due to statement timeout'), 0]);
  const log: string[] = [];
  const r = await runDerivation(pool as any, { years: [2025, 2026], batch: 2000, lagDays: 30, pauseMs: 0, log: (s) => log.push(s) });
  expect(log.some((s) => s.includes('2025') && s.includes('statement timeout'))).toBe(true);
  expect(pool.calls.filter((c) => c.text.includes('attorney_crm_derive_batch'))).toHaveLength(2);
  expect(r).toEqual({ docs: 0, hits: 0 });
});

test('scheduleDerivation runs after the initial delay and skips overlapping runs', async () => {
  jest.useFakeTimers();
  let running = 0;
  let maxConcurrent = 0;
  let runs = 0;
  const runner = async () => {
    running++; runs++;
    maxConcurrent = Math.max(maxConcurrent, running);
    await new Promise((r) => setTimeout(r, 50_000));
    running--;
    return { docs: 0, hits: 0 };
  };
  const handle = scheduleDerivation({ initialDelayMs: 1000, intervalMs: 10_000, log: () => undefined, run: runner });
  await jest.advanceTimersByTimeAsync(1000);
  expect(runs).toBe(1);
  await jest.advanceTimersByTimeAsync(10_000);
  expect(runs).toBe(1); // still running: skipped
  expect(maxConcurrent).toBe(1);
  await jest.advanceTimersByTimeAsync(50_000);
  expect(runs).toBeGreaterThanOrEqual(2);
  handle.stop();
  jest.useRealTimers();
});
