import { Router, Response } from 'express';
import { AuthenticatedRequest as DualAuthRequest } from '../middleware/dual-auth.js';
import { MatterInvoiceService } from '../services/matter-invoice-service.js';
import { logger } from '../utils/logger.js';

export function createInvoiceRoutes(invoiceService: MatterInvoiceService): Router {
  const router = Router();

  // POST /generate — generate invoice from time entries
  router.post('/generate', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const { matter_id, time_entry_ids, issue_date, due_days, tax_rate, notes, terms } = req.body;

      if (!matter_id || !time_entry_ids || !Array.isArray(time_entry_ids)) {
        return res.status(400).json({ error: 'matter_id and time_entry_ids (array) are required' });
      }

      const invoice = await invoiceService.generateFromTimeEntries({
        matter_id,
        time_entry_ids,
        issue_date,
        due_days: due_days ? parseInt(due_days) : undefined,
        tax_rate: tax_rate ? parseFloat(tax_rate) : undefined,
        notes,
        terms,
        created_by: userId
      });

      res.status(201).json(invoice);
    } catch (error: any) {
      logger.error('[InvoiceRoutes] Generate invoice failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // GET /invoices — list invoices
  router.get('/invoices', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const result = await invoiceService.listInvoices({
        user_id: userId,
        matter_id: req.query.matter_id as string,
        status: req.query.status as string,
        date_from: req.query.date_from as string,
        date_to: req.query.date_to as string,
        limit: parseInt(req.query.limit as string) || undefined,
        offset: parseInt(req.query.offset as string) || undefined,
      });

      res.json(result);
    } catch (error: any) {
      logger.error('[InvoiceRoutes] List invoices failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // GET /invoices/:invoiceId — get invoice with details
  router.get('/invoices/:invoiceId', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const invoice = await invoiceService.getInvoiceWithDetails(String(req.params.invoiceId));

      res.json(invoice);
    } catch (error: any) {
      logger.error('[InvoiceRoutes] Get invoice failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // GET /invoices/:invoiceId/pdf — download invoice PDF
  router.get('/invoices/:invoiceId/pdf', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const pdfBuffer = await invoiceService.generatePDF(String(req.params.invoiceId));

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="invoice-${String(req.params.invoiceId)}.pdf"`);
      res.send(pdfBuffer);
    } catch (error: any) {
      logger.error('[InvoiceRoutes] Generate PDF failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // POST /invoices/:invoiceId/send — send invoice
  router.post('/invoices/:invoiceId/send', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const invoice = await invoiceService.sendInvoice(String(req.params.invoiceId), userId);

      res.json(invoice);
    } catch (error: any) {
      logger.error('[InvoiceRoutes] Send invoice failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // POST /invoices/:invoiceId/payment — record payment
  router.post('/invoices/:invoiceId/payment', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const { amount_usd, payment_date, payment_method, reference_number, notes } = req.body;

      if (!amount_usd) {
        return res.status(400).json({ error: 'amount_usd is required' });
      }

      const payment = await invoiceService.recordPayment({
        invoice_id: String(req.params.invoiceId),
        amount_usd: parseFloat(amount_usd),
        payment_date,
        payment_method,
        reference_number,
        notes,
        recorded_by: userId
      });

      res.status(201).json(payment);
    } catch (error: any) {
      logger.error('[InvoiceRoutes] Record payment failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // POST /invoices/:invoiceId/void — void invoice
  router.post('/invoices/:invoiceId/void', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const invoice = await invoiceService.voidInvoice(String(req.params.invoiceId), userId);

      res.json(invoice);
    } catch (error: any) {
      logger.error('[InvoiceRoutes] Void invoice failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  // POST /invoices/:invoiceId/line-items — add manual line item
  router.post('/invoices/:invoiceId/line-items', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'User not authenticated' });

      const { description, quantity, unit_price_usd } = req.body;

      if (!description || quantity === undefined || unit_price_usd === undefined) {
        return res.status(400).json({ error: 'description, quantity, and unit_price_usd are required' });
      }

      const lineItem = await invoiceService.addLineItem({
        invoice_id: String(req.params.invoiceId),
        description,
        quantity: parseFloat(quantity),
        unit_price_usd: parseFloat(unit_price_usd),
        user_id: userId
      });

      res.status(201).json(lineItem);
    } catch (error: any) {
      logger.error('[InvoiceRoutes] Add line item failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  return router;
}
