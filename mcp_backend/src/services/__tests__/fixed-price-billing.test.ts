import { FixedPriceBilling } from '../fixed-price-billing';
import { getFixedToolPrice, resetFixedToolPriceCache, formatMoney } from '../tool-fixed-price';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

type Row = Record<string, any>;

/** In-memory stand-in for the two tables FixedPriceBilling touches. */
function fakeDb(account: Row | null) {
  const state = { account: account ? { ...account } : null as Row | null, transactions: [] as Row[] };
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    if (sql.startsWith('SELECT currency')) {
      return { rows: state.account ? [state.account] : [] };
    }
    if (sql.includes('INSERT INTO user_billing')) {
      state.account = { currency: params[1], balance_usd: '0.00', balance_uah: '0.00', billing_enabled: true, is_active: true };
      return { rows: [state.account] };
    }
    if (sql.includes('UPDATE user_billing') && sql.includes('balance_usd - $1')) {
      state.account!.balance_usd = (Number(state.account!.balance_usd) - params[0]).toFixed(2);
      return { rows: [] };
    }
    if (sql.includes('UPDATE user_billing') && sql.includes('balance_usd + $1')) {
      state.account!.balance_usd = (Number(state.account!.balance_usd) + params[0]).toFixed(2);
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO billing_transactions')) {
      state.transactions.push({ sql, params });
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const db = { query, transaction: async (cb: any) => cb({ query }) };
  return { db, state, query };
}

const GBP_2P = { amount: 0.02, currency: 'GBP' as const };
const gbpAccount = (balance: string, extra: Row = {}) => ({
  currency: 'GBP', balance_usd: balance, balance_uah: '0.00', billing_enabled: true, is_active: true, ...extra,
});

describe('FixedPriceBilling.preflight', () => {
  it('allows a call when the GBP balance covers the price', async () => {
    const { db } = fakeDb(gbpAccount('100.00'));
    await expect(new FixedPriceBilling(db).preflight('u1', 'uk_get_act', GBP_2P))
      .resolves.toEqual({ allowed: true, billingEnabled: true });
  });

  it('refuses with a £ message when the balance is short', async () => {
    const { db } = fakeDb(gbpAccount('0.01'));
    const res = await new FixedPriceBilling(db).preflight('u1', 'uk_get_act', GBP_2P);
    expect(res).toEqual({ allowed: false, message: 'Error: Insufficient balance. Required: £0.02, current balance: £0.01' });
  });

  it('refuses a GBP-priced tool on a USD account instead of charging dollars', async () => {
    const { db } = fakeDb(gbpAccount('100.00', { currency: 'USD' }));
    const res = await new FixedPriceBilling(db).preflight('u1', 'uk_get_act', GBP_2P);
    expect(res.allowed).toBe(false);
  });

  it('lets the call run uncharged when billing is disabled', async () => {
    const { db } = fakeDb(gbpAccount('0.00', { billing_enabled: false }));
    await expect(new FixedPriceBilling(db).preflight('u1', 'uk_get_act', GBP_2P))
      .resolves.toEqual({ allowed: true, billingEnabled: false });
  });

  it('creates a missing account in BILLING_DEFAULT_CURRENCY', async () => {
    process.env.BILLING_DEFAULT_CURRENCY = 'GBP';
    const { db, state } = fakeDb(null);
    await new FixedPriceBilling(db).preflight('u1', 'uk_get_act', { amount: 0.02, currency: 'USD' });
    expect(state.account!.currency).toBe('GBP');
    delete process.env.BILLING_DEFAULT_CURRENCY;
  });
});

describe('FixedPriceBilling.charge', () => {
  it('deducts exactly the fixed price and books a GBP transaction', async () => {
    const { db, state } = fakeDb(gbpAccount('100.00'));
    const after = await new FixedPriceBilling(db).charge({ userId: 'u1', requestId: 'r1', toolName: 'uk_get_act', price: GBP_2P });
    expect(after).toBe(99.98);
    expect(state.account!.balance_usd).toBe('99.98');
    expect(state.transactions).toHaveLength(1);
    const params = state.transactions[0].params;
    expect(params[1]).toBe(0.02); // amount
    expect(params[2]).toBe(100); // balance before
    expect(params[3]).toBe(99.98); // balance after
    expect(params[params.length - 1]).toBe('GBP'); // currency
  });

  it('charges nothing when billing is disabled', async () => {
    const { db, state } = fakeDb(gbpAccount('100.00', { billing_enabled: false }));
    await expect(new FixedPriceBilling(db).charge({ userId: 'u1', requestId: 'r1', toolName: 'uk_get_act', price: GBP_2P }))
      .resolves.toBeNull();
    expect(state.transactions).toHaveLength(0);
    expect(state.account!.balance_usd).toBe('100.00');
  });

  it('charges nothing on a currency mismatch', async () => {
    const { db, state } = fakeDb(gbpAccount('100.00', { currency: 'USD' }));
    await expect(new FixedPriceBilling(db).charge({ userId: 'u1', requestId: 'r1', toolName: 'uk_get_act', price: GBP_2P }))
      .resolves.toBeNull();
    expect(state.transactions).toHaveLength(0);
  });
});

describe('FixedPriceBilling.topUp', () => {
  it('credits a GBP account in GBP', async () => {
    const { db, state } = fakeDb(gbpAccount('0.00'));
    const after = await new FixedPriceBilling(db).topUp({
      userId: 'u1', amount: 100, currency: 'GBP', description: 'Initial credit £100', paymentProvider: 'manual',
    });
    expect(after).toBe(100);
    expect(state.account!.balance_usd).toBe('100.00');
    expect(state.transactions[0].params[state.transactions[0].params.length - 1]).toBe('GBP');
  });

  it('refuses to credit a different currency', async () => {
    const { db } = fakeDb(gbpAccount('0.00'));
    await expect(new FixedPriceBilling(db).topUp({
      userId: 'u1', amount: 100, currency: 'USD', description: 'x', paymentProvider: 'manual',
    })).rejects.toThrow('Account is billed in GBP, cannot credit USD');
  });
});

describe('getFixedToolPrice', () => {
  beforeEach(() => resetFixedToolPriceCache());

  it('returns the price of a fixed-price tool and null for a usage-billed one', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ tool_name: 'uk_get_act', fixed_price: '0.02', fixed_price_currency: 'GBP' }] }) };
    await expect(getFixedToolPrice(db, 'uk_get_act')).resolves.toEqual({ amount: 0.02, currency: 'GBP' });
    await expect(getFixedToolPrice(db, 'search_court_decisions')).resolves.toBeNull();
    expect(db.query).toHaveBeenCalledTimes(1); // cached
  });

  it('degrades to usage billing when the lookup fails', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('column "fixed_price" does not exist')) };
    await expect(getFixedToolPrice(db, 'uk_get_act')).resolves.toBeNull();
  });

  it('formats money with the currency symbol', () => {
    expect(formatMoney(0.02, 'GBP')).toBe('£0.02');
    expect(formatMoney(3, 'USD')).toBe('$3.00');
  });
});
