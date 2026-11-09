// node dist/collector/cli.js daemon
// node dist/collector/cli.js once probe|adwokaci-list|adwokaci-details|radcowie-list|szukajradcy|chambers [--no-proxy] [--limit N] [--only src,src]
import { createPool } from '../db';
import { Collector } from './http';
import { adwokaciDetails, adwokaciList, daemon, MIN_DELAY_MS, probe, radcowieList, szukajradcy, type JobDeps } from './jobs';
import { CHAMBER_MIN_DELAY_MS, CHAMBER_SOURCES, chambers, type ChamberSource } from './jobs-chambers';

const DEFAULT_UA = 'lawrider.pl attorney-crm collector (+https://lawrider.pl; vladimir@lawrider.pl)';

function log(line: string) {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

async function waitForTables(pool: ReturnType<typeof createPool>): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await pool.query<{ ok: boolean }>("SELECT to_regclass('public.pl_lawyers') IS NOT NULL AS ok");
    if (r.rows[0]?.ok) return;
    log('[collector] waiting for public.pl_lawyers (the CRM applies the schema)');
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error('public.pl_lawyers never appeared');
}

async function main(argv: string[]) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const noProxy = argv.includes('--no-proxy');
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : 200;
  const proxyUrl = noProxy ? null : process.env.HTTPS_PROXY ?? process.env.https_proxy ?? null;
  const pool = createPool(databaseUrl, null, 'attorney_crm_pl_collector');
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? (argv[onlyIdx + 1] ?? '').split(',').filter((x): x is ChamberSource => (CHAMBER_SOURCES as string[]).includes(x)) : undefined;
  const http = new Collector({ userAgent: process.env.COLLECTOR_UA ?? DEFAULT_UA, minDelayMs: { ...MIN_DELAY_MS, ...CHAMBER_MIN_DELAY_MS }, maxConsecutiveFailures: 5, proxyUrl, log });
  const deps: JobDeps = { pool, http, log };
  log(`[collector] proxy ${proxyUrl ?? 'none'}`);
  const [mode, job] = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--limit', '--only'].includes(argv[i - 1])));
  try {
    if (mode === 'daemon') {
      await waitForTables(pool);
      const { stop, done } = daemon(deps);
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
      await done;
      return;
    }
    if (mode === 'once') {
      if (job !== 'probe') await waitForTables(pool);
      switch (job) {
        case 'probe': log(JSON.stringify(await probe(deps))); return;
        case 'adwokaci-list': log(JSON.stringify(await adwokaciList(deps))); return;
        case 'adwokaci-details': log(JSON.stringify(await adwokaciDetails(deps, { maxAgeDays: 90, limit }))); return;
        case 'radcowie-list': log(JSON.stringify(await radcowieList(deps))); return;
        case 'szukajradcy': log(JSON.stringify(await szukajradcy(deps))); return;
        case 'chambers': log(JSON.stringify(await chambers(deps, { only }))); return;
      }
    }
    throw new Error('usage: cli.js daemon | once probe|adwokaci-list|adwokaci-details|radcowie-list|szukajradcy|chambers [--no-proxy] [--limit N] [--only src,src]');
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).catch((e) => {
  log(`[collector] fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
