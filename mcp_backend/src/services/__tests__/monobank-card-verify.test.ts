/**
 * Welcome bonus via card verification: a 1 UAH invoice that is refunded,
 * one bonus per account and per card.
 */
import { MonobankService } from '../monobank-service';

function setup(opts: { claimInserted?: boolean; hasClaim?: boolean; maskedPan?: string | null } = {}) {
  const { claimInserted = true, hasClaim = false, maskedPan = '444403******1902' } = opts;
  const billing = {
    topUpBalance: jest.fn().mockResolvedValue({ id: 'txn-1' }),
    getOrCreateUserBilling: jest.fn().mockResolvedValue({}),
    convertFromUah: jest.fn().mockResolvedValue(10.4),
    savePaymentMethod: jest.fn().mockResolvedValue(undefined),
    setTransactionInvoiceNumber: jest.fn(),
  };
  const db = {
    query: jest.fn(async (sql: string) => {
      if (sql.startsWith('INSERT INTO welcome_bonus_claims')) return { rows: claimInserted ? [{ user_id: 'u1' }] : [] };
      if (sql.startsWith('SELECT 1 FROM welcome_bonus_claims')) return { rows: hasClaim ? [{}] : [] };
      return { rows: [] };
    }),
  };
  const service = new MonobankService(billing as any, {} as any, db as any);
  const fetchMock = jest.fn(async (url: string) => {
    if (url.includes('/invoice/status')) {
      return { ok: true, json: async () => ({ status: 'success', paymentInfo: maskedPan ? { maskedPan, paymentSystem: 'visa' } : {} }) };
    }
    return { ok: true, json: async () => ({}), text: async () => '' };
  });
  (global as any).fetch = fetchMock;
  process.env.MONOBANK_API_KEY = 'k';
  return { service, billing, db, fetchMock };
}

const PI = { id: 'pi-1', user_id: 'u1', metadata: { purpose: 'card_verify' } };
const cancelled = (f: jest.Mock) => f.mock.calls.some(([u]) => String(u).includes('/invoice/cancel'));

describe('MonobankService card verification', () => {
  it('credits the welcome bonus and refunds the 1 UAH', async () => {
    const { service, billing, fetchMock } = setup();
    await expect(service.processCardVerification(PI, 'inv-1')).resolves.toBe('credited');
    expect(billing.topUpBalance).toHaveBeenCalledTimes(1);
    expect(billing.topUpBalance.mock.calls[0][0]).toMatchObject({ amountUah: 430, paymentId: 'welcome-u1' });
    expect(cancelled(fetchMock)).toBe(true);
  });

  it('gives no bonus when the card already claimed one on another account', async () => {
    const { service, billing, fetchMock } = setup({ claimInserted: false, hasClaim: false });
    await expect(service.processCardVerification(PI, 'inv-1')).resolves.toBe('card_used');
    expect(billing.topUpBalance).not.toHaveBeenCalled();
    expect(cancelled(fetchMock)).toBe(true);
  });

  it('gives no second bonus to the same account', async () => {
    const { service, billing } = setup({ claimInserted: false, hasClaim: true });
    await expect(service.processCardVerification(PI, 'inv-1')).resolves.toBe('already_claimed');
    expect(billing.topUpBalance).not.toHaveBeenCalled();
  });

  it('still refunds when Monobank returns no card data', async () => {
    const { service, billing, fetchMock } = setup({ maskedPan: null });
    await expect(service.processCardVerification(PI, 'inv-1')).resolves.toBe('no_card');
    expect(billing.topUpBalance).not.toHaveBeenCalled();
    expect(cancelled(fetchMock)).toBe(true);
  });

  it('frees the claim when crediting fails so a retry can succeed', async () => {
    const { service, billing, db } = setup();
    billing.topUpBalance.mockRejectedValueOnce(new Error('db down'));
    await expect(service.processCardVerification(PI, 'inv-1')).resolves.toBe('failed');
    expect(db.query.mock.calls.some(([sql]: [string]) => sql.startsWith('DELETE FROM welcome_bonus_claims'))).toBe(true);
  });

  it('refuses to open a verification invoice once the bonus was claimed', async () => {
    const { service } = setup({ hasClaim: true });
    await expect(service.createCardVerifyInvoice('u1')).rejects.toThrow('WELCOME_BONUS_ALREADY_CLAIMED');
  });
});
