import path from 'path';
import { loadConfig } from './config';
import { createPool } from './db';
import { applySchema } from './schema';
import { createApp } from './server';
import { LoginRateLimit } from './auth/rate-limit';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createPool(config.databaseUrl);
  const applied = await applySchema(pool, path.join(__dirname, '..', 'sql'));
  process.stdout.write(`[attorney_crm] schema ok (${applied.length ? applied.join(', ') : 'nothing new'})\n`);
  const app = createApp({ pool, config, rateLimit: new LoginRateLimit() });
  app.listen(config.port, () => process.stdout.write(`[attorney_crm] listening on ${config.port}\n`));
}

main().catch((err) => {
  process.stderr.write(`[attorney_crm] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
