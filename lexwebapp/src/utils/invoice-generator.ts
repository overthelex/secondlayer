/**
 * Invoice PDF Generator
 * Generates professional PDF invoices using jsPDF
 */

import jsPDF from 'jspdf';
import { format } from 'date-fns';

export interface InvoiceData {
  invoiceNumber: string;
  date: Date;
  dueDate?: Date;
  customerName: string;
  customerEmail: string;
  items: {
    description: string;
    amount: number;
    currency: string;
  }[];
  subtotal: number;
  tax?: number;
  total: number;
  currency: string;
  paymentMethod: string;
  status: 'paid' | 'pending' | 'overdue';
}

export function generateInvoicePDF(invoice: InvoiceData): void {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  let yPos = 20;

  // Header - Company Name
  doc.setFontSize(24);
  doc.setFont('helvetica', 'bold');
  doc.text('SecondLayer', 20, yPos);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Legal Platform', 20, yPos + 7);

  // Invoice Title
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('INVOICE', pageWidth - 20, yPos, { align: 'right' });

  // Invoice Number and Date
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`Invoice #: ${invoice.invoiceNumber}`, pageWidth - 20, yPos + 8, { align: 'right' });
  doc.text(`Date: ${format(invoice.date, 'MMM dd, yyyy')}`, pageWidth - 20, yPos + 14, {
    align: 'right',
  });

  if (invoice.dueDate) {
    doc.text(`Due Date: ${format(invoice.dueDate, 'MMM dd, yyyy')}`, pageWidth - 20, yPos + 20, {
      align: 'right',
    });
  }

  yPos += 40;

  // Divider Line
  doc.setDrawColor(230, 230, 224); // claude-border color
  doc.setLineWidth(0.5);
  doc.line(20, yPos, pageWidth - 20, yPos);

  yPos += 10;

  // Bill To Section
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Bill To:', 20, yPos);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(invoice.customerName, 20, yPos + 7);
  doc.text(invoice.customerEmail, 20, yPos + 13);

  yPos += 30;

  // Status Badge
  const statusColors: Record<string, [number, number, number]> = {
    paid: [82, 196, 26], // green
    pending: [250, 140, 22], // orange
    overdue: [255, 77, 79], // red
  };

  const statusColor = statusColors[invoice.status] || [128, 128, 128];
  doc.setFillColor(...statusColor);
  doc.roundedRect(pageWidth - 50, yPos - 7, 30, 8, 2, 2, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.text(
    invoice.status.toUpperCase(),
    pageWidth - 35,
    yPos - 1.5,
    { align: 'center' }
  );
  doc.setTextColor(0, 0, 0);

  yPos += 5;

  // Table Header
  doc.setFillColor(245, 245, 240); // claude-bg color
  doc.rect(20, yPos, pageWidth - 40, 10, 'F');

  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('Description', 25, yPos + 6.5);
  doc.text('Amount', pageWidth - 25, yPos + 6.5, { align: 'right' });

  yPos += 10;

  // Table Rows
  doc.setFont('helvetica', 'normal');
  invoice.items.forEach((item) => {
    // Check if we need a new page
    if (yPos > 250) {
      doc.addPage();
      yPos = 20;
    }

    doc.text(item.description, 25, yPos + 6.5);
    doc.text(
      `${item.currency === 'USD' ? '$' : '₴'}${item.amount.toFixed(2)}`,
      pageWidth - 25,
      yPos + 6.5,
      { align: 'right' }
    );

    yPos += 10;

    // Row separator
    doc.setDrawColor(230, 230, 224);
    doc.setLineWidth(0.2);
    doc.line(20, yPos, pageWidth - 20, yPos);
  });

  yPos += 10;

  // Subtotal, Tax, Total
  const rightColX = pageWidth - 25;
  const leftColX = pageWidth - 70;

  doc.setFont('helvetica', 'normal');
  doc.text('Subtotal:', leftColX, yPos, { align: 'right' });
  doc.text(
    `${invoice.currency === 'USD' ? '$' : '₴'}${invoice.subtotal.toFixed(2)}`,
    rightColX,
    yPos,
    { align: 'right' }
  );

  if (invoice.tax && invoice.tax > 0) {
    yPos += 7;
    doc.text('Tax:', leftColX, yPos, { align: 'right' });
    doc.text(
      `${invoice.currency === 'USD' ? '$' : '₴'}${invoice.tax.toFixed(2)}`,
      rightColX,
      yPos,
      { align: 'right' }
    );
  }

  yPos += 10;

  // Total line
  doc.setDrawColor(45, 45, 45);
  doc.setLineWidth(0.5);
  doc.line(leftColX - 10, yPos - 3, pageWidth - 20, yPos - 3);

  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Total:', leftColX, yPos + 5, { align: 'right' });
  doc.text(
    `${invoice.currency === 'USD' ? '$' : '₴'}${invoice.total.toFixed(2)}`,
    rightColX,
    yPos + 5,
    { align: 'right' }
  );

  yPos += 20;

  // Payment Method
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`Payment Method: ${invoice.paymentMethod}`, 20, yPos);

  // Footer
  yPos = doc.internal.pageSize.getHeight() - 30;
  doc.setFontSize(9);
  doc.setTextColor(107, 107, 107); // claude-subtext color
  doc.text('SecondLayer Legal Platform', pageWidth / 2, yPos, { align: 'center' });
  doc.text('https://legal.org.ua', pageWidth / 2, yPos + 5, { align: 'center' });
  doc.text('For questions, contact: billing@legal.org.ua', pageWidth / 2, yPos + 10, {
    align: 'center',
  });

  // Download the PDF
  doc.save(`invoice_${invoice.invoiceNumber}.pdf`);
}

// Generate mock invoice data
export function generateMockInvoices(count: number = 10): InvoiceData[] {
  const invoices: InvoiceData[] = [];
  const today = new Date();

  const paymentMethods = ['Monobank', 'MetaMask', 'Binance Pay', 'Wire Transfer'];
  const statuses: ('paid' | 'pending' | 'overdue')[] = ['paid', 'paid', 'paid', 'pending'];

  for (let i = 0; i < count; i++) {
    const daysAgo = Math.floor(Math.random() * 90); // Random date within last 90 days
    const invoiceDate = new Date(today);
    invoiceDate.setDate(invoiceDate.getDate() - daysAgo);

    const amount = [10, 25, 50, 100, 250][Math.floor(Math.random() * 5)];
    const currency = Math.random() > 0.5 ? 'USD' : 'UAH';
    const status = statuses[Math.floor(Math.random() * statuses.length)];

    invoices.push({
      invoiceNumber: `INV-2026-${String(count - i).padStart(5, '0')}`,
      date: invoiceDate,
      dueDate: status === 'pending' ? new Date(invoiceDate.getTime() + 30 * 24 * 60 * 60 * 1000) : undefined,
      customerName: 'Test User',
      customerEmail: 'test@legal.org.ua',
      items: [
        {
          description: 'Balance Top-up',
          amount,
          currency,
        },
      ],
      subtotal: amount,
      tax: currency === 'UAH' ? amount * 0.2 : 0, // 20% VAT for UAH
      total: currency === 'UAH' ? amount * 1.2 : amount,
      currency,
      paymentMethod: paymentMethods[Math.floor(Math.random() * paymentMethods.length)],
      status,
    });
  }

  return invoices.sort((a, b) => b.date.getTime() - a.date.getTime());
}
