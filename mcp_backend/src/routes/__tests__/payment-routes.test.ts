/**
 * Payment Routes Tests
 *
 * Tests cover:
 * - POST /monobank/create: validation, invoice creation, error handling
 * - GET /monobank/:invoiceId/status: status polling
 * - GET /available-providers: provider list with crypto tag check
 * - POST /webhooks/monobank: signature verification, webhook processing, escrow integration
 * - POST /webhooks/nowpayments: signature verification
 * - Generic status endpoint: provider routing
 */

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createPaymentRouter, createWebhookRouter } from '../payment-routes';
import { logger } from '../../utils/logger.js';

// The routes deliberately do not echo internal errors to the caller: a Monobank
// 403, a failed signature check and a dropped database connection all come back
// as "An unexpected error occurred" while the real text goes to the log. These
// tests were written against the older, leaky behaviour and asserted the detail
// in the RESPONSE, which is exactly what must not be there — so they now assert
// both halves: the client learns nothing, the log learns everything.
jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

// ⚠ Cleared before every test. Without this the mock accumulates across the whole
// file, so `loggedText()` would see what EARLIER tests logged and pass even if the
// route under test stopped logging entirely — the same "green for the wrong reason"
// failure this file is being repaired for. Only the logger is cleared: the service
// doubles are configured per test and clearing them all would empty that setup.
beforeEach(() => {
  (logger.error as jest.Mock).mockClear();
});

const loggedText = () =>
  (logger.error as jest.Mock).mock.calls
    .map((c) => JSON.stringify(c))
    .join(' ');

// ──────────────────────────────────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────────────────────────────────

const TEST_USER = { userId: 'user-test-001', email: 'test@example.com' };
const INVOICE_ID = 'mono-inv-test-001';

function mockAuth(req: any, _res: Response, next: NextFunction) {
  req.user = TEST_USER;
  next();
}

function makeMonobankService(overrides: any = {}) {
  return {
    createInvoice: jest.fn().mockResolvedValue({
      invoiceId: INVOICE_ID,
      pageUrl: `https://pay.mbnk.biz/${INVOICE_ID}`,
      paymentIntentId: 'pi-test-001',
    }),
    getPaymentStatus: jest.fn().mockResolvedValue({
      status: 'success',
      amount: 100,
      currency: 'UAH',
      invoiceId: INVOICE_ID,
    }),
    handleWebhook: jest.fn().mockResolvedValue({ received: true }),
    ...overrides,
  };
}

function makeMetaMaskService(overrides: any = {}) {
  return {
    getPaymentStatus: jest.fn().mockResolvedValue({ status: 'pending' }),
    createPaymentIntent: jest.fn().mockResolvedValue({ paymentIntentId: 'mm-001' }),
    verifyTransaction: jest.fn().mockResolvedValue({ verified: true }),
    ...overrides,
  };
}

function makeBinancePayService(overrides: any = {}) {
  return {
    getPaymentStatus: jest.fn().mockResolvedValue({ status: 'pending' }),
    createOrder: jest.fn().mockResolvedValue({ orderId: 'bp-001' }),
    handleWebhook: jest.fn().mockResolvedValue({ received: true }),
    ...overrides,
  };
}

function makeNOWPaymentsService(overrides: any = {}) {
  return {
    createInvoice: jest.fn().mockResolvedValue({ invoiceId: 'np-001', invoiceUrl: 'https://nowpayments.io/np-001' }),
    getPaymentStatus: jest.fn().mockResolvedValue({ status: 'waiting' }),
    handleWebhook: jest.fn().mockResolvedValue({ received: true }),
    ...overrides,
  };
}

function makeDb(overrides: any = {}) {
  return {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    ...overrides,
  };
}

function makeConsultationPaymentService(overrides: any = {}) {
  return {
    handleWebhook: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function buildPaymentApp(serviceOverrides: any = {}) {
  const app = express();
  app.use(express.json());

  const monobank = makeMonobankService(serviceOverrides.monobank);
  const metamask = makeMetaMaskService(serviceOverrides.metamask);
  const binance = makeBinancePayService(serviceOverrides.binance);
  const nowpayments = makeNOWPaymentsService(serviceOverrides.nowpayments);
  const db = makeDb(serviceOverrides.db);

  const paymentRouter = createPaymentRouter(monobank as any, metamask as any, binance as any, nowpayments as any, db as any);
  app.use('/api/billing/payment', mockAuth, paymentRouter);

  return { app, monobank, metamask, binance, nowpayments, db };
}

function buildWebhookApp(serviceOverrides: any = {}) {
  const app = express();
  // Webhook routes expect raw body for signature verification
  app.use('/webhooks', express.raw({ type: '*/*' }));

  const monobank = makeMonobankService(serviceOverrides.monobank);
  const binance = makeBinancePayService(serviceOverrides.binance);
  const nowpayments = makeNOWPaymentsService(serviceOverrides.nowpayments);
  const consultationPayment = makeConsultationPaymentService(serviceOverrides.consultationPayment);

  const webhookRouter = createWebhookRouter(monobank as any, binance as any, nowpayments as any, consultationPayment as any);
  app.use('/webhooks', webhookRouter);

  return { app, monobank, binance, nowpayments, consultationPayment };
}

// ──────────────────────────────────────────────────────────────────────────
// POST /api/billing/payment/monobank/create
// ──────────────────────────────────────────────────────────────────────────

describe('POST /api/billing/payment/monobank/create', () => {
  it('creates invoice with valid amount', async () => {
    const { app, monobank } = buildPaymentApp();

    const res = await request(app)
      .post('/api/billing/payment/monobank/create')
      .send({ amount_uah: 150 });

    expect(res.status).toBe(200);
    expect(res.body.invoiceId).toBe(INVOICE_ID);
    expect(res.body.pageUrl).toContain('pay.mbnk.biz');
    expect(res.body.paymentIntentId).toBe('pi-test-001');

    expect(monobank.createInvoice).toHaveBeenCalledWith(
      TEST_USER.userId,
      150,
      expect.stringContaining('150 ₴'),
      undefined,
      TEST_USER.email
    );
  });

  it('rejects missing amount_uah', async () => {
    const { app } = buildPaymentApp();

    const res = await request(app)
      .post('/api/billing/payment/monobank/create')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('amount_uah');
  });

  it('rejects non-number amount_uah', async () => {
    const { app } = buildPaymentApp();

    const res = await request(app)
      .post('/api/billing/payment/monobank/create')
      .send({ amount_uah: 'not a number' });

    expect(res.status).toBe(400);
  });

  it('returns 500 on service error', async () => {
    const { app } = buildPaymentApp({
      monobank: { createInvoice: jest.fn().mockRejectedValue(new Error('Monobank API error: 403')) },
    });

    const res = await request(app)
      .post('/api/billing/payment/monobank/create')
      .send({ amount_uah: 100 });

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('An unexpected error occurred');
    expect(JSON.stringify(res.body)).not.toContain('403');
    expect(loggedText()).toContain('403');
  });

  it('passes redirect_url to service', async () => {
    const { app, monobank } = buildPaymentApp();

    await request(app)
      .post('/api/billing/payment/monobank/create')
      .send({ amount_uah: 100, redirect_url: 'https://custom.redirect.com/done' });

    expect(monobank.createInvoice).toHaveBeenCalledWith(
      TEST_USER.userId,
      100,
      expect.any(String),
      'https://custom.redirect.com/done',
      TEST_USER.email
    );
  });

  it('rejects zero amount', async () => {
    const { app } = buildPaymentApp();

    const res = await request(app)
      .post('/api/billing/payment/monobank/create')
      .send({ amount_uah: 0 });

    expect(res.status).toBe(400);
  });

  it('rejects negative amount', async () => {
    const { app } = buildPaymentApp();

    const res = await request(app)
      .post('/api/billing/payment/monobank/create')
      .send({ amount_uah: -50 });

    expect(res.status).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/billing/payment/monobank/:invoiceId/status
// ──────────────────────────────────────────────────────────────────────────

describe('GET /api/billing/payment/monobank/:invoiceId/status', () => {
  it('returns payment status', async () => {
    const { app } = buildPaymentApp();

    const res = await request(app)
      .get(`/api/billing/payment/monobank/${INVOICE_ID}/status`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.amount).toBe(100);
    expect(res.body.currency).toBe('UAH');
  });

  it('returns 500 on service error', async () => {
    const { app } = buildPaymentApp({
      monobank: {
        ...makeMonobankService(),
        getPaymentStatus: jest.fn().mockRejectedValue(new Error('Monobank API error: 404')),
      },
    });

    const res = await request(app)
      .get('/api/billing/payment/monobank/invalid-id/status');

    expect(res.status).toBe(500);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/billing/payment/available-providers
// ──────────────────────────────────────────────────────────────────────────

describe('GET /api/billing/payment/available-providers', () => {
  it('returns providers with monobank always enabled', async () => {
    const { app } = buildPaymentApp();

    const res = await request(app)
      .get('/api/billing/payment/available-providers');

    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'monobank', enabled: true }),
      ])
    );
  });

  it('disables crypto providers when user has no crypto tag', async () => {
    const { app } = buildPaymentApp();

    const res = await request(app)
      .get('/api/billing/payment/available-providers');

    const metamask = res.body.providers.find((p: any) => p.id === 'metamask');
    const binance = res.body.providers.find((p: any) => p.id === 'binance_pay');
    expect(metamask.enabled).toBe(false);
    expect(binance.enabled).toBe(false);
  });

  it('enables crypto providers when user has crypto tag', async () => {
    const db = makeDb();
    db.query.mockResolvedValueOnce({ rows: [{ '1': 1 }] }); // crypto tag exists

    const { app } = buildPaymentApp({ db: { query: db.query } });

    const res = await request(app)
      .get('/api/billing/payment/available-providers');

    const metamask = res.body.providers.find((p: any) => p.id === 'metamask');
    expect(metamask.enabled).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /webhooks/monobank
// ──────────────────────────────────────────────────────────────────────────

describe('POST /webhooks/monobank', () => {
  it('processes valid webhook with signature', async () => {
    const { app, monobank } = buildWebhookApp();
    const body = JSON.stringify({ invoiceId: INVOICE_ID, status: 'success', amount: 10000, ccy: 980 });

    const res = await request(app)
      .post('/webhooks/monobank')
      .set('X-Sign', 'valid-signature')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(200);
    expect(monobank.handleWebhook).toHaveBeenCalled();
  });

  it('returns 400 when X-Sign header is missing', async () => {
    const { app } = buildWebhookApp();
    const body = JSON.stringify({ invoiceId: INVOICE_ID, status: 'success' });

    const res = await request(app)
      .post('/webhooks/monobank')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing X-Sign');
  });

  it('returns 400 when signature validation fails', async () => {
    const { app } = buildWebhookApp({
      monobank: {
        handleWebhook: jest.fn().mockRejectedValue(new Error('Invalid webhook signature')),
      },
    });

    const body = JSON.stringify({ invoiceId: INVOICE_ID, status: 'success' });

    const res = await request(app)
      .post('/webhooks/monobank')
      .set('X-Sign', 'invalid-sig')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('Invalid webhook signature');
    expect(loggedText()).toContain('Invalid webhook signature');
  });

  it('triggers consultation payment webhook on success', async () => {
    const consultationPayment = makeConsultationPaymentService();
    const { app } = buildWebhookApp({ consultationPayment });

    const body = JSON.stringify({ invoiceId: INVOICE_ID, status: 'success' });

    await request(app)
      .post('/webhooks/monobank')
      .set('X-Sign', 'valid-sig')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(consultationPayment.handleWebhook).toHaveBeenCalledWith(INVOICE_ID, 'success');
  });

  it('does not fail if consultation payment webhook throws', async () => {
    const consultationPayment = makeConsultationPaymentService({
      handleWebhook: jest.fn().mockRejectedValue(new Error('DB error')),
    });
    const { app } = buildWebhookApp({ consultationPayment });

    const body = JSON.stringify({ invoiceId: INVOICE_ID, status: 'success' });

    const res = await request(app)
      .post('/webhooks/monobank')
      .set('X-Sign', 'valid-sig')
      .set('Content-Type', 'application/json')
      .send(body);

    // Main webhook should still succeed
    expect(res.status).toBe(200);
  });

  it('returns 400 on generic service error (non-signature)', async () => {
    const { app } = buildWebhookApp({
      monobank: {
        handleWebhook: jest.fn().mockRejectedValue(new Error('Database connection lost')),
      },
    });

    const body = JSON.stringify({ invoiceId: INVOICE_ID, status: 'success' });

    const res = await request(app)
      .post('/webhooks/monobank')
      .set('X-Sign', 'valid-sig')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('Database connection lost');
    expect(loggedText()).toContain('Database connection lost');
  });

  it('handles malformed JSON body gracefully', async () => {
    const { app } = buildWebhookApp();

    const res = await request(app)
      .post('/webhooks/monobank')
      .set('X-Sign', 'valid-sig')
      .set('Content-Type', 'application/json')
      .send('not valid json');

    expect(res.status).toBe(400);
  });

  it('passes non-success status to consultation payment service', async () => {
    const consultationPayment = makeConsultationPaymentService();
    const { app } = buildWebhookApp({ consultationPayment });

    const body = JSON.stringify({ invoiceId: INVOICE_ID, status: 'failure' });

    await request(app)
      .post('/webhooks/monobank')
      .set('X-Sign', 'valid-sig')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(consultationPayment.handleWebhook).toHaveBeenCalledWith(INVOICE_ID, 'failure');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /webhooks/nowpayments
// ──────────────────────────────────────────────────────────────────────────

describe('POST /webhooks/nowpayments', () => {
  it('returns 400 when signature header missing', async () => {
    const { app } = buildWebhookApp();

    const res = await request(app)
      .post('/webhooks/nowpayments')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ payment_id: 123 }));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing x-nowpayments-sig');
  });

  it('processes valid webhook with signature', async () => {
    const { app, nowpayments } = buildWebhookApp();

    const res = await request(app)
      .post('/webhooks/nowpayments')
      .set('x-nowpayments-sig', 'valid-hmac')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ payment_id: 123, payment_status: 'finished' }));

    expect(res.status).toBe(200);
    expect(nowpayments.handleWebhook).toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/billing/payment/:provider/:paymentId/status
// ──────────────────────────────────────────────────────────────────────────

describe('GET /api/billing/payment/:provider/:paymentId/status', () => {
  it('routes metamask status requests', async () => {
    const { app, metamask } = buildPaymentApp();

    const res = await request(app)
      .get('/api/billing/payment/metamask/mm-001/status');

    expect(res.status).toBe(200);
    expect(metamask.getPaymentStatus).toHaveBeenCalledWith('mm-001');
  });

  it('routes binance_pay status requests', async () => {
    const { app, binance } = buildPaymentApp();

    const res = await request(app)
      .get('/api/billing/payment/binance_pay/bp-001/status');

    expect(res.status).toBe(200);
    expect(binance.getPaymentStatus).toHaveBeenCalledWith('bp-001');
  });

  it('routes nowpayments status requests', async () => {
    const { app, nowpayments } = buildPaymentApp();

    const res = await request(app)
      .get('/api/billing/payment/nowpayments/np-001/status');

    expect(res.status).toBe(200);
    expect(nowpayments.getPaymentStatus).toHaveBeenCalledWith('np-001');
  });

  it('returns 400 for invalid provider', async () => {
    const { app } = buildPaymentApp();

    const res = await request(app)
      .get('/api/billing/payment/invalid_provider/id-001/status');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid provider');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/billing/payment/nowpayments/create
// ──────────────────────────────────────────────────────────────────────────

describe('POST /api/billing/payment/nowpayments/create', () => {
  it('creates invoice with valid amount', async () => {
    const { app, nowpayments } = buildPaymentApp();

    const res = await request(app)
      .post('/api/billing/payment/nowpayments/create')
      .send({ amount_usd: 50 });

    expect(res.status).toBe(200);
    expect(nowpayments.createInvoice).toHaveBeenCalledWith(
      TEST_USER.userId,
      50,
      TEST_USER.email
    );
  });

  it('rejects amount less than 1', async () => {
    const { app } = buildPaymentApp();

    const res = await request(app)
      .post('/api/billing/payment/nowpayments/create')
      .send({ amount_usd: 0.5 });

    expect(res.status).toBe(400);
  });

  it('rejects missing amount', async () => {
    const { app } = buildPaymentApp();

    const res = await request(app)
      .post('/api/billing/payment/nowpayments/create')
      .send({});

    expect(res.status).toBe(400);
  });
});
