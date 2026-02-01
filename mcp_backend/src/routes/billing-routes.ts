/**
 * Billing and User Preferences API Routes
 * Handles billing info, user preferences, and cost estimation
 */

import express, { Request, Response } from 'express';
import { Database } from '../database/database.js';
import { BillingService } from '../services/billing-service.js';
import { UserPreferencesService } from '../services/user-preferences-service.js';
import { PricingService } from '../services/pricing-service.js';
import { logger } from '../utils/logger.js';

export function createBillingRoutes(db: Database): express.Router {
  const router = express.Router();
  const billingService = new BillingService(db);
  const preferencesService = new UserPreferencesService(db);
  const pricingService = new PricingService();

  /**
   * GET /api/billing/balance
   * Get user's current balance and billing info
   */
  router.get('/balance', async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const summary = await billingService.getBillingSummary(userId);

      if (!summary) {
        return res.status(404).json({ error: 'Billing account not found' });
      }

      res.json({
        user_id: summary.user_id,
        balance_usd: summary.balance_usd,
        balance_uah: summary.balance_uah,
        total_spent_usd: summary.total_spent_usd,
        total_requests: summary.total_requests,
        daily_limit_usd: summary.daily_limit_usd,
        monthly_limit_usd: summary.monthly_limit_usd,
        pricing_tier: summary.pricing_tier,
        today_spent_usd: summary.today_spent_usd,
        month_spent_usd: summary.month_spent_usd,
        last_request_at: summary.last_request_at,
      });
    } catch (error: any) {
      logger.error('Failed to get balance', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve balance' });
    }
  });

  /**
   * GET /api/billing/history
   * Get user's transaction history
   */
  router.get('/history', async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
      const offset = Math.max(0, Number(req.query.offset || 0));
      const type = req.query.type as string | undefined;

      const transactions = await billingService.getTransactionHistory(userId, {
        limit,
        offset,
        type,
      });

      res.json({
        transactions,
        pagination: {
          limit,
          offset,
          count: transactions.length,
        },
      });
    } catch (error: any) {
      logger.error('Failed to get transaction history', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve transaction history' });
    }
  });

  /**
   * GET /api/billing/pricing-info
   * Get user's current pricing tier and available tiers
   */
  router.get('/pricing-info', async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const pricingInfo = await billingService.getUserPricingInfo(userId);
      const allTiers = billingService.getAllPricingTiers();

      res.json({
        current_tier: pricingInfo.current_tier,
        tier_config: pricingInfo.tier_config,
        recommended_tier: pricingInfo.recommended_tier,
        monthly_spending_usd: pricingInfo.monthly_spending_usd,
        available_tiers: allTiers,
      });
    } catch (error: any) {
      logger.error('Failed to get pricing info', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve pricing information' });
    }
  });

  /**
   * PUT /api/billing/settings
   * Update user billing settings (limits, tier)
   */
  router.put('/settings', async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { dailyLimitUsd, monthlyLimitUsd, pricingTier } = req.body;

      await billingService.updateBillingSettings(userId, {
        dailyLimitUsd: dailyLimitUsd !== undefined ? Number(dailyLimitUsd) : undefined,
        monthlyLimitUsd: monthlyLimitUsd !== undefined ? Number(monthlyLimitUsd) : undefined,
        pricingTier,
      });

      res.json({ success: true, message: 'Billing settings updated' });
    } catch (error: any) {
      logger.error('Failed to update billing settings', { error: error.message });
      res.status(400).json({ error: error.message });
    }
  });

  /**
   * GET /api/billing/preferences
   * Get user's request preferences
   */
  router.get('/preferences', async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const preferences = await preferencesService.getUserPreferences(userId);

      res.json(preferences);
    } catch (error: any) {
      logger.error('Failed to get user preferences', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve preferences' });
    }
  });

  /**
   * PUT /api/billing/preferences
   * Update user's request preferences
   */
  router.put('/preferences', async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const preferences = req.body;
      const updated = await preferencesService.upsertPreferences(userId, preferences);

      res.json(updated);
    } catch (error: any) {
      logger.error('Failed to update user preferences', { error: error.message });
      res.status(400).json({ error: error.message });
    }
  });

  /**
   * POST /api/billing/preferences/preset
   * Apply a preset configuration to user preferences
   */
  router.post('/preferences/preset', async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { preset } = req.body;
      if (!preset || !['economy', 'balanced', 'quality'].includes(preset)) {
        return res.status(400).json({ error: 'Invalid preset. Must be economy, balanced, or quality' });
      }

      const updated = await preferencesService.applyPreset(userId, preset);

      res.json({ success: true, preferences: updated });
    } catch (error: any) {
      logger.error('Failed to apply preset', { error: error.message });
      res.status(400).json({ error: error.message });
    }
  });

  /**
   * GET /api/billing/presets
   * Get all available preset configurations
   */
  router.get('/presets', async (req: Request, res: Response) => {
    try {
      const presets = await preferencesService.getAllPresets();
      res.json({ presets });
    } catch (error: any) {
      logger.error('Failed to get presets', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve presets' });
    }
  });

  /**
   * POST /api/billing/estimate-costs
   * Estimate costs for different presets based on query
   */
  router.post('/estimate-costs', async (req: Request, res: Response) => {
    try {
      const { query, queryLength } = req.body;
      const length = queryLength || query?.length || 100;

      const estimates = await preferencesService.estimateCostsForPresets(length);

      res.json({ estimates });
    } catch (error: any) {
      logger.error('Failed to estimate costs', { error: error.message });
      res.status(500).json({ error: 'Failed to estimate costs' });
    }
  });

  /**
   * GET /api/billing/full-settings
   * Get combined billing and preference settings
   */
  router.get('/full-settings', async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const settings = await preferencesService.getUserFullSettings(userId);

      if (!settings) {
        return res.status(404).json({ error: 'User settings not found' });
      }

      res.json(settings);
    } catch (error: any) {
      logger.error('Failed to get full settings', { error: error.message });
      res.status(500).json({ error: 'Failed to retrieve settings' });
    }
  });

  /**
   * POST /api/billing/estimate-price
   * Calculate estimated price for a given cost with user's tier
   */
  router.post('/estimate-price', async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { costUsd } = req.body;
      if (costUsd === undefined || isNaN(Number(costUsd))) {
        return res.status(400).json({ error: 'costUsd is required and must be a number' });
      }

      const tier = await billingService.getUserPricingTier(userId);
      const priceCalc = billingService.calculateEstimatedPrice(Number(costUsd), tier);

      res.json(priceCalc);
    } catch (error: any) {
      logger.error('Failed to estimate price', { error: error.message });
      res.status(500).json({ error: 'Failed to estimate price' });
    }
  });

  return router;
}
