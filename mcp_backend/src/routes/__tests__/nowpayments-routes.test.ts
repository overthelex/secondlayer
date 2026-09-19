/**
 * NOWPayments Route Integration Tests
 *
 * Tests the Express routes for NOWPayments:
 *  - POST /api/billing/payment/nowpayments/create
 *  - POST /webhooks/nowpayments  (mounted directly in http-server with express.raw)
 *  - GET  /api/billing/payment/nowpayments/:id/status
 *  - GET  /api/billing/payment/available-providers (nowpayments entry)
 */

import express, { Request, Response } from 'express';
import request from 'supertest';
import { createPaymentRouter } from '../payment-routes';
import { logger } from '../../utils/logger';

// The route deliberately withholds internal error text from the caller and puts
// it in the log instead. This suite asserted that text in the RESPONSE, which is
// precisely what must not be there.
jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

// ──────────────────────────────────────────────────────────────────────────
// Mock services
// ──────────────────────────────────────────────────────────────────────────

const mockNowPayments = {
  createInvoice: jest.fn(),
  verifySignature: jest.fn(),
  handleWebhook: jest.fn(),
  getPaymentStatus: jest.fn(),
};

const mockMonobank = {
  createInvoice: jest.fn(),
  handleWebhook: jest.fn(),
  getPaymentStatus: jest.fn(),
};

const mockMetaMask = {
  createPaymentIntent: jest.fn(),
  verifyTransaction: jest.fn(),
  getPaymentStatus: jest.fn(),
};

const mockBinancePay = {
  createOrder: jest.fn(),
  handleWebhook: jest.fn(),
  getPaymentStatus: jest.fn(),
};

const mockDb = {
  query: jest.fn().mockResolvedValue({ rows: [] }),
};

// ──────────────────────────────────────────────────────────────────────────
// App factory — mirrors http-server.ts mounting pattern
// ──────────────────────────────────────────────────────────────────────────

function buildApp(userId = 'user-test-123', email = 'user@test.com') {
  const app = express();

  // NowPayments webhook needs raw body BEFORE json() — mirror http-server.ts
  app.post(
    '/webhooks/nowpayments',
    express.raw({ type: 'application/json', limit: '10mb' }),
    async (req: Request, res: Response) => {
      try {
        const signature = req.headers['x-nowpayments-sig'] as string;
        if (!signature) {
          logger.warn('NOWPayments webhook missing signature');
          return res.status(400).json({ error: 'Missing signature' });
        }
        const result = await mockNowPayments.handleWebhook(req.body, signature);
        return res.json(result);
      } catch (error: any) {
        logger.error('NOWPayments webhook failed', { error: error.message });
        return res.status(400).json({ error: 'Webhook processing failed', message: error.message });
      }
    }
  );

  // JSON parsing for all other routes
  app.use(express.json());

  // Simulate JWT auth middleware
  app.use((req: any, _res: any, next: any) => {
    req.user = { userId, id: userId, email };
    next();
  });

  app.use(
    '/api/billing/payment',
    createPaymentRouter(
      mockMonobank as any,
      mockMetaMask as any,
      mockBinancePay as any,
      mockNowPayments as any,
      mockDb as any
    )
  );

  return app;
}

// ──────────────────────────────────────────────────────────────────────────
// Tests: available-providers includes nowpayments
// ──────────────────────────────────────────────────────────────────────────

describe('GET /api/billing/payment/available-providers', () => {
  it('includes nowpayments with enabled:true for any user', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/billing/payment/available-providers');

    expect(res.status).toBe(200);
    const providers = res.body.providers as Array<{ id: string; enabled: boolean }>;
    const np = providers.find(p => p.id === 'nowpayments');
    expect(np).toBeDefined();
    expect(np?.enabled).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Tests: POST /api/billing/payment/nowpayments/create
// ──────────────────────────────────────────────────────────────────────────

describe('POST /api/billing/payment/nowpayments/create', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 400 when amount_usd is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/billing/payment/nowpayments/create')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request');
  });

  it('returns 400 when amount_usd < 1', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/billing/payment/nowpayments/create')
      .send({ amount_usd: 0.5 });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('amount_usd');
  });

  it('returns 400 when amount_usd is not a number', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/billing/payment/nowpayments/create')
      .send({ amount_usd: 'ten' });

    expect(res.status).toBe(400);
  });

  it('calls createInvoice with userId, amount, email and returns result', async () => {
    const invoiceResult = {
      invoiceId: 'np-123',
      paymentIntentId: 'pi-abc',
      invoiceUrl: 'https://nowpayments.io/pay/np-123',
      amountUsd: 10,
    };
    mockNowPayments.createInvoice.mockResolvedValue(invoiceResult);

    const app = buildApp('user-test-123', 'user@test.com');
    const res = await request(app)
      .post('/api/billing/payment/nowpayments/create')
      .send({ amount_usd: 10 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(invoiceResult);
    expect(mockNowPayments.createInvoice).toHaveBeenCalledWith(
      'user-test-123',
      10,
      'user@test.com'
    );
  });

  it('returns 500 when createInvoice throws', async () => {
    mockNowPayments.createInvoice.mockRejectedValue(new Error('NOWPayments API down'));

    const app = buildApp();
    const res = await request(app)
      .post('/api/billing/payment/nowpayments/create')
      .send({ amount_usd: 5 });

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('NOWPayments API down');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Tests: GET /api/billing/payment/nowpayments/:id/status
// ──────────────────────────────────────────────────────────────────────────

describe('GET /api/billing/payment/nowpayments/:id/status', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns payment status from nowpaymentsService', async () => {
    mockNowPayments.getPaymentStatus.mockResolvedValue({ status: 'succeeded', amount: 10, currency: 'usd' });

    const app = buildApp();
    const res = await request(app).get('/api/billing/payment/nowpayments/pi-abc/status');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'succeeded', amount: 10, currency: 'usd' });
    expect(mockNowPayments.getPaymentStatus).toHaveBeenCalledWith('pi-abc');
  });

  it('returns 500 when getPaymentStatus throws', async () => {
    mockNowPayments.getPaymentStatus.mockRejectedValue(new Error('Payment intent not found'));

    const app = buildApp();
    const res = await request(app).get('/api/billing/payment/nowpayments/unknown/status');

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('An unexpected error occurred');
    expect(JSON.stringify(res.body)).not.toContain('Payment intent not found');
    expect(
      (logger.error as jest.Mock).mock.calls.map((c) => JSON.stringify(c)).join(' ')
    ).toContain('Payment intent not found');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Tests: POST /webhooks/nowpayments
// ──────────────────────────────────────────────────────────────────────────

describe('POST /webhooks/nowpayments', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 when x-nowpayments-sig header is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/webhooks/nowpayments')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ invoice_id: '123', payment_status: 'finished' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing signature');
  });

  it('calls handleWebhook with raw body and signature', async () => {
    mockNowPayments.handleWebhook.mockResolvedValue({ received: true });

    const payload = JSON.stringify({ invoice_id: '123', payment_status: 'finished' });
    const app = buildApp();
    const res = await request(app)
      .post('/webhooks/nowpayments')
      .set('Content-Type', 'application/json')
      .set('x-nowpayments-sig', 'valid_sig')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockNowPayments.handleWebhook).toHaveBeenCalledWith(
      expect.any(Buffer),
      'valid_sig'
    );
  });

  it('returns 400 when handleWebhook throws (invalid signature)', async () => {
    mockNowPayments.handleWebhook.mockRejectedValue(new Error('Invalid NOWPayments IPN signature'));

    const app = buildApp();
    const res = await request(app)
      .post('/webhooks/nowpayments')
      .set('Content-Type', 'application/json')
      .set('x-nowpayments-sig', 'bad_sig')
      .send(JSON.stringify({ invoice_id: '123' }));

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid NOWPayments IPN signature');
  });

  it('returns 200 for non-terminal payment status', async () => {
    mockNowPayments.handleWebhook.mockResolvedValue({ received: true });

    const app = buildApp();
    const res = await request(app)
      .post('/webhooks/nowpayments')
      .set('Content-Type', 'application/json')
      .set('x-nowpayments-sig', 'some_sig')
      .send(JSON.stringify({ invoice_id: '123', payment_status: 'waiting' }));

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});
