// Process configuration. Fails fast: a CRM with no session secret or no database
// must not come up half-working behind nginx.

export interface Config {
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  derivationLagDays: number;
  derivationBatch: number;
  derivationEnabled: boolean;
}

function intOr(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const sessionSecret = env.ATTORNEY_CRM_SESSION_SECRET;
  if (!sessionSecret) throw new Error('ATTORNEY_CRM_SESSION_SECRET is required');
  return {
    port: intOr(env.PORT, 3020),
    databaseUrl,
    sessionSecret,
    derivationLagDays: intOr(env.ATTORNEY_CRM_DERIVATION_LAG_DAYS, 30),
    derivationBatch: intOr(env.ATTORNEY_CRM_DERIVATION_BATCH, 2000),
    derivationEnabled: (env.ATTORNEY_CRM_DERIVATION ?? 'on').toLowerCase() !== 'off',
  };
}
