/**
 * Billing Service
 * Handles billing, payments, and transaction operations
 */

import { BaseService } from '../base/BaseService';
import { Balance, Transaction, BillingSettings, PaymentIntent } from '../../types/models';
import {
  UpdateBillingSettingsRequest,
  CreatePaymentRequest,
  GetTransactionHistoryRequest,
  GetBalanceResponse,
  GetTransactionHistoryResponse,
  CreatePaymentResponse,
} from '../../types/api';

export class BillingService extends BaseService {
  /**
   * Get account balance
   */
  async getBalance(): Promise<Balance> {
    try {
      const response = await this.client.get<GetBalanceResponse>('/billing/balance');
      return response.data.balance;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Get transaction history
   */
  async getTransactionHistory(
    params?: GetTransactionHistoryRequest
  ): Promise<GetTransactionHistoryResponse> {
    try {
      const response = await this.client.get<GetTransactionHistoryResponse>(
        '/billing/history',
        { params }
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Update billing settings
   */
  async updateSettings(data: UpdateBillingSettingsRequest): Promise<BillingSettings> {
    try {
      const response = await this.client.put<{ settings: BillingSettings }>(
        '/billing/settings',
        data
      );
      return response.data.settings;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Create Stripe payment
   */
  async createStripePayment(amount_usd: number, metadata?: any): Promise<PaymentIntent> {
    try {
      const response = await this.client.post<CreatePaymentResponse>(
        '/billing/payment/stripe/create',
        { amount_usd, metadata }
      );

      return {
        id: response.data.payment_id,
        amount: amount_usd,
        currency: 'USD',
        status: response.data.status,
        provider: 'stripe',
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Create Fondy payment
   */
  async createFondyPayment(amount_uah: number): Promise<PaymentIntent> {
    try {
      const response = await this.client.post<CreatePaymentResponse>(
        '/billing/payment/fondy/create',
        { amount_uah }
      );

      return {
        id: response.data.payment_id,
        amount: amount_uah,
        currency: 'UAH',
        status: response.data.status,
        provider: 'fondy',
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Get payment status
   */
  async getPaymentStatus(
    provider: 'stripe' | 'fondy',
    paymentId: string
  ): Promise<any> {
    try {
      const response = await this.client.get(
        `/billing/payment/${provider}/${paymentId}/status`
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Send test email
   */
  async sendTestEmail(): Promise<void> {
    try {
      await this.client.post('/billing/test-email');
    } catch (error) {
      return this.handleError(error);
    }
  }
}

// Export singleton instance
export const billingService = new BillingService();
