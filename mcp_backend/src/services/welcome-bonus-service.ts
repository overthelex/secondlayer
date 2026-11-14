/**
 * Welcome bonus: credited once per person after card verification.
 *
 * Hard limits (unique keys in welcome_bonus_claims): one claim per account and
 * one per card. Soft limit: Monobank does not return the cardholder name, so a
 * claim whose normalised profile name, client IP or browser device id matches
 * an earlier claim is held as `pending_review` until an administrator approves
 * or rejects it.
 */

import { WELCOME_BONUS_UAH } from '../config/welcome-bonus.js';
import type { IDatabase } from '../domain/ports/index.js';
import type { BillingService } from './billing-service.js';
import { logger } from '../utils/logger.js';

export type WelcomeBonusStatus = 'available' | 'credited' | 'pending_review' | 'rejected';
export type ClaimOutcome = 'credited' | 'pending_review' | 'already_claimed' | 'card_used';

export interface ClaimSignals {
  clientIp?: string | null;
  deviceId?: string | null;
}

/** Placeholder names set by the Diia login flow ("Дія Користувач …") carry no identity. */
function isPlaceholder(words: string[]): boolean {
  return words.includes('дія') && words.includes('користувач');
}

/**
 * "Петренко  Іван" and "іван петренко" → "іван петренко". Null when fewer than
 * two words remain, since one word (or an email handle) says too little.
 * Keep in sync with the SQL backfill in migration 269.
 */
export function nameKey(name: string | null | undefined): string | null {
  const words = (name || '')
    .toLowerCase()
    .replace(/['’ʼ`]/g, '')
    .split(/[^\p{L}]+/u)
    .filter(Boolean)
    .sort();
  if (words.length < 2 || isPlaceholder(words)) return null;
  return words.join(' ');
}

export function normalizeDeviceId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return /^[A-Za-z0-9-]{8,64}$/.test(v) ? v : null;
}

export class WelcomeBonusService {
  constructor(private db: IDatabase, private billingService: BillingService) {}

  async status(userId: string): Promise<WelcomeBonusStatus> {
    const r = await this.db.query('SELECT status FROM welcome_bonus_claims WHERE user_id = $1', [userId]);
    return r.rows.length ? (r.rows[0].status as WelcomeBonusStatus) : 'available';
  }

  /**
   * Record a verified card for the user and credit the bonus, or hold it for
   * review when another claim looks like the same person.
   */
  async claim(userId: string, maskedPan: string, invoiceId: string, signals: ClaimSignals = {}): Promise<ClaimOutcome> {
    const userRow = await this.db.query('SELECT name FROM users WHERE id = $1', [userId]);
    const key = nameKey(userRow.rows[0]?.name);
    const ip = signals.clientIp || null;
    const deviceId = normalizeDeviceId(signals.deviceId);

    const match = await this.db.query(
      `SELECT user_id,
              CASE WHEN name_key = $2 THEN 'name' WHEN device_id = $4 THEN 'device' ELSE 'ip' END AS reason
         FROM welcome_bonus_claims
        WHERE user_id <> $1
          AND status IN ('credited', 'pending_review')
          -- IPs are shared (offices, mobile carriers), so only recent ones count.
          AND (name_key = $2 OR device_id = $4
               OR (client_ip = $3 AND created_at > NOW() - INTERVAL '30 days'))
        ORDER BY (name_key = $2) DESC NULLS LAST, (device_id = $4) DESC NULLS LAST
        LIMIT 1`,
      [userId, key, ip, deviceId]
    );
    const matched = match.rows[0] as { user_id: string; reason: string } | undefined;
    const status = matched ? 'pending_review' : 'credited';

    // user_id and card_masked_pan are unique: one claim per account and per card.
    const inserted = await this.db.query(
      `INSERT INTO welcome_bonus_claims
         (user_id, card_masked_pan, invoice_id, amount_uah, status, name_key, client_ip, device_id, match_reason, matched_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT DO NOTHING RETURNING user_id`,
      [userId, maskedPan, invoiceId, WELCOME_BONUS_UAH, status, key, ip, deviceId,
       matched?.reason ?? null, matched?.user_id ?? null]
    );
    if (inserted.rows.length === 0) {
      return (await this.status(userId)) !== 'available' ? 'already_claimed' : 'card_used';
    }

    if (matched) {
      logger.warn('[WelcomeBonus] Held for review: looks like an earlier claimant', {
        userId, matchedUserId: matched.user_id, reason: matched.reason,
      });
      return 'pending_review';
    }

    try {
      await this.credit(userId, invoiceId);
    } catch (err) {
      // Free the claim so a retry can succeed.
      await this.db.query('DELETE FROM welcome_bonus_claims WHERE user_id = $1', [userId]).catch(() => {});
      throw err;
    }
    return 'credited';
  }

  /** Claims waiting for an administrator, with both accounts for comparison. */
  async listPending(): Promise<any[]> {
    const r = await this.db.query(
      `SELECT c.user_id, u.email, u.name, c.card_masked_pan, c.client_ip, c.match_reason,
              c.matched_user_id, mu.email AS matched_email, mu.name AS matched_name,
              m.card_masked_pan AS matched_card, c.created_at
         FROM welcome_bonus_claims c
         JOIN users u ON u.id = c.user_id
         LEFT JOIN users mu ON mu.id = c.matched_user_id
         LEFT JOIN welcome_bonus_claims m ON m.user_id = c.matched_user_id
        WHERE c.status = 'pending_review'
        ORDER BY c.created_at ASC`
    );
    return r.rows;
  }

  /** Approve a held claim and credit the bonus. False if nothing was pending. */
  async approve(userId: string, adminId: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE welcome_bonus_claims SET status = 'credited', reviewed_at = NOW(), reviewed_by = $2
        WHERE user_id = $1 AND status = 'pending_review' RETURNING invoice_id`,
      [userId, adminId]
    );
    if (!r.rows.length) return false;
    try {
      await this.credit(userId, r.rows[0].invoice_id);
    } catch (err) {
      await this.db.query(
        `UPDATE welcome_bonus_claims SET status = 'pending_review', reviewed_at = NULL, reviewed_by = NULL WHERE user_id = $1`,
        [userId]
      ).catch(() => {});
      throw err;
    }
    return true;
  }

  /** Reject a held claim: the account and the card stay used, no bonus. */
  async reject(userId: string, adminId: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE welcome_bonus_claims SET status = 'rejected', reviewed_at = NOW(), reviewed_by = $2
        WHERE user_id = $1 AND status = 'pending_review' RETURNING user_id`,
      [userId, adminId]
    );
    return r.rows.length > 0;
  }

  private async credit(userId: string, invoiceId: string | null): Promise<void> {
    await this.billingService.getOrCreateUserBilling(userId);
    const amountUsd = await this.billingService.convertFromUah(WELCOME_BONUS_UAH);
    await this.billingService.topUpBalance({
      userId,
      amountUsd,
      amountUah: WELCOME_BONUS_UAH,
      description: `Вітальний бонус за прив'язку картки: ${WELCOME_BONUS_UAH} грн`,
      paymentProvider: 'adjustment',
      paymentId: `welcome-${userId}`,
      metadata: { invoiceId },
    });
    logger.info('[WelcomeBonus] Credited', { userId, amountUah: WELCOME_BONUS_UAH });
  }
}
