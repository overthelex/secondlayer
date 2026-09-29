/**
 * Tests for billing-inline-routes
 *
 * Regression guard: POST /topup used to credit the caller's balance with whatever
 * amount_usd the request body carried, behind nothing but a login. It must stay gone.
 */

import express from 'express';
import request from 'supertest';
import { createBillingInlineRoutes } from '../billing-inline-routes';

jest.mock('../../utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

function buildApp() {
  const billingService = {
    topUpBalance: jest.fn(),
    setTransactionInvoiceNumber: jest.fn(),
    getBillingSummary: jest.fn().mockResolvedValue({ balance_usd: 0 }),
  };
  const deps = {
    billingService,
    costTracker: {},
    invoiceService: { generateInvoiceNumber: jest.fn() },
    currencyService: {},
    db: {},
  } as any;

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'user-1' };
    next();
  });
  app.use('/api/billing', createBillingInlineRoutes(deps));
  return { app, billingService };
}

describe('billing-inline-routes', () => {
  it('has no self-serve POST /topup: a logged-in user cannot credit their own balance', async () => {
    const { app, billingService } = buildApp();

    const res = await request(app)
      .post('/api/billing/topup')
      .send({ amount_usd: 100000, description: 'free money' });

    expect(res.status).toBe(404);
    expect(billingService.topUpBalance).not.toHaveBeenCalled();
  });

  it('still serves GET /balance', async () => {
    const { app, billingService } = buildApp();

    const res = await request(app).get('/api/billing/balance');

    expect(res.status).toBe(200);
    expect(billingService.getBillingSummary).toHaveBeenCalledWith('user-1');
  });
});
