/**
 * Mock MetaMask Service for Development/Testing
 * Simulates MetaMask payment flow without actual blockchain interactions
 */

import { BillingService } from '../billing-service.js';
import { EmailService } from '../email-service.js';
import { invoiceService } from '../invoice-service.js';
import { logger } from '../../utils/logger.js';

export interface MetaMaskPaymentResult {
  paymentIntentId: string;
  walletAddress: string;
  network: string;
  token: string;
  cryptoAmount: string;
  exchangeRate: number;
  amountUsd: number;
}

export interface MetaMaskVerifyResult {
  status: 'succeeded' | 'failed' | 'pending';
  txHash: string;
  amountUsd: number;
  message?: string;
}

export class MockMetaMaskService {
  private mockPayments: Map<string, any> = new Map();

  constructor(
    private billingService: BillingService,
    private emailService: EmailService
  ) {
    logger.info('MockMetaMaskService initialized (TEST MODE)');
  }

  async createPaymentIntent(
    userId: string,
    amountUsd: number,
    email: string,
    network: string,
    token: string
  ): Promise<MetaMaskPaymentResult> {
    if (amountUsd < 1) {
      throw new Error('Minimum top-up amount is $1.00');
    }

    const paymentIntentId = `mm_mock_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const tokenLower = token.toLowerCase();
    const exchangeRate = tokenLower === 'eth' ? 2500 : 1; // Mock ETH price
    const cryptoAmount = tokenLower === 'eth'
      ? (amountUsd / exchangeRate).toFixed(8)
      : amountUsd.toFixed(2);

    this.mockPayments.set(paymentIntentId, {
      userId,
      amountUsd,
      email,
      network,
      token: tokenLower,
      cryptoAmount,
      exchangeRate,
      status: 'pending',
    });

    logger.info('[MOCK] MetaMask payment intent created', { paymentIntentId, userId, amountUsd, network, token: tokenLower });

    return {
      paymentIntentId,
      walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD00',
      network,
      token: tokenLower,
      cryptoAmount,
      exchangeRate,
      amountUsd,
    };
  }

  async verifyTransaction(paymentIntentId: string, txHash: string): Promise<MetaMaskVerifyResult> {
    const payment = this.mockPayments.get(paymentIntentId);
    if (!payment) {
      throw new Error('Payment intent not found');
    }

    if (payment.status === 'succeeded') {
      return { status: 'succeeded', txHash, amountUsd: payment.amountUsd, message: 'Already verified' };
    }

    // Mock: auto-succeed
    payment.status = 'succeeded';
    payment.txHash = txHash;
    this.mockPayments.set(paymentIntentId, payment);

    const transaction = await this.billingService.topUpBalance({
      userId: payment.userId,
      amountUsd: payment.amountUsd,
      description: `[MOCK] MetaMask payment (${payment.token.toUpperCase()} on ${payment.network}): ${txHash}`,
      paymentProvider: 'metamask_mock',
      paymentId: paymentIntentId,
      metadata: { txHash, network: payment.network, token: payment.token },
    });

    const invoiceNumber = invoiceService.generateInvoiceNumber(transaction.id);
    await this.billingService.setTransactionInvoiceNumber(transaction.id, invoiceNumber);

    logger.info('[MOCK] MetaMask payment verified', { paymentIntentId, txHash, amountUsd: payment.amountUsd });

    if (payment.email) {
      await this.emailService.sendPaymentSuccess({
        email: payment.email,
        name: 'User',
        amount: payment.amountUsd,
        currency: 'USD',
        newBalance: transaction.balance_after_usd,
        paymentId: paymentIntentId,
        userId: payment.userId,
      });
    }

    return { status: 'succeeded', txHash, amountUsd: payment.amountUsd };
  }

  async getPaymentStatus(paymentIntentId: string): Promise<{ status: string; amount: number; currency: string; network?: string; token?: string; txHash?: string }> {
    const payment = this.mockPayments.get(paymentIntentId);
    if (!payment) {
      throw new Error('Payment intent not found');
    }

    return {
      status: payment.status,
      amount: payment.amountUsd,
      currency: 'usd',
      network: payment.network,
      token: payment.token,
      txHash: payment.txHash,
    };
  }
}
