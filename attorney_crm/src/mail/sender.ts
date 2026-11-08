import nodemailer, { type Transporter } from 'nodemailer';
import type { Queryable } from '../db';
import { unsubscribeHeaders, type UnsubscribeConfig } from './headers';
import { suppressedAmong } from './suppression';
import { normaliseEmail } from './token';

// Every campaign message leaves through here: the suppression list and the lead's
// "do not contact" flag are checked first, the List-Unsubscribe headers are added,
// and the attempt is written to attorney_crm_mail_log. Transport is SMTP submission
// on mail2 (ATTORNEY_CRM_SMTP_URL), which relays to Azure Communication Services;
// without a URL the message is only built (dry run), so the headers can be inspected.

export interface MailerConfig {
  smtpUrl: string | null;
  from: string;
  replyTo?: string;
  unsubscribe: UnsubscribeConfig;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  advocateSourceId?: string | null;
  /** Free label; with one set, a second send to the same address in the same campaign is skipped. */
  campaign?: string;
}

export type SendStatus = 'sent' | 'suppressed' | 'failed' | 'dry-run' | 'duplicate';

export interface SendResult {
  status: SendStatus;
  email: string;
  messageId?: string;
  error?: string;
  /** The RFC 5322 message, on a dry run. */
  raw?: Buffer;
}

export interface Mailer {
  send(mail: OutgoingMail): Promise<SendResult>;
  close(): void;
}

async function doNotContact(pool: Queryable, advocateSourceId: string | null | undefined): Promise<boolean> {
  if (!advocateSourceId) return false;
  const r = await pool.query<{ do_not_contact: boolean }>('SELECT do_not_contact FROM attorney_crm_leads WHERE advocate_source_id = $1', [advocateSourceId]);
  return r.rows[0]?.do_not_contact === true;
}

async function alreadySent(pool: Queryable, campaign: string | undefined, email: string): Promise<boolean> {
  if (!campaign) return false;
  const r = await pool.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM attorney_crm_mail_log WHERE campaign = $1 AND email = $2 AND status = 'sent'",
    [campaign, email],
  );
  return Number(r.rows[0]?.n ?? 0) > 0;
}

async function log(pool: Queryable, mail: OutgoingMail, email: string, status: SendStatus, messageId: string | null, error: string | null): Promise<void> {
  // 'duplicate' is not a delivery outcome, so it is not written; 'dry-run' is, to show what a run would do.
  if (status === 'duplicate') return;
  await pool.query(
    'INSERT INTO attorney_crm_mail_log (email, advocate_source_id, campaign, subject, message_id, status, error) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [email, mail.advocateSourceId ?? null, mail.campaign ?? '', mail.subject, messageId, status, error],
  );
}

export function createMailer(pool: Queryable, cfg: MailerConfig, transporter?: Transporter): Mailer {
  const dryRun = !cfg.smtpUrl && !transporter;
  const transport: Transporter =
    transporter ??
    (cfg.smtpUrl ? nodemailer.createTransport(cfg.smtpUrl) : nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' }));

  return {
    async send(mail) {
      const email = normaliseEmail(mail.to);
      if (!email.includes('@')) return { status: 'failed', email, error: 'not an e-mail address' };
      const [blocked, dnc] = await Promise.all([suppressedAmong(pool, [email]), doNotContact(pool, mail.advocateSourceId)]);
      if (blocked.has(email) || dnc) {
        await log(pool, mail, email, 'suppressed', null, dnc ? 'do_not_contact' : 'suppression list');
        return { status: 'suppressed', email, error: dnc ? 'do_not_contact' : 'suppression list' };
      }
      if (await alreadySent(pool, mail.campaign, email)) return { status: 'duplicate', email };
      try {
        const info = await transport.sendMail({
          from: cfg.from,
          to: email,
          replyTo: cfg.replyTo,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          headers: { ...unsubscribeHeaders(cfg.unsubscribe, email), Precedence: 'bulk' },
        });
        const status: SendStatus = dryRun ? 'dry-run' : 'sent';
        await log(pool, mail, email, status, info.messageId ?? null, null);
        return { status, email, messageId: info.messageId, raw: dryRun ? (info.message as Buffer) : undefined };
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        await log(pool, mail, email, 'failed', null, message.slice(0, 1000));
        return { status: 'failed', email, error: message };
      }
    },
    close() {
      transport.close?.();
    },
  };
}
