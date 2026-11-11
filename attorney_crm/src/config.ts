import { loadTenant, type Tenant } from './tenant';
import { countryCodeFor } from './pbx/phone';

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
  /** Asterisk over ARI (README "Telephony"); null = no «Подзвонити» button, no screen pops. */
  pbx: PbxConfig | null;
}

export interface PbxConfig {
  ariUrl: string;
  ariUser: string;
  ariPassword: string;
  /** Stasis app name, the one in the dialplan's Stasis() and ari.conf. */
  ariApp: string;
  /** SHA-256 fingerprint of the PBX certificate (self-signed); unset = CA verification. */
  certSha256: string | null;
  /** CRM user e-mail → PJSIP endpoint; a user not listed rings <local part of e-mail>. */
  agents: Record<string, string>;
  /** CRM user credited with inbound-call notes. */
  noteUserEmail: string;
  outboundContext: string;
  countryCode: string;
}

/** «a@x=alice,b@x=bob» → { 'a@x': 'alice', 'b@x': 'bob' }. */
export function parseAgents(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (value ?? '').split(',')) {
    const [email, endpoint] = pair.split('=').map((x) => x.trim());
    if (email && endpoint && /^[A-Za-z0-9_.-]+$/.test(endpoint)) out[email.toLowerCase()] = endpoint;
  }
  return out;
}

function loadPbx(env: NodeJS.ProcessEnv, tenant: Tenant): PbxConfig | null {
  const str = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);
  const ariUrl = str(env.ATTORNEY_CRM_ARI_URL);
  if (!ariUrl) return null;
  const ariUser = str(env.ATTORNEY_CRM_ARI_USER);
  const ariPassword = str(env.ATTORNEY_CRM_ARI_PASSWORD);
  if (!ariUser || !ariPassword) throw new Error('ATTORNEY_CRM_ARI_USER and ATTORNEY_CRM_ARI_PASSWORD are required with ATTORNEY_CRM_ARI_URL');
  if (!/^https?:\/\//.test(ariUrl)) throw new Error('ATTORNEY_CRM_ARI_URL must start with http:// or https://');
  return {
    ariUrl,
    ariUser,
    ariPassword,
    ariApp: str(env.ATTORNEY_CRM_ARI_APP) ?? 'crm',
    certSha256: str(env.ATTORNEY_CRM_ARI_CERT_SHA256),
    agents: parseAgents(env.ATTORNEY_CRM_PBX_AGENTS),
    noteUserEmail: str(env.ATTORNEY_CRM_PBX_NOTE_USER) ?? `vladimir@${tenant.brand.domain}`,
    outboundContext: str(env.ATTORNEY_CRM_PBX_OUTBOUND_CONTEXT) ?? 'outbound',
    countryCode: str(env.ATTORNEY_CRM_PBX_COUNTRY_CODE)?.replace(/\D/g, '') || countryCodeFor(tenant.id),
  };
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
    pbx: loadPbx(env, tenant),
  };
}
