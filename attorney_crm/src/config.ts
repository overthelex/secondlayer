import { loadTenant, type Tenant } from './tenant';

// Process configuration. Fails fast: a CRM with no session secret or no database
// must not come up half-working behind nginx.

export interface Config {
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  derivationLagDays: number;
  derivationBatch: number;
  derivationEnabled: boolean;
  tenant: Tenant;
  /** Public origin for unsubscribe links, default https://attorney.<brand domain>. */
  publicUrl: string;
  /** smtp(s)://user:pass@host:port, normally ACS (smtp.azurecomm.net:587); unset = dry runs only. */
  smtpUrl: string | null;
  /** From header for campaign mail; must be an allowed MailFrom on the ACS domain. */
  mailFrom: string;
  replyTo: string | null;
  /** The mailto: target in List-Unsubscribe (catch-all on mail2 lands it in the team mailbox). */
  unsubscribeMailbox: string;
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
  const tenant = loadTenant(env);
  const domain = tenant.brand.domain;
  const str = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);
  return {
    publicUrl: (str(env.ATTORNEY_CRM_PUBLIC_URL) ?? `https://attorney.${domain}`).replace(/\/+$/, ''),
    smtpUrl: str(env.ATTORNEY_CRM_SMTP_URL),
    mailFrom: str(env.ATTORNEY_CRM_MAIL_FROM) ?? `${tenant.brand.name} <vladimir@${domain}>`,
    replyTo: str(env.ATTORNEY_CRM_REPLY_TO),
    unsubscribeMailbox: str(env.ATTORNEY_CRM_UNSUBSCRIBE_MAILBOX) ?? `unsubscribe@${domain}`,
    port: intOr(env.PORT, 3020),
    databaseUrl,
    sessionSecret,
    derivationLagDays: intOr(env.ATTORNEY_CRM_DERIVATION_LAG_DAYS, 30),
    derivationBatch: intOr(env.ATTORNEY_CRM_DERIVATION_BATCH, 2000),
    derivationEnabled: (env.ATTORNEY_CRM_DERIVATION ?? 'on').toLowerCase() !== 'off',
    tenant,
  };
}
