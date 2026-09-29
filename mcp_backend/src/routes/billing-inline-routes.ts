import { Router, Response } from 'express';
import { AuthenticatedRequest as DualAuthRequest } from '../middleware/dual-auth.js';
import { logger } from '../utils/logger.js';
import { BillingService } from '../services/billing-service.js';
import { CostTracker } from '../services/cost-tracker.js';
import { InvoiceService } from '../services/invoice-service.js';
import { CurrencyService } from '../services/currency-service.js';
import { Database } from '../database/database.js';

export function createBillingInlineRoutes(deps: {
  billingService: BillingService;
  costTracker: CostTracker;
  invoiceService: InvoiceService;
  currencyService: CurrencyService;
  db: Database;
}): Router {
  const router = Router();

  // GET /balance - Get billing summary for user
  router.get('/balance', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user!.id;
      const summary = await deps.billingService.getBillingSummary(userId);

      if (!summary) {
        return res.status(404).json({
          error: 'Billing account not found',
        });
      }

      res.json({
        balance_usd: summary.balance_usd,
        balance_uah: summary.balance_uah,
        total_spent_usd: summary.total_spent_usd,
        total_requests: summary.total_requests,
        daily_limit_usd: summary.daily_limit_usd,
        monthly_limit_usd: summary.monthly_limit_usd,
        today_spending_usd: summary.today_spent_usd,
        monthly_spending_usd: summary.month_spent_usd,
        last_request_at: summary.last_request_at,
        is_active: summary.is_active,
        pricing_tier: summary.pricing_tier,
      });
    } catch (error: any) {
      logger.error('Failed to get billing balance', { error: error.message });
      res.status(500).json({
        error: 'Failed to get billing balance',
        message: error.message,
      });
    }
  }) as any);

  // GET /history - Get transaction history with pagination
  router.get('/history', (async (req: DualAuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const type = req.query.type as string;

      const transactions = await deps.billingService.getTransactionHistory(userId, {
        limit,
        offset,
        type,
      });

      res.json({
        success: true,
        transactions,
        pagination: {
          limit,
          offset,
          count: transactions.length,
        },
      });
    } catch (error: any) {
      logger.error('Failed to get billing history', { error: error.message });
      res.status(500).json({
        error: 'Failed to get billing history',
        message: error.message,
      });
    }
  }) as any);

  // POST /topup was removed on purpose (29.09.2026). It credited the caller's balance with
  // whatever amount_usd the request body carried, behind nothing but a login, so any user
  // could mint balance. Real top-ups go through the payment providers (Monobank, NOWPayments,
  // Binance Pay, MetaMask, B2B invoices); manual credits go through the admin
  // POST /api/admin/users/:id/adjust-balance endpoint. Do not re-add a self-serve top-up.

  // GET /settings - Get billing settings
  router.get('/settings', (async (req: DualAuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const summary = await deps.billingService.getBillingSummary(userId);
      const emailPrefs = await deps.billingService.getEmailPreferences(userId);

      res.json({
        daily_limit_usd: summary?.daily_limit_usd ?? 50,
        monthly_limit_usd: summary?.monthly_limit_usd ?? 1000,
        email_notifications: emailPrefs?.email_notifications ?? true,
        notify_low_balance: emailPrefs?.notify_low_balance ?? true,
        notify_payment_success: emailPrefs?.notify_payment_success ?? true,
        notify_payment_failure: emailPrefs?.notify_payment_failure ?? false,
        notify_monthly_report: emailPrefs?.notify_monthly_report ?? true,
        low_balance_threshold_usd: emailPrefs?.low_balance_threshold_usd ?? 20,
      });
    } catch (error: any) {
      logger.error('Failed to get billing settings', { error: error.message });
      res.status(500).json({ error: 'Failed to get billing settings' });
    }
  }) as any);

  // GET /statistics - Get billing statistics with period param
  router.get('/statistics', (async (req: DualAuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const period = (req.query.period as string) || '30d';

      // Query cost_tracking for aggregated stats
      let intervalSql = '30 days';
      if (period === '7d') intervalSql = '7 days';
      else if (period === '90d') intervalSql = '90 days';
      else if (period === 'year') intervalSql = '365 days';

      const statusFilter = "AND status = 'completed'";

      const statsQuery = `
        SELECT
          COUNT(*) as total_requests,
          COALESCE(SUM(total_cost_usd), 0) as total_cost,
          COALESCE(SUM(openai_prompt_tokens + openai_completion_tokens), 0) as total_tokens,
          COALESCE(AVG(total_cost_usd), 0) as avg_cost_per_request
        FROM cost_tracking
        WHERE user_id = $1
          ${statusFilter}
          AND created_at >= NOW() - INTERVAL '${intervalSql}'
      `;
      const statsResult = await deps.db.query(statsQuery, [userId]);
      const stats = statsResult.rows[0] || {};

      const dailyQuery = `
        SELECT
          TO_CHAR(created_at::date, 'DD.MM') as date,
          COUNT(*) as requests,
          COALESCE(SUM(total_cost_usd), 0) as cost
        FROM cost_tracking
        WHERE user_id = $1
          ${statusFilter}
          AND created_at >= NOW() - INTERVAL '${intervalSql}'
        GROUP BY created_at::date
        ORDER BY created_at::date
      `;
      const dailyResult = await deps.db.query(dailyQuery, [userId]);

      const toolsQuery = `
        SELECT
          tool_name as name,
          COUNT(*) as count,
          COALESCE(SUM(total_cost_usd), 0) as cost
        FROM cost_tracking
        WHERE user_id = $1
          ${statusFilter}
          AND created_at >= NOW() - INTERVAL '${intervalSql}'
          AND tool_name IS NOT NULL
        GROUP BY tool_name
        ORDER BY count DESC
        LIMIT 10
      `;
      const toolsResult = await deps.db.query(toolsQuery, [userId]);

      // Cost breakdown by tool
      const costByServiceQuery = `
        SELECT
          tool_name as name,
          COALESCE(SUM(total_cost_usd), 0) as value
        FROM cost_tracking
        WHERE user_id = $1
          ${statusFilter}
          AND created_at >= NOW() - INTERVAL '${intervalSql}'
          AND tool_name IS NOT NULL
        GROUP BY tool_name
        ORDER BY value DESC
        LIMIT 8
      `;
      const costByServiceResult = await deps.db.query(costByServiceQuery, [userId]);

      // Previous period comparison
      const prevStatsQuery = `
        SELECT
          COUNT(*) as total_requests,
          COALESCE(SUM(total_cost_usd), 0) as total_cost
        FROM cost_tracking
        WHERE user_id = $1
          ${statusFilter}
          AND created_at >= NOW() - INTERVAL '${intervalSql}' * 2
          AND created_at < NOW() - INTERVAL '${intervalSql}'
      `;
      const prevStatsResult = await deps.db.query(prevStatsQuery, [userId]);
      const prevStats = prevStatsResult.rows[0] || {};

      const totalReqs = parseInt(stats.total_requests) || 0;
      const prevTotalReqs = parseInt(prevStats.total_requests) || 0;
      const prevTotalCost = parseFloat(prevStats.total_cost) || 0;

      const topTools = toolsResult.rows.map((t: any) => ({
        name: t.name,
        count: parseInt(t.count),
        cost: parseFloat(t.cost) || 0,
        percentage: totalReqs > 0 ? Math.round((parseInt(t.count) / totalReqs) * 100) : 0,
      }));

      const serviceColors = ['#D97757', '#C66345', '#B55133', '#A43F21', '#932D0F', '#823C1E', '#6B2E15', '#54200C'];
      const costByService = costByServiceResult.rows.map((s: any, idx: number) => ({
        name: s.name,
        value: parseFloat(s.value) || 0,
        color: serviceColors[idx % serviceColors.length],
      }));

      res.json({
        period,
        totalRequests: totalReqs,
        totalCost: parseFloat(stats.total_cost) || 0,
        openaiTokens: parseInt(stats.total_tokens) || 0,
        avgCostPerRequest: parseFloat(stats.avg_cost_per_request) || 0,
        costByService,
        topTools,
        dailyData: dailyResult.rows.map((d: any) => ({
          date: d.date,
          requests: parseInt(d.requests),
          cost: parseFloat(d.cost) || 0,
        })),
        previousPeriod: {
          totalRequests: prevTotalReqs,
          totalCost: prevTotalCost,
          requestsChange: prevTotalReqs > 0 ? Math.round(((totalReqs - prevTotalReqs) / prevTotalReqs) * 100) : 0,
          costChange: prevTotalCost > 0 ? Math.round(((parseFloat(stats.total_cost) - prevTotalCost) / prevTotalCost) * 100) : 0,
        },
      });
    } catch (error: any) {
      logger.error('Failed to get billing statistics', { error: error.message });
      res.status(500).json({ error: 'Failed to get billing statistics' });
    }
  }) as any);

  // NOTE: GET /payment-methods is handled by billing-routes.ts (real implementation)
  // Do NOT add a stub here — it would shadow the real endpoint

  // PUT /settings - Update billing settings
  router.put('/settings', (async (req: DualAuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const {
        daily_limit_usd,
        monthly_limit_usd,
        email_notifications,
        notify_low_balance,
        notify_payment_success,
        notify_payment_failure,
        notify_monthly_report,
        low_balance_threshold_usd,
      } = req.body;

      const settings: any = {};
      if (daily_limit_usd !== undefined) settings.dailyLimitUsd = daily_limit_usd;
      if (monthly_limit_usd !== undefined) settings.monthlyLimitUsd = monthly_limit_usd;
      if (email_notifications !== undefined) settings.email_notifications = email_notifications;
      if (notify_low_balance !== undefined) settings.notify_low_balance = notify_low_balance;
      if (notify_payment_success !== undefined) settings.notify_payment_success = notify_payment_success;
      if (notify_payment_failure !== undefined) settings.notify_payment_failure = notify_payment_failure;
      if (notify_monthly_report !== undefined) settings.notify_monthly_report = notify_monthly_report;
      if (low_balance_threshold_usd !== undefined) settings.low_balance_threshold_usd = low_balance_threshold_usd;

      await deps.billingService.updateBillingSettings(userId, settings);

      res.json({
        success: true,
        message: 'Billing settings updated',
      });
    } catch (error: any) {
      logger.error('Failed to update billing settings', { error: error.message });
      res.status(500).json({
        error: 'Failed to update billing settings',
        message: error.message,
      });
    }
  }) as any);

  // GET /email-preferences - Get email notification preferences
  router.get('/email-preferences', (async (req: DualAuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const preferences = await deps.billingService.getEmailPreferences(userId);
      res.json(preferences);
    } catch (error: any) {
      logger.error('Failed to get email preferences', { error: error.message });
      res.status(500).json({
        error: 'Failed to get email preferences',
        message: error.message,
      });
    }
  }) as any);

  // GET /invoices - Get invoice list with pagination
  router.get('/invoices', (async (req: DualAuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const query = `
        SELECT
          bt.id as transaction_id,
          bt.invoice_number,
          bt.created_at as date,
          bt.amount_usd,
          bt.amount_uah,
          bt.description,
          bt.payment_provider,
          bt.payment_id,
          bt.invoice_generated_at,
          u.name as user_name,
          u.email as user_email
        FROM billing_transactions bt
        JOIN users u ON bt.user_id = u.id
        WHERE bt.user_id = $1
          AND bt.type = 'topup'
          AND bt.invoice_number IS NOT NULL
        ORDER BY bt.created_at DESC
        LIMIT $2 OFFSET $3
      `;
      const result = await deps.db.query(query, [userId, limit, offset]);

      const invoices = result.rows.map((row: any) => {
        const amount = parseFloat(row.amount_usd) || parseFloat(row.amount_uah) || 0;
        const currency = parseFloat(row.amount_usd) > 0 ? 'USD' : 'UAH';
        return {
          invoiceNumber: row.invoice_number,
          date: row.date,
          customerName: row.user_name || 'Customer',
          customerEmail: row.user_email || '',
          amount,
          currency,
          paymentMethod: row.payment_provider || 'Unknown',
          status: 'paid',
          transactionId: row.transaction_id,
          paymentId: row.payment_id,
        };
      });

      const countQuery = `
        SELECT COUNT(*) FROM billing_transactions
        WHERE user_id = $1 AND type = 'topup' AND invoice_number IS NOT NULL
      `;
      const countResult = await deps.db.query(countQuery, [userId]);
      const total = parseInt(countResult.rows[0].count);

      res.json({
        invoices,
        total,
        hasMore: offset + result.rows.length < total,
      });
    } catch (error: any) {
      logger.error('Failed to get invoices', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve invoices' });
    }
  }) as any);

  // GET /invoices/:invoiceNumber/pdf - Generate and download invoice PDF
  router.get('/invoices/:invoiceNumber/pdf', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user!.id;
      const { invoiceNumber } = req.params;

      const query = `
        SELECT
          bt.id,
          bt.amount_usd,
          bt.amount_uah,
          bt.payment_provider,
          bt.payment_id,
          bt.created_at,
          bt.invoice_number,
          u.name as user_name,
          u.email as user_email
        FROM billing_transactions bt
        JOIN users u ON bt.user_id = u.id
        WHERE bt.invoice_number = $1 AND bt.user_id = $2
      `;
      const result = await deps.db.query(query, [invoiceNumber, userId]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Invoice not found' });
      }

      const tx = result.rows[0];
      const amount = parseFloat(tx.amount_usd) || parseFloat(tx.amount_uah) || 0;
      const currency: 'USD' | 'UAH' = parseFloat(tx.amount_usd) > 0 ? 'USD' : 'UAH';

      const invoiceData = deps.invoiceService.createInvoiceFromTransaction(
        tx.id,
        tx.invoice_number,
        tx.user_name || 'Customer',
        tx.user_email || '',
        amount,
        currency,
        tx.payment_provider || 'Unknown',
        new Date(tx.created_at),
        tx.payment_id
      );

      const pdfBuffer = await deps.invoiceService.generateInvoicePDF(invoiceData);

      // Update generation timestamp
      await deps.db.query(
        `UPDATE billing_transactions SET invoice_generated_at = NOW() WHERE id = $1`,
        [tx.id]
      );

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${invoiceNumber}.pdf"`);
      res.send(pdfBuffer);

      logger.info('Invoice PDF generated', { invoiceNumber, userId });
    } catch (error: any) {
      logger.error('Failed to generate invoice PDF', { error: error.message });
      res.status(500).json({ error: 'Failed to generate invoice' });
    }
  }) as any);

  return router;
}
