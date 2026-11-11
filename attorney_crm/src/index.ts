import path from 'path';
import { loadConfig } from './config';
import { createPool } from './db';
import { applySchema } from './schema';
import { createApp } from './server';
import { LoginRateLimit } from './auth/rate-limit';
import { defaultYears, runDerivation, scheduleDerivation } from './worker/practice-derivation';
import { setTenant } from './tenant';
import { AriClient, runEventLoop } from './pbx/ari';
import { EventHub } from './pbx/hub';
import { PbxService } from './pbx/calls';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  setTenant(config.tenant);
  const pool = createPool(config.databaseUrl, config.tenant.schema, `attorney_crm_${config.tenant.id}`);
  const applied = await applySchema(pool, path.join(__dirname, '..', 'sql'), config.tenant.sqlFiles, config.tenant.schema);
  process.stdout.write(`[attorney_crm] tenant ${config.tenant.id}, schema ok (${applied.length ? applied.join(', ') : 'nothing new'})\n`);
  const pbx = config.pbx ? startPbx(pool, config.pbx) : undefined;
  const app = createApp({ pool, config, rateLimit: new LoginRateLimit(), pbx });
  app.listen(config.port, () => process.stdout.write(`[attorney_crm] listening on ${config.port}\n`));
  if (config.derivationEnabled && config.tenant.derivedPractices) {
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
    process.stdout.write(`[attorney_crm] derivation disabled (${config.tenant.derivedPractices ? 'ATTORNEY_CRM_DERIVATION=off' : `tenant ${config.tenant.id} has no court-derived practices`})\n`);
  }
}

// Telephony (README "Telephony"): one ARI socket per process; a PBX that is down at
// boot is retried in the background and the button simply fails with 502 until then.
function startPbx(pool: ReturnType<typeof createPool>, cfg: NonNullable<ReturnType<typeof loadConfig>['pbx']>): { service: PbxService; hub: EventHub } {
  const log = (line: string) => process.stdout.write(`[attorney_crm/pbx] ${line}\n`);
  const ari = new AriClient({ url: cfg.ariUrl, user: cfg.ariUser, password: cfg.ariPassword, app: cfg.ariApp, certSha256: cfg.certSha256 });
  const hub = new EventHub();
  const service = new PbxService(pool, ari, hub, { agents: cfg.agents, noteUserEmail: cfg.noteUserEmail, outboundContext: cfg.outboundContext, countryCode: cfg.countryCode }, log);
  ari.ping().then(() => log(`ARI ${new URL(cfg.ariUrl).host} ok (app ${cfg.ariApp}${cfg.certSha256 ? ', pinned certificate' : ''})`), (err) => log(`ARI ${new URL(cfg.ariUrl).host}: ${(err as Error).message}`));
  runEventLoop(() => ari.openEvents(), (e) => void service.handleEvent(e), log);
  return { service, hub };
}

main().catch((err) => {
  process.stderr.write(`[attorney_crm] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
