import { Database } from '../database/database.js';
import { AuditService } from './audit-service.js';
import { logger } from '../utils/logger.js';
import PDFDocument from 'pdfkit';
import { Readable } from 'stream';

export interface Invoice {
    id: string;
    matter_id: string;
    invoice_number: string;
    status: 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled' | 'void';
    issue_date: string;
    due_date: string;
    subtotal_usd: number;
    tax_rate: number;
    tax_amount_usd: number;
    total_usd: number;
    amount_paid_usd: number;
    notes?: string;
    terms?: string;
    sent_at?: string;
    paid_at?: string;
    created_by: string;
    created_at: string;
    updated_at: string;
    // Joined fields
    matter_name?: string;
    client_name?: string;
}

export interface InvoiceLineItem {
    id: string;
    invoice_id: string;
    time_entry_id?: string;
    description: string;
    quantity: number;
    unit_price_usd: number;
    amount_usd: number;
    line_order: number;
    created_at: string;
}

export interface InvoicePayment {
    id: string;
    invoice_id: string;
    amount_usd: number;
    payment_date: string;
    payment_method?: string;
    reference_number?: string;
    notes?: string;
    recorded_by: string;
    created_at: string;
    updated_at: string;
}

export interface CreateInvoiceParams {
    matter_id: string;
    issue_date?: string;
    due_days?: number; // Days until due (default 30)
    tax_rate?: number;
    notes?: string;
    terms?: string;
    created_by: string;
}

export interface GenerateInvoiceFromTimeParams {
    matter_id: string;
    time_entry_ids: string[];
    issue_date?: string;
    due_days?: number;
    tax_rate?: number;
    notes?: string;
    terms?: string;
    created_by: string;
}

export interface ListInvoicesParams {
    matter_id?: string;
    status?: string;
    date_from?: string;
    date_to?: string;
    limit?: number;
    offset?: number;
}

export interface InvoiceWithDetails extends Invoice {
    line_items: InvoiceLineItem[];
    payments: InvoicePayment[];
}

export class MatterInvoiceService {
    constructor(
        private db: Database,
        private auditService: AuditService
    ) {}

    /**
     * Create a new invoice
     */
    async createInvoice(params: CreateInvoiceParams): Promise<Invoice> {
        const issueDate = params.issue_date || new Date().toISOString().split('T')[0];
        const dueDays = params.due_days || 30;
        const dueDate = new Date(issueDate);
        dueDate.setDate(dueDate.getDate() + dueDays);

        // Generate invoice number
        const invoiceNumberResult = await this.db.query(
            'SELECT generate_invoice_number() as generate_invoice_number'
        );
        const invoiceNumber = invoiceNumberResult.rows[0].generate_invoice_number;

        const result = await this.db.query(
            `INSERT INTO matter_invoices (
                matter_id, invoice_number, issue_date, due_date,
                tax_rate, notes, terms, created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *`,
            [
                params.matter_id,
                invoiceNumber,
                issueDate,
                dueDate.toISOString().split('T')[0],
                params.tax_rate || 0,
                params.notes || null,
                params.terms || null,
                params.created_by
            ]
        );

        const invoice = result.rows[0];

        await this.auditService.log({
            userId: params.created_by,
            action: 'invoice.create',
            resourceType: 'invoice',
            resourceId: invoice.id,
            details: { matter_id: params.matter_id, invoice_number: invoiceNumber }
        });

        logger.info('[Invoice] Invoice created', {
            invoiceId: invoice.id,
            invoiceNumber,
            matterId: params.matter_id
        });

        return invoice;
    }

    /**
     * Generate invoice from time entries
     */
    async generateFromTimeEntries(params: GenerateInvoiceFromTimeParams): Promise<InvoiceWithDetails> {
        // Create invoice
        const invoice = await this.createInvoice({
            matter_id: params.matter_id,
            issue_date: params.issue_date,
            due_days: params.due_days,
            tax_rate: params.tax_rate,
            notes: params.notes,
            terms: params.terms,
            created_by: params.created_by
        });

        // Get time entries
        const timeEntriesResult = await this.db.query(
            `SELECT id, description, duration_minutes, hourly_rate_usd, entry_date
            FROM time_entries
            WHERE id = ANY($1)
            AND status = 'approved'
            AND invoice_id IS NULL
            ORDER BY entry_date`,
            [params.time_entry_ids]
        );

        const timeEntries = timeEntriesResult.rows;

        if (timeEntries.length === 0) {
            throw new Error('No approved unbilled time entries found');
        }

        // Create line items from time entries
        for (let i = 0; i < timeEntries.length; i++) {
            const entry = timeEntries[i];
            const hours = entry.duration_minutes / 60;
            const amount = hours * entry.hourly_rate_usd;

            await this.db.query(
                `INSERT INTO invoice_line_items (
                    invoice_id, time_entry_id, description, quantity,
                    unit_price_usd, amount_usd, line_order
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    invoice.id,
                    entry.id,
                    `${entry.entry_date}: ${entry.description}`,
                    hours,
                    entry.hourly_rate_usd,
                    amount,
                    i
                ]
            );

            // Mark time entry as invoiced
            await this.db.query(
                `UPDATE time_entries
                SET status = 'invoiced', invoice_id = $1
                WHERE id = $2`,
                [invoice.id, entry.id]
            );
        }

        // Recalculate totals (trigger handles this automatically)
        // But we need to fetch the updated invoice
        const updatedInvoice = await this.getInvoiceWithDetails(invoice.id);

        await this.auditService.log({
            userId: params.created_by,
            action: 'invoice.generate_from_time',
            resourceType: 'invoice',
            resourceId: invoice.id,
            details: { time_entry_count: timeEntries.length, total_usd: updatedInvoice.total_usd }
        });

        logger.info('[Invoice] Invoice generated from time entries', {
            invoiceId: invoice.id,
            timeEntryCount: timeEntries.length,
            totalUsd: updatedInvoice.total_usd
        });

        return updatedInvoice;
    }

    /**
     * Get invoice with line items and payments
     */
    async getInvoiceWithDetails(invoiceId: string): Promise<InvoiceWithDetails> {
        const invoiceResult = await this.db.query(
            `SELECT
                i.*,
                m.name as matter_name,
                c.client_name
            FROM matter_invoices i
            LEFT JOIN matters m ON i.matter_id = m.id
            LEFT JOIN clients c ON m.client_id = c.id
            WHERE i.id = $1`,
            [invoiceId]
        );

        if (invoiceResult.rows.length === 0) {
            throw new Error('Invoice not found');
        }

        const invoice = invoiceResult.rows[0];

        // Get line items
        const lineItemsResult = await this.db.query(
            `SELECT * FROM invoice_line_items
            WHERE invoice_id = $1
            ORDER BY line_order`,
            [invoiceId]
        );

        // Get payments
        const paymentsResult = await this.db.query(
            `SELECT * FROM invoice_payments
            WHERE invoice_id = $1
            ORDER BY payment_date DESC`,
            [invoiceId]
        );

        return {
            ...invoice,
            line_items: lineItemsResult.rows,
            payments: paymentsResult.rows
        };
    }

    /**
     * List invoices with filters
     */
    async listInvoices(params: ListInvoicesParams = {}): Promise<{ invoices: Invoice[]; total: number }> {
        const conditions: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        if (params.matter_id) {
            conditions.push(`i.matter_id = $${paramIndex++}`);
            values.push(params.matter_id);
        }
        if (params.status) {
            conditions.push(`i.status = $${paramIndex++}`);
            values.push(params.status);
        }
        if (params.date_from) {
            conditions.push(`i.issue_date >= $${paramIndex++}`);
            values.push(params.date_from);
        }
        if (params.date_to) {
            conditions.push(`i.issue_date <= $${paramIndex++}`);
            values.push(params.date_to);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Get total count
        const countResult = await this.db.query(
            `SELECT COUNT(*) as count FROM matter_invoices i ${whereClause}`,
            values
        );
        const total = parseInt(countResult.rows[0].count, 10);

        // Get invoices with joins
        const limit = params.limit || 100;
        const offset = params.offset || 0;

        const result = await this.db.query(
            `SELECT
                i.*,
                m.name as matter_name,
                c.client_name
            FROM matter_invoices i
            LEFT JOIN matters m ON i.matter_id = m.id
            LEFT JOIN clients c ON m.client_id = c.id
            ${whereClause}
            ORDER BY i.issue_date DESC, i.created_at DESC
            LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
            [...values, limit, offset]
        );

        return {
            invoices: result.rows,
            total
        };
    }

    /**
     * Update invoice status to sent
     */
    async sendInvoice(invoiceId: string, userId: string): Promise<Invoice> {
        const result = await this.db.query(
            `UPDATE matter_invoices
            SET status = 'sent', sent_at = NOW()
            WHERE id = $1 AND status = 'draft'
            RETURNING *`,
            [invoiceId]
        );

        if (result.rows.length === 0) {
            throw new Error('Invoice not found or already sent');
        }

        const invoice = result.rows[0];

        await this.auditService.log({
            userId,
            action: 'invoice.send',
            resourceType: 'invoice',
            resourceId: invoiceId,
            details: { matter_id: invoice.matter_id }
        });

        logger.info('[Invoice] Invoice sent', { invoiceId });

        return invoice;
    }

    /**
     * Record payment for invoice
     */
    async recordPayment(params: {
        invoice_id: string;
        amount_usd: number;
        payment_date?: string;
        payment_method?: string;
        reference_number?: string;
        notes?: string;
        recorded_by: string;
    }): Promise<InvoicePayment> {
        const result = await this.db.query(
            `INSERT INTO invoice_payments (
                invoice_id, amount_usd, payment_date, payment_method,
                reference_number, notes, recorded_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *`,
            [
                params.invoice_id,
                params.amount_usd,
                params.payment_date || new Date().toISOString().split('T')[0],
                params.payment_method || null,
                params.reference_number || null,
                params.notes || null,
                params.recorded_by
            ]
        );

        const payment = result.rows[0];

        await this.auditService.log({
            userId: params.recorded_by,
            action: 'invoice.record_payment',
            resourceType: 'invoice_payment',
            resourceId: payment.id,
            details: { invoice_id: params.invoice_id, amount_usd: params.amount_usd }
        });

        logger.info('[Invoice] Payment recorded', {
            paymentId: payment.id,
            invoiceId: params.invoice_id,
            amountUsd: params.amount_usd
        });

        return payment;
    }

    /**
     * Void invoice
     */
    async voidInvoice(invoiceId: string, userId: string): Promise<Invoice> {
        const result = await this.db.query(
            `UPDATE matter_invoices
            SET status = 'void'
            WHERE id = $1 AND status != 'paid'
            RETURNING *`,
            [invoiceId]
        );

        if (result.rows.length === 0) {
            throw new Error('Invoice not found or already paid');
        }

        const invoice = result.rows[0];

        // Unlink time entries
        await this.db.query(
            `UPDATE time_entries
            SET status = 'approved', invoice_id = NULL
            WHERE invoice_id = $1`,
            [invoiceId]
        );

        await this.auditService.log({
            userId,
            action: 'invoice.void',
            resourceType: 'invoice',
            resourceId: invoiceId,
            details: { matter_id: invoice.matter_id }
        });

        logger.info('[Invoice] Invoice voided', { invoiceId });

        return invoice;
    }

    /**
     * Generate PDF for invoice
     */
    async generatePDF(invoiceId: string): Promise<Buffer> {
        const invoice = await this.getInvoiceWithDetails(invoiceId);

        return new Promise((resolve, reject) => {
            const doc = new PDFDocument({ size: 'A4', margin: 50 });
            const buffers: Buffer[] = [];

            doc.on('data', (buffer) => buffers.push(buffer));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', reject);

            // Header
            doc.fontSize(20).text('INVOICE', { align: 'center' });
            doc.moveDown();

            // Invoice details
            doc.fontSize(10);
            doc.text(`Invoice Number: ${invoice.invoice_number}`, { align: 'right' });
            doc.text(`Issue Date: ${invoice.issue_date}`, { align: 'right' });
            doc.text(`Due Date: ${invoice.due_date}`, { align: 'right' });
            doc.text(`Status: ${invoice.status.toUpperCase()}`, { align: 'right' });
            doc.moveDown();

            // Client info
            doc.fontSize(12).text('Bill To:', { underline: true });
            doc.fontSize(10).text(invoice.client_name || 'Unknown Client');
            doc.text(invoice.matter_name || 'Unknown Matter');
            doc.moveDown(2);

            // Line items table
            const tableTop = doc.y;
            const col1 = 50;
            const col2 = 300;
            const col3 = 380;
            const col4 = 450;

            // Table header
            doc.fontSize(10).font('Helvetica-Bold');
            doc.text('Description', col1, tableTop);
            doc.text('Qty', col2, tableTop);
            doc.text('Rate', col3, tableTop);
            doc.text('Amount', col4, tableTop);
            doc.moveDown();

            // Draw line
            doc.moveTo(col1, doc.y).lineTo(550, doc.y).stroke();
            doc.moveDown(0.5);

            // Line items
            doc.font('Helvetica');
            for (const item of invoice.line_items) {
                const y = doc.y;
                doc.text(item.description, col1, y, { width: 240 });
                doc.text(item.quantity.toFixed(2), col2, y);
                doc.text(`$${item.unit_price_usd.toFixed(2)}`, col3, y);
                doc.text(`$${item.amount_usd.toFixed(2)}`, col4, y);
                doc.moveDown();
            }

            doc.moveDown();

            // Totals
            const totalsX = 450;
            doc.fontSize(10);
            doc.text(`Subtotal:`, 350, doc.y);
            doc.text(`$${invoice.subtotal_usd.toFixed(2)}`, totalsX, doc.y, { align: 'right', width: 100 });
            doc.moveDown(0.5);

            if (invoice.tax_rate > 0) {
                doc.text(`Tax (${(invoice.tax_rate * 100).toFixed(2)}%):`, 350, doc.y);
                doc.text(`$${invoice.tax_amount_usd.toFixed(2)}`, totalsX, doc.y, { align: 'right', width: 100 });
                doc.moveDown(0.5);
            }

            doc.fontSize(12).font('Helvetica-Bold');
            doc.text(`Total:`, 350, doc.y);
            doc.text(`$${invoice.total_usd.toFixed(2)}`, totalsX, doc.y, { align: 'right', width: 100 });
            doc.moveDown();

            if (invoice.amount_paid_usd > 0) {
                doc.fontSize(10).font('Helvetica');
                doc.text(`Amount Paid:`, 350, doc.y);
                doc.text(`$${invoice.amount_paid_usd.toFixed(2)}`, totalsX, doc.y, { align: 'right', width: 100 });
                doc.moveDown(0.5);

                const balance = invoice.total_usd - invoice.amount_paid_usd;
                doc.font('Helvetica-Bold');
                doc.text(`Balance Due:`, 350, doc.y);
                doc.text(`$${balance.toFixed(2)}`, totalsX, doc.y, { align: 'right', width: 100 });
            }

            doc.moveDown(2);

            // Terms and notes
            if (invoice.terms) {
                doc.fontSize(10).font('Helvetica-Bold');
                doc.text('Payment Terms:');
                doc.font('Helvetica').text(invoice.terms);
                doc.moveDown();
            }

            if (invoice.notes) {
                doc.fontSize(10).font('Helvetica-Bold');
                doc.text('Notes:');
                doc.font('Helvetica').text(invoice.notes);
            }

            doc.end();
        });
    }

    /**
     * Add manual line item to invoice
     */
    async addLineItem(params: {
        invoice_id: string;
        description: string;
        quantity: number;
        unit_price_usd: number;
        user_id: string;
    }): Promise<InvoiceLineItem> {
        const amount = params.quantity * params.unit_price_usd;

        // Get next line order
        const orderResult = await this.db.query(
            `SELECT COALESCE(MAX(line_order), -1) + 1 as max_order
            FROM invoice_line_items
            WHERE invoice_id = $1`,
            [params.invoice_id]
        );
        const lineOrder = orderResult.rows[0].max_order;

        const result = await this.db.query(
            `INSERT INTO invoice_line_items (
                invoice_id, description, quantity, unit_price_usd, amount_usd, line_order
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *`,
            [
                params.invoice_id,
                params.description,
                params.quantity,
                params.unit_price_usd,
                amount,
                lineOrder
            ]
        );

        const lineItem = result.rows[0];

        await this.auditService.log({
            userId: params.user_id,
            action: 'invoice.add_line_item',
            resourceType: 'invoice_line_item',
            resourceId: lineItem.id,
            details: { invoice_id: params.invoice_id, amount_usd: amount }
        });

        logger.info('[Invoice] Line item added', {
            lineItemId: lineItem.id,
            invoiceId: params.invoice_id,
            amountUsd: amount
        });

        return lineItem;
    }
}
