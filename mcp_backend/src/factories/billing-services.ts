import { Database } from '../database/database.js';
import { EmbeddingService } from '../services/embedding-service.js';
import { CostTracker } from '../services/cost-tracker.js';
import { BillingService } from '../services/billing-service.js';
import { CurrencyService } from '../services/currency-service.js';
import { PricingService } from '../services/pricing-service.js';
import { SubscriptionService } from '../services/subscription-service.js';
import { InvoiceService } from '../services/invoice-service.js';
import { EmailService } from '../services/email-service.js';
import { ReferralService } from '../services/referral-service.js';
import { ApiKeyService } from '../services/api-key-service.js';
import { CreditService } from '../services/credit-service.js';
import { B2BInvoiceService } from '../services/b2b-invoice-service.js';
import { EncryptionKeyService } from '../services/encryption-key-service.js';
import { MonobankService } from '../services/monobank-service.js';
import { MetaMaskService } from '../services/metamask-service.js';
import { BinancePayService } from '../services/binance-pay-service.js';
import { NOWPaymentsService } from '../services/nowpayments-service.js';
import { MockMonobankService } from '../services/__mocks__/monobank-service-mock.js';
import { MockMetaMaskService } from '../services/__mocks__/metamask-service-mock.js';
import { MockBinancePayService } from '../services/__mocks__/binance-pay-service-mock.js';
import { MockNOWPaymentsService } from '../services/__mocks__/nowpayments-service-mock.js';
import { UserPreferencesService } from '../services/user-preferences-service.js';
import { PrometheusService } from '../services/prometheus-service.js';
import { initializeCryptoTagMiddleware } from '../middleware/crypto-tag-required.js';
import { setAuthEmailService, setAuthReferralService, setAuthBillingService } from '../controllers/auth.js';
import { logger } from '../utils/logger.js';
import cron from 'node-cron';

export interface BillingServices {
  costTracker: CostTracker;
  billingService: BillingService;
  currencyService: CurrencyService;
  pricingService: PricingService;
  subscriptionService: SubscriptionService;
  invoiceService: InvoiceService;
  emailService: EmailService;
  referralService: ReferralService;
  apiKeyService: ApiKeyService;
  creditService: CreditService;
  b2bInvoiceService: B2BInvoiceService;
  encryptionKeyService: EncryptionKeyService;
  userPreferencesService: UserPreferencesService;
  prometheusService: PrometheusService;
  monobankService: MonobankService | MockMonobankService;
  metamaskService: MetaMaskService | MockMetaMaskService;
  binancePayService: BinancePayService | MockBinancePayService;
  nowpaymentsService: NOWPaymentsService | MockNOWPaymentsService;
}

export function createBillingServices(db: Database, embeddingService: EmbeddingService): BillingServices {
  // Core billing
  const costTracker = new CostTracker(db);
  const billingService = new BillingService(db);
  const encryptionKeyService = new EncryptionKeyService(db);
  const currencyService = new CurrencyService();

  // Fetch NBU exchange rate on startup
  currencyService.refreshRate().catch(err => {
    logger.warn('[BillingServices] Initial NBU rate fetch failed', { error: (err as Error).message });
  });

  // Schedule daily NBU rate refresh at 6:00 AM Kyiv time — scheduler instance only
  // (RUN_SCHEDULER!=false) so N web replicas don't each refresh (LEXAI-1802). The initial
  // fetch above stays on every instance (idempotent, warms the rate locally).
  if (process.env.RUN_SCHEDULER !== 'false') {
    cron.schedule('0 6 * * *', () => {
      logger.info('[BillingServices] Running scheduled NBU rate refresh');
      currencyService.refreshRate().catch(err => {
        logger.error('[BillingServices] Scheduled NBU rate refresh failed', { error: (err as Error).message });
      });
    }, { timezone: 'Europe/Kyiv' });
  }

  const pricingService = new PricingService(db);
  const subscriptionService = new SubscriptionService(db);
  const userPreferencesService = new UserPreferencesService(db);
  const prometheusService = new PrometheusService(process.env.PROMETHEUS_URL);
  const invoiceService = new InvoiceService();

  // Wire billing ↔ currency
  billingService.setCurrencyService(currencyService);
  costTracker.setBillingService(billingService);

  // Referral
  const referralService = new ReferralService(db, billingService);
  setAuthReferralService(referralService);
  setAuthBillingService(billingService);
  billingService.setReferralRewardCallback(
    (userId, amountUsd, amountUah, transactionId) =>
      referralService.processReward(userId, amountUsd, amountUah, transactionId)
  );

  // Register VoyageAI token usage callback on EmbeddingService
  embeddingService.setTokenUsageCallback((tokens, model, task) => {
    costTracker.recordVoyageCall({ model, totalTokens: tokens, task }).catch((err) => {
      logger.warn('Failed to record VoyageAI tokens in monthly stats', { error: err.message });
    });
  });

  // Phase 2 billing services (API keys & credits)
  const apiKeyService = new ApiKeyService(db);
  const creditService = new CreditService(db);
  logger.info('Phase 2 billing services initialized (API keys & credits)');

  // B2B Invoice service for legal entities
  const b2bInvoiceService = new B2BInvoiceService(db, currencyService);
  logger.info('B2B invoice service initialized');

  // Email service
  const emailService = new EmailService();
  emailService.setPreferenceFetcher((userId: string) =>
    billingService.getEmailPreferences(userId)
  );
  emailService.setReferralDataFetcher(async (userId: string) => {
    try {
      const codeResult = await db.query(
        'SELECT code, verified_at FROM referral_codes WHERE user_id = $1 AND is_active = true',
        [userId]
      );
      const isVerified = codeResult.rows.length > 0 && !!codeResult.rows[0].verified_at;
      const referralCode = codeResult.rows.length > 0 ? codeResult.rows[0].code : null;

      const countResult = await db.query(
        'SELECT COUNT(*) as total FROM referral_links WHERE referrer_id = $1',
        [userId]
      );

      const earningsResult = await db.query(
        'SELECT COALESCE(SUM(amount_usd), 0) as total_usd, COALESCE(SUM(amount_uah), 0) as total_uah FROM referral_rewards WHERE beneficiary_id = $1',
        [userId]
      );

      return {
        referralCode,
        totalReferrals: parseInt(countResult.rows[0].total, 10),
        totalEarnedUsd: parseFloat(earningsResult.rows[0].total_usd),
        totalEarnedUah: parseFloat(earningsResult.rows[0].total_uah),
        isVerified,
      };
    } catch {
      return { referralCode: null, totalReferrals: 0, totalEarnedUsd: 0, totalEarnedUah: 0, isVerified: false };
    }
  });
  setAuthEmailService(emailService);

  // Payment services — mock vs real selection
  const mockPaymentsEnabled = process.env.MOCK_PAYMENTS === 'true';
  let monobankService: MonobankService | MockMonobankService;
  let metamaskService: MetaMaskService | MockMetaMaskService;
  let binancePayService: BinancePayService | MockBinancePayService;
  let nowpaymentsService: NOWPaymentsService | MockNOWPaymentsService;

  if (mockPaymentsEnabled) {
    monobankService = new MockMonobankService(billingService, emailService, db);
    metamaskService = new MockMetaMaskService(billingService, emailService);
    binancePayService = new MockBinancePayService(billingService, emailService);
    nowpaymentsService = new MockNOWPaymentsService(billingService, emailService);
    logger.warn('MOCK_PAYMENTS=true — all payment services are mocked');
  } else {
    // Real Monobank
    monobankService = new MonobankService(billingService, emailService, db, currencyService);
    if (!process.env.MONOBANK_API_KEY) {
      logger.warn('MONOBANK_API_KEY is not set — Monobank payments will fail at runtime');
    } else {
      logger.info('Monobank service: REAL');
    }

    // MetaMask — real if keys available, mock otherwise
    if (process.env.CRYPTO_RECEIVING_WALLET && process.env.ETHEREUM_RPC_URL) {
      metamaskService = new MetaMaskService(billingService, emailService, db);
      logger.info('MetaMask service: REAL');
    } else {
      metamaskService = new MockMetaMaskService(billingService, emailService);
      logger.info('MetaMask service: MOCK (no CRYPTO_RECEIVING_WALLET / ETHEREUM_RPC_URL)');
    }

    // Binance Pay — real if keys available, mock otherwise
    if (process.env.BINANCE_PAY_API_KEY && process.env.BINANCE_PAY_SECRET_KEY) {
      binancePayService = new BinancePayService(billingService, emailService, db);
      logger.info('Binance Pay service: REAL');
    } else {
      binancePayService = new MockBinancePayService(billingService, emailService);
      logger.info('Binance Pay service: MOCK (no BINANCE_PAY keys)');
    }

    // NOWPayments — real if keys available, mock otherwise
    if (process.env.NOWPAYMENTS_API_KEY && process.env.NOWPAYMENTS_IPN_SECRET) {
      nowpaymentsService = new NOWPaymentsService(billingService, emailService, db);
      logger.info('NOWPayments service: REAL');
    } else {
      nowpaymentsService = new MockNOWPaymentsService(billingService, emailService);
      logger.info('NOWPayments service: MOCK (no NOWPAYMENTS keys)');
    }
  }

  initializeCryptoTagMiddleware(db);

  logger.info('Payment services initialized', {
    mockPayments: mockPaymentsEnabled,
    monobank: monobankService.constructor.name,
    metamask: metamaskService.constructor.name,
    binancePay: binancePayService.constructor.name,
    nowpayments: nowpaymentsService.constructor.name,
  });

  return {
    costTracker,
    billingService,
    currencyService,
    pricingService,
    subscriptionService,
    invoiceService,
    emailService,
    referralService,
    apiKeyService,
    creditService,
    b2bInvoiceService,
    encryptionKeyService,
    userPreferencesService,
    prometheusService,
    monobankService,
    metamaskService,
    binancePayService,
    nowpaymentsService,
  };
}
