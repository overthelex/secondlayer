import { signUnsubscribeToken } from './token';

export interface UnsubscribeConfig {
  /** Public origin of the CRM, e.g. https://attorney.legal.org.ua (no trailing slash). */
  publicUrl: string;
  /** Mailbox for the mailto: variant, e.g. unsubscribe@legal.org.ua. */
  mailbox: string;
  secret: string;
}

export function unsubscribeUrl(cfg: UnsubscribeConfig, email: string): string {
  return `${cfg.publicUrl.replace(/\/+$/, '')}/u/${signUnsubscribeToken(cfg.secret, email)}`;
}

/**
 * RFC 2369 List-Unsubscribe with both a mailto: and an https: target, plus the
 * RFC 8058 one-click POST marker that Gmail/Yahoo/Outlook require for bulk senders.
 */
export function unsubscribeHeaders(cfg: UnsubscribeConfig, email: string): Record<string, string> {
  const token = signUnsubscribeToken(cfg.secret, email);
  const url = `${cfg.publicUrl.replace(/\/+$/, '')}/u/${token}`;
  return {
    'List-Unsubscribe': `<mailto:${cfg.mailbox}?subject=unsubscribe%20${token}>, <${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
