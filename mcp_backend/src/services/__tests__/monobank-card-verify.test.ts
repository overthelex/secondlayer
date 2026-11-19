/**
 * Card link with the welcome bonus: the customer pays 200 UAH, which is credited
 * to the balance and not refunded, and gets a 200 UAH bonus on top once per
 * person (account, card, and a review for look-alike claims). Invoices from the
 * earlier 1 UAH check are still refunded.
 */
import { MonobankService } from '../monobank-service';
import { nameKey, normalizeDeviceId } from '../welcome-bonus-service';

interface Setup {
  claimInserted?: boolean;
  existingStatus?: string | null;
  maskedPan?: string | null;
  match?: { user_id: string; reason: string } | null;
  userName?: string;
}

function setup(opts: Setup = {}) {
  const {
    claimInserted = true, existingStatus = null, maskedPan = '444403******1902',
    match = null, userName = 'Іван Петренко',
  } = opts;
  const billing = {
    topUpBalance: jest.fn().mockResolvedValue({ id: 'txn-1' }),
    getOrCreateUserBilling: jest.fn().mockResolvedValue({}),
    convertFromUah: jest.fn().mockResolvedValue(10.4),
    savePaymentMethod: jest.fn().mockResolvedValue(undefined),
    setTransactionInvoiceNumber: jest.fn(),
  };
  const db = {
    query: jest.fn(async (sql: string, _params?: unknown[]) => {
      const q = sql.trim();
      if (q.startsWith('SELECT name FROM users')) return { rows: [{ name: userName }] };
      if (q.startsWith('SELECT user_id,')) return { rows: match ? [match] : [] };
      if (q.startsWith('INSERT INTO welcome_bonus_claims')) return { rows: claimInserted ? [{ user_id: 'u1' }] : [] };
      if (q.startsWith('SELECT status FROM welcome_bonus_claims')) return { rows: existingStatus ? [{ status: existingStatus }] : [] };
      if (q.startsWith('UPDATE welcome_bonus_claims SET status = \'credited\'')) return { rows: [{ invoice_id: 'inv-1' }] };
      if (q.startsWith('INSERT INTO payment_intents')) return { rows: [{ id: 'pi-9' }] };
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

const PI = {
  id: 'pi-1', user_id: 'u1', amount_uah: '200.00',
  metadata: { purpose: 'card_verify', card_link: 'paid', client_ip: '203.0.113.7', device_id: 'dev-12345678' },
};
const LEGACY_PI = { id: 'pi-0', user_id: 'u1', amount_uah: '1.00', metadata: { purpose: 'card_verify', client_ip: '203.0.113.7' } };
const cancelled = (f: jest.Mock) => f.mock.calls.some(([u]) => String(u).includes('/invoice/cancel'));
const insertParams = (db: any) => db.query.mock.calls.find(([sql]: any[]) => String(sql).trim().startsWith('INSERT INTO welcome_bonus_claims'))?.[1];
const topUps = (billing: any) => billing.topUpBalance.mock.calls.map(([arg]: any[]) => arg);
const PAYMENT = { amountUah: 200, paymentProvider: 'monobank', paymentId: 'pi-1' };
const BONUS = { amountUah: 200, paymentProvider: 'adjustment', paymentId: 'welcome-u1' };

describe('MonobankService card link', () => {
  it('credits the 200 UAH payment and the 200 UAH bonus, and refunds nothing', async () => {
    const { service, billing, fetchMock, db } = setup();
    await expect(service.processCardVerification(PI, 'inv-1')).resolves.toBe('credited');
    expect(topUps(billing)).toEqual([expect.objectContaining(PAYMENT), expect.objectContaining(BONUS)]);
    expect(billing.setTransactionInvoiceNumber).toHaveBeenCalledTimes(1);
    expect(cancelled(fetchMock)).toBe(false);
    // signals stored with the claim
    expect(insertParams(db)).toEqual(expect.arrayContaining(['credited', 'петренко іван', '203.0.113.7', 'dev-12345678']));
  });

  it('credits the payment but holds the bonus for review when the claim looks like an earlier claimant', async () => {
    const { service, billing, fetchMock, db } = setup({ match: { user_id: 'u0', reason: 'name' } });
    await expect(service.processCardVerification(PI, 'inv-1')).resolves.toBe('pending_review');
    expect(topUps(billing)).toEqual([expect.objectContaining(PAYMENT)]);
    expect(cancelled(fetchMock)).toBe(false);
    expect(insertParams(db)).toEqual(expect.arrayContaining(['pending_review', 'name', 'u0']));
  });

  it('credits the payment without a bonus when the card already claimed one on another account', async () => {
    const { service, billing, fetchMock } = setup({ claimInserted: false });
    await expect(service.processCardVerification(PI, 'inv-1')).resolves.toBe('card_used');
    expect(topUps(billing)).toEqual([expect.objectContaining(PAYMENT)]);
    expect(cancelled(fetchMock)).toBe(false);
  });

  it('gives no second bonus to the same account', async () => {
    const { service, billing } = setup({ claimInserted: false, existingStatus: 'credited' });
    await expect(service.processCardVerification(PI, 'inv-1')).resolves.toBe('already_claimed');
    expect(topUps(billing)).toEqual([expect.objectContaining(PAYMENT)]);
  });

  it('credits the payment when Monobank returns no card data', async () => {
    const { service, billing, fetchMock } = setup({ maskedPan: null });
    await expect(service.processCardVerification(PI, 'inv-1')).resolves.toBe('no_card');
    expect(topUps(billing)).toEqual([expect.objectContaining(PAYMENT)]);
    expect(cancelled(fetchMock)).toBe(false);
  });

  it('still claims the bonus when crediting the payment fails', async () => {
    const { service, billing } = setup();
    billing.topUpBalance.mockRejectedValueOnce(new Error('db down'));
    await expect(service.processCardVerification(PI, 'inv-1')).resolves.toBe('credited');
    expect(topUps(billing)[1]).toMatchObject(BONUS);
  });

  it('frees the claim when crediting the bonus fails so a retry can succeed', async () => {
    const { service, billing, db } = setup();
    billing.topUpBalance
      .mockResolvedValueOnce({ id: 'txn-1' })
      .mockRejectedValueOnce(new Error('db down'));
    await expect(service.processCardVerification(PI, 'inv-1')).resolves.toBe('failed');
    expect(db.query.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM welcome_bonus_claims'))).toBe(true);
  });

  it('refunds an earlier 1 UAH check and credits only the bonus', async () => {
    const { service, billing, fetchMock } = setup();
    await expect(service.processCardVerification(LEGACY_PI, 'inv-0')).resolves.toBe('credited');
    expect(topUps(billing)).toEqual([expect.objectContaining(BONUS)]);
    expect(cancelled(fetchMock)).toBe(true);
  });

  it('opens a 200 UAH card-link invoice marked as paid', async () => {
    const { service, db, fetchMock } = setup();
    process.env.PUBLIC_URL = 'https://legal.org.ua';
    fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ invoiceId: 'inv-9', pageUrl: 'https://pay/x' }) }) as any);
    await service.createCardVerifyInvoice('u1', 'a@b.c');
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any[])[1]?.body));
    expect(body.amount).toBe(20000);
    expect(body.merchantPaymInfo.destination).toContain('не повертається');
    const pi: any[] = db.query.mock.calls.find(([sql]: any[]) => String(sql).includes('INSERT INTO payment_intents'))!;
    expect(JSON.parse(String((pi[1] as any[])[4])).card_link).toBe('paid');
  });

  it('refuses to open a card-link invoice once the account has a claim', async () => {
    const { service } = setup({ existingStatus: 'pending_review' });
    await expect(service.createCardVerifyInvoice('u1')).rejects.toThrow('WELCOME_BONUS_ALREADY_CLAIMED');
  });

  it('approving a held claim credits the bonus', async () => {
    const { service, billing } = setup();
    await expect(service.welcomeBonus.approve('u1', 'admin-1')).resolves.toBe(true);
    expect(billing.topUpBalance).toHaveBeenCalledTimes(1);
  });
});

describe('nameKey', () => {
  it('ignores case, word order and apostrophes', () => {
    expect(nameKey('Петренко  Іван')).toBe(nameKey('іван петренко'));
    expect(nameKey("Ковальчук Мар'яна")).toBe(nameKey('марʼяна КОВАЛЬЧУК'));
  });
  it('returns null for one word and placeholder names', () => {
    expect(nameKey('vovkes')).toBeNull();
    expect(nameKey('Дія Користувач')).toBeNull();
    expect(nameKey('Дія Користувач Тестовий')).toBeNull();
    expect(nameKey('')).toBeNull();
  });
});

describe('normalizeDeviceId', () => {
  it('accepts uuid-like ids and rejects junk', () => {
    expect(normalizeDeviceId('3f2b6c1e-9a7d-4c1b-8e2f-0a1b2c3d4e5f')).toBe('3f2b6c1e-9a7d-4c1b-8e2f-0a1b2c3d4e5f');
    expect(normalizeDeviceId('<script>')).toBeNull();
    expect(normalizeDeviceId(42)).toBeNull();
  });
});
