import { createHmac, timingSafeEqual } from 'crypto';
import { normaliseEmail } from './token';
import type { SuppressionReason } from './suppression';

// Azure Communication Services reports the fate of every message through Event Grid
// (Microsoft.Communication.EmailDeliveryReportReceived). mail2 / the SMTP client only
// ever see ACS's "250 queued", so this webhook is the one place real bounces show up.

export const VALIDATION_EVENT = 'Microsoft.EventGrid.SubscriptionValidationEvent';
export const DELIVERY_EVENT = 'Microsoft.Communication.EmailDeliveryReportReceived';

export interface AcsEvent {
  type: string;
  data: Record<string, unknown>;
}

/** Shared secret Event Grid sends with each delivery; derived, so no extra env var or table. */
export function hookKey(secret: string): string {
  return createHmac('sha256', secret).update('acs-events-hook').digest('hex').slice(0, 40);
}

export function hookKeyMatches(secret: string, presented: unknown): boolean {
  if (typeof presented !== 'string' || !presented) return false;
  const want = Buffer.from(hookKey(secret));
  const got = Buffer.from(presented);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Accepts the Event Grid schema (array, `eventType`) and CloudEvents 1.0 (`type`), batched or single. */
export function parseAcsEvents(body: unknown): AcsEvent[] {
  const list = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
  const out: AcsEvent[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const type = typeof e.eventType === 'string' ? e.eventType : typeof e.type === 'string' ? e.type : '';
    if (!type) continue;
    out.push({ type, data: e.data && typeof e.data === 'object' ? (e.data as Record<string, unknown>) : {} });
  }
  return out;
}

export interface DeliveryOutcome {
  email: string;
  status: string;
  /** null = nothing to suppress (delivered, list expansion, or a failure that may be transient). */
  reason: SuppressionReason | null;
  detail: string;
}

// Bounced = hard bounce; Suppressed = ACS itself refuses the address after an earlier
// hard bounce. FilteredSpam / Quarantined = the receiving side judged the message spam:
// writing there again only costs reputation. Failed can be transient, so it is reported
// but not suppressed.
const REASON_BY_STATUS: Record<string, SuppressionReason> = {
  bounced: 'bounce',
  suppressed: 'bounce',
  filteredspam: 'complaint',
  quarantined: 'complaint',
};

/** Reads one delivery report; null when it is not ours (another sender domain) or malformed. */
export function deliveryOutcome(event: AcsEvent, senderDomain: string): DeliveryOutcome | null {
  if (event.type !== DELIVERY_EVENT) return null;
  const sender = typeof event.data.sender === 'string' ? normaliseEmail(event.data.sender) : '';
  const recipient = typeof event.data.recipient === 'string' ? normaliseEmail(event.data.recipient) : '';
  const status = typeof event.data.status === 'string' ? event.data.status : '';
  if (!recipient.includes('@') || !status) return null;
  if (!sender.endsWith(`@${senderDomain.toLowerCase()}`)) return null;
  const details = event.data.deliveryStatusDetails;
  const message =
    details && typeof details === 'object' && typeof (details as Record<string, unknown>).statusMessage === 'string'
      ? ((details as Record<string, unknown>).statusMessage as string)
      : '';
  const detail = `${status}${message ? `: ${message}` : ''}`.replace(/\s+/g, ' ').slice(0, 500);
  return { email: recipient, status, reason: REASON_BY_STATUS[status.toLowerCase()] ?? null, detail };
}
