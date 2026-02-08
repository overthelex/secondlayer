/**
 * Invoice Service
 * Generates invoice numbers and PDF invoices for billing transactions
 */

import PDFDocument from 'pdfkit';
import { logger } from '../utils/logger.js';

export interface InvoiceItem {
  description: string;
  amount: number;
  currency: string;
}

export interface InvoiceData {
  invoiceNumber: string;
  date: Date;
  dueDate?: Date;
  customerName: string;
  customerEmail: string;
  items: InvoiceItem[];
  subtotal: number;
  tax?: number;
  total: number;
  currency: 'USD' | 'UAH';
  paymentMethod: string;
  status: 'paid' | 'pending' | 'overdue';
  paymentId?: string;
  transactionId?: string;
}

export class InvoiceService {
  /**
   * Generate invoice number from transaction ID
   */
  generateInvoiceNumber(transactionId: string): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const txShort = transactionId.substring(0, 8).toUpperCase();
    return `INV-${timestamp}-${txShort}`;
  }

  /**
   * Generate PDF invoice as buffer
   */
  async generateInvoicePDF(invoice: InvoiceData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const chunks: Buffer[] = [];

        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const currencySymbol = invoice.currency === 'USD' ? '$' : '₴';

        // Header
        doc
          .fontSize(24)
          .font('Helvetica-Bold')
          .text('SecondLayer', 50, 50)
          .fontSize(10)
          .font('Helvetica')
          .text('Legal AI Platform', 50, 80)
          .text('Kyiv, Ukraine', 50, 95)
          .text('billing@legal.org.ua', 50, 110);

        // Invoice title and status
        doc
          .fontSize(20)
          .font('Helvetica-Bold')
          .text('INVOICE', 400, 50, { align: 'right' });

        doc
          .fontSize(10)
          .font('Helvetica')
          .text(`Invoice #: ${invoice.invoiceNumber}`, 400, 80, { align: 'right' })
          .text(`Date: ${invoice.date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`, 400, 95, { align: 'right' })
          .text(`Status: ${invoice.status.toUpperCase()}`, 400, 110, { align: 'right' });

        // Bill To
        doc
          .fontSize(12)
          .font('Helvetica-Bold')
          .text('Bill To:', 50, 160);

        doc
          .fontSize(10)
          .font('Helvetica')
          .text(invoice.customerName, 50, 180)
          .text(invoice.customerEmail, 50, 195);

        // Items table
        const tableTop = 250;
        const descriptionX = 50;
        const amountX = 450;

        // Table header
        doc
          .fontSize(10)
          .font('Helvetica-Bold')
          .text('Description', descriptionX, tableTop)
          .text('Amount', amountX, tableTop);

        doc
          .moveTo(50, tableTop + 15)
          .lineTo(550, tableTop + 15)
          .stroke();

        // Table rows
        let currentY = tableTop + 25;
        doc.font('Helvetica');

        for (const item of invoice.items) {
          doc
            .text(item.description, descriptionX, currentY, { width: 380 })
            .text(`${currencySymbol}${item.amount.toFixed(2)}`, amountX, currentY);
          currentY += 20;
        }

        // Totals
        currentY += 20;
        doc
          .moveTo(50, currentY)
          .lineTo(550, currentY)
          .stroke();

        currentY += 15;
        const totalsX = 350;

        doc
          .fontSize(10)
          .text('Subtotal:', totalsX, currentY)
          .text(`${currencySymbol}${invoice.subtotal.toFixed(2)}`, amountX, currentY);

        if (invoice.tax && invoice.tax > 0) {
          currentY += 20;
          doc
            .text('VAT (20%):', totalsX, currentY)
            .text(`${currencySymbol}${invoice.tax.toFixed(2)}`, amountX, currentY);
        }

        currentY += 20;
        doc
          .font('Helvetica-Bold')
          .fontSize(12)
          .text('Total:', totalsX, currentY)
          .text(`${currencySymbol}${invoice.total.toFixed(2)}`, amountX, currentY);

        // Payment info
        currentY += 40;
        doc
          .fontSize(10)
          .font('Helvetica')
          .text(`Payment Method: ${invoice.paymentMethod}`, 50, currentY);

        if (invoice.paymentId) {
          currentY += 15;
          doc.text(`Payment ID: ${invoice.paymentId}`, 50, currentY);
        }

        // Footer
        doc
          .fontSize(8)
          .text(
            'Thank you for using SecondLayer. For questions, contact billing@legal.org.ua',
            50,
            700,
            { align: 'center', width: 500 }
          );

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Create invoice data from payment transaction
   */
  createInvoiceFromTransaction(
    transactionId: string,
    invoiceNumber: string,
    userName: string,
    userEmail: string,
    amount: number,
    currency: 'USD' | 'UAH',
    paymentMethod: string,
    date: Date,
    paymentId?: string
  ): InvoiceData {
    // Calculate tax for UAH (20% VAT — amount includes VAT)
    const tax = currency === 'UAH' ? amount * 0.2 : undefined;
    const subtotal = tax ? amount - tax : amount;

    return {
      invoiceNumber,
      date,
      customerName: userName,
      customerEmail: userEmail,
      items: [
        {
          description: 'SecondLayer Account Top-Up',
          amount: subtotal,
          currency,
        },
      ],
      subtotal,
      tax,
      total: amount,
      currency,
      paymentMethod,
      status: 'paid',
      paymentId,
      transactionId,
    };
  }
}

export const invoiceService = new InvoiceService();
