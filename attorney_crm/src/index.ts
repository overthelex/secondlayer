import path from 'path';
import { loadConfig } from './config';
import { createPool } from './db';
import { applySchema } from './schema';
import { createApp } from './server';
import { LoginRateLimit } from './auth/rate-limit';
import { defaultYears, runDerivation, scheduleDerivation } from './worker/practice-derivation';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createPool(config.databaseUrl);
  const applied = await applySchema(pool, path.join(__dirname, '..', 'sql'));
  process.stdout.write(`[attorney_crm] schema ok (${applied.length ? applied.join(', ') : 'nothing new'})\n`);
  const app = createApp({ pool, config, rateLimit: new LoginRateLimit() });
  app.listen(config.port, () => process.stdout.write(`[attorney_crm] listening on ${config.port}\n`));
  if (config.derivationEnabled) {
    const log = (line: string) => process.stdout.write(`[attorney_crm/derivation] ${line}\n`);
    // The derivation holds one pool connection for hours; a dedicated client keeps
    // it from starving page requests.
    scheduleDerivation({
      initialDelayMs: 60_000,
      intervalMs: 24 * 3600 * 1000,
      log,
      run: async () => {
        const client = await pool.connect();
        try {
          return await runDerivation(client, { years: defaultYears(), batch: config.derivationBatch, lagDays: config.derivationLagDays, pauseMs: 200, log });
        } finally {
          client.release();
        }
      },
    });
  } else {
    process.stdout.write('[attorney_crm] derivation disabled (ATTORNEY_CRM_DERIVATION=off)\n');
  }
}

main().catch((err) => {
  process.stderr.write(`[attorney_crm] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
