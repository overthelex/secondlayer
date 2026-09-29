/**
 * Billing for tools with a fixed per-call price (tool_pricing.fixed_price, migration 223).
 *
 * Why this is separate from BillingService: BillingService is overlaid from the private
 * secondlayer-core repo at build time and serves every usage-billed tool on legal.org.ua.
 * Fixed-price tools (today the lawrider.uk statute-book tools, priced in GBP) are billed
 * here instead, against the same user_billing / billing_transactions tables, so that the
 * usage path stays exactly as it was.
 *
 * Ledger rules (see migration 223): user_billing.currency is the account currency and
 * balance_usd / total_spent_usd hold amounts in that currency despite their names. A
 * fixed price is charged only to an account in the same currency, with no markup, and the
 * UAH columns are left untouched.
 */

import { logger } from '../utils/logger.js';
import { BillingCurrency, FixedToolPrice, Queryable, formatMoney } from './tool-fixed-price.js';

export interface TransactionalDb extends Queryable {
  transaction<T>(callback: (client: Queryable) => Promise<T>): Promise<T>;
}

export type FixedPricePreflight =
  | { allowed: true; billingEnabled: boolean }
  | { allowed: false; message: string };

interface AccountRow {
  currency: BillingCurrency;
  balance: number;
  balanceUah: number;
  billingEnabled: boolean;
  isActive: boolean;
}

function toAccount(row: any): AccountRow {
  return {
    currency: (String(row.currency || 'USD').trim().toUpperCase() as BillingCurrency),
    balance: Number(row.balance_usd) || 0,
    balanceUah: Number(row.balance_uah) || 0,
    billingEnabled: row.billing_enabled === true,
    isActive: row.is_active !== false,
  };
}

/** Currency for accounts this service has to create: BILLING_DEFAULT_CURRENCY, else the price's. */
function newAccountCurrency(price: FixedToolPrice): BillingCurrency {
  const env = process.env.BILLING_DEFAULT_CURRENCY?.trim().toUpperCase();
  return env === 'GBP' || env === 'USD' ? env : price.currency;
}

export class FixedPriceBilling {
  constructor(private db: TransactionalDb) {}

  private async getOrCreateAccount(userId: string, price: FixedToolPrice): Promise<AccountRow> {
    const existing = await this.db.query(
      'SELECT currency, balance_usd, balance_uah, billing_enabled, is_active FROM user_billing WHERE user_id = $1',
      [userId]
    );
    if (existing.rows.length > 0) return toAccount(existing.rows[0]);

    const created = await this.db.query(
      `INSERT INTO user_billing (user_id, currency)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING currency, balance_usd, balance_uah, billing_enabled, is_active`,
      [userId, newAccountCurrency(price)]
    );
    logger.info('[FixedPriceBilling] Created billing account', { userId, currency: created.rows[0]?.currency });
    return toAccount(created.rows[0]);
  }

  /** Decide before execution whether the call may run. Never charges. */
  async preflight(userId: string, toolName: string, price: FixedToolPrice): Promise<FixedPricePreflight> {
    const account = await this.getOrCreateAccount(userId, price);
    if (!account.billingEnabled || !account.isActive) {
      return { allowed: true, billingEnabled: false };
    }
    if (account.currency !== price.currency) {
      return {
        allowed: false,
        message: `Error: ${toolName} is priced in ${price.currency} but your account is billed in ${account.currency}. Contact support to switch the account currency.`,
      };
    }
    if (account.balance < price.amount) {
      return {
        allowed: false,
        message: `Error: Insufficient balance. Required: ${formatMoney(price.amount, price.currency)}, current balance: ${formatMoney(account.balance, account.currency)}`,
      };
    }
    return { allowed: true, billingEnabled: true };
  }

  /**
   * Charge one successful call. Returns the new balance, or null when nothing was charged
   * (billing disabled, account inactive or in another currency).
   */
  async charge(params: {
    userId: string;
    requestId: string;
    toolName: string;
    price: FixedToolPrice;
  }): Promise<number | null> {
    const { userId, requestId, toolName, price } = params;
    return this.db.transaction(async (client) => {
      const locked = await client.query(
        'SELECT currency, balance_usd, balance_uah, billing_enabled, is_active FROM user_billing WHERE user_id = $1 FOR UPDATE',
        [userId]
      );
      if (locked.rows.length === 0) {
        logger.warn('[FixedPriceBilling] No billing account, call not charged', { userId, toolName, requestId });
        return null;
      }
      const account = toAccount(locked.rows[0]);
      if (!account.billingEnabled || !account.isActive) return null;
      if (account.currency !== price.currency) {
        logger.warn('[FixedPriceBilling] Currency mismatch, call not charged', {
          userId, toolName, requestId, account: account.currency, price: price.currency,
        });
        return null;
      }

      const balanceAfter = Number((account.balance - price.amount).toFixed(2));
      await client.query(
        `UPDATE user_billing
            SET balance_usd = balance_usd - $1,
                total_spent_usd = total_spent_usd + $1,
                total_requests = total_requests + 1,
                updated_at = NOW()
          WHERE user_id = $2`,
        [price.amount, userId]
      );
      await client.query(
        `INSERT INTO billing_transactions (
           user_id, type, amount_usd, amount_uah,
           balance_before_usd, balance_after_usd,
           balance_before_uah, balance_after_uah,
           request_id, description, metadata, currency
         ) VALUES ($1, 'charge', $2, 0, $3, $4, $5, $5, $6, $7, $8, $9)`,
        [
          userId,
          price.amount,
          account.balance,
          balanceAfter,
          account.balanceUah,
          requestId,
          `${toolName}: fixed price ${formatMoney(price.amount, price.currency)}`,
          JSON.stringify({ pricing: 'fixed', tool_name: toolName, fixed_price: price.amount, currency: price.currency }),
          price.currency,
        ]
      );
      logger.info('[FixedPriceBilling] Charged', {
        userId, toolName, requestId,
        charged: formatMoney(price.amount, price.currency),
        balanceAfter: formatMoney(balanceAfter, price.currency),
      });
      return balanceAfter;
    });
  }

  /**
   * Credit an account in its own currency (manual credit or a payment provider). The
   * amount must be in the account currency; there is no conversion.
   */
  async topUp(params: {
    userId: string;
    amount: number;
    currency: BillingCurrency;
    description: string;
    paymentProvider: string;
    paymentId?: string;
  }): Promise<number> {
    const { userId, amount, currency } = params;
    if (!(amount > 0)) throw new Error('Top-up amount must be positive');
    return this.db.transaction(async (client) => {
      const locked = await client.query(
        'SELECT currency, balance_usd, balance_uah, billing_enabled, is_active FROM user_billing WHERE user_id = $1 FOR UPDATE',
        [userId]
      );
      if (locked.rows.length === 0) throw new Error('User billing account not found');
      const account = toAccount(locked.rows[0]);
      if (account.currency !== currency) {
        throw new Error(`Account is billed in ${account.currency}, cannot credit ${currency}`);
      }
      const balanceAfter = Number((account.balance + amount).toFixed(2));
      await client.query(
        'UPDATE user_billing SET balance_usd = balance_usd + $1, updated_at = NOW() WHERE user_id = $2',
        [amount, userId]
      );
      await client.query(
        `INSERT INTO billing_transactions (
           user_id, type, amount_usd, amount_uah,
           balance_before_usd, balance_after_usd,
           balance_before_uah, balance_after_uah,
           payment_provider, payment_id, description, metadata, currency
         ) VALUES ($1, 'topup', $2, 0, $3, $4, $5, $5, $6, $7, $8, $9, $10)`,
        [
          userId,
          amount,
          account.balance,
          balanceAfter,
          account.balanceUah,
          params.paymentProvider,
          params.paymentId ?? null,
          params.description,
          JSON.stringify({ currency }),
          currency,
        ]
      );
      logger.info('[FixedPriceBilling] Topped up', { userId, amount: formatMoney(amount, currency), balanceAfter });
      return balanceAfter;
    });
  }
}
