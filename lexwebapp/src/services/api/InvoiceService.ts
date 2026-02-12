/**
 * Invoice Service
 * Handles invoice and payment operations via /api/invoicing
 */

import { BaseService } from '../base/BaseService';
import {
  Invoice,
  InvoiceWithDetails,
  InvoiceLineItem,
  InvoicePayment,
  GenerateInvoiceParams,
} from '../../types/models';

export interface InvoicesListResponse {
  invoices: Invoice[];
  total: number;
}

export interface InvoiceFilters {
  matter_id?: string;
  status?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
  offset?: number;
}

export interface RecordPaymentParams {
  amount_usd: number;
  payment_date?: string;
  payment_method?: string;
  reference_number?: string;
  notes?: string;
}

export interface AddLineItemParams {
  description: string;
  quantity: number;
  unit_price_usd: number;
}

export class InvoiceService extends BaseService {
  /**
   * List invoices with optional filters
   */
  async getInvoices(filters?: InvoiceFilters): Promise<InvoicesListResponse> {
    try {
      const response = await this.client.get<InvoicesListResponse>('/api/invoicing/invoices', {
        params: filters,
      });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Get invoice with details (line items and payments)
   */
  async getInvoiceById(id: string): Promise<InvoiceWithDetails> {
    try {
      const response = await this.client.get<InvoiceWithDetails>(`/api/invoicing/invoices/${id}`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Generate invoice from time entries
   */
  async generateInvoice(params: GenerateInvoiceParams): Promise<InvoiceWithDetails> {
    try {
      const response = await this.client.post<InvoiceWithDetails>(
        '/api/invoicing/generate',
        params
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Download invoice PDF
   */
  async downloadInvoicePDF(id: string): Promise<Blob> {
    try {
      const response = await this.client.get(`/api/invoicing/invoices/${id}/pdf`, {
        responseType: 'blob',
      });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Send invoice to client
   */
  async sendInvoice(id: string): Promise<Invoice> {
    try {
      const response = await this.client.post<Invoice>(`/api/invoicing/invoices/${id}/send`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Record payment for invoice
   */
  async recordPayment(id: string, params: RecordPaymentParams): Promise<InvoicePayment> {
    try {
      const response = await this.client.post<InvoicePayment>(
        `/api/invoicing/invoices/${id}/payment`,
        params
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Void invoice
   */
  async voidInvoice(id: string): Promise<Invoice> {
    try {
      const response = await this.client.post<Invoice>(`/api/invoicing/invoices/${id}/void`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Add manual line item to invoice
   */
  async addLineItem(id: string, params: AddLineItemParams): Promise<InvoiceLineItem> {
    try {
      const response = await this.client.post<InvoiceLineItem>(
        `/api/invoicing/invoices/${id}/line-items`,
        params
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Helper: Download invoice PDF as file
   */
  async downloadInvoiceFile(id: string, invoiceNumber: string): Promise<void> {
    try {
      const blob = await this.downloadInvoicePDF(id);
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${invoiceNumber}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      return this.handleError(error);
    }
  }
}

// Export singleton instance
export const invoiceService = new InvoiceService();
