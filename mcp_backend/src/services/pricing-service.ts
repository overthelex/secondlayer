/**
 * Pricing Service
 * Manages pricing tiers and markup calculations for SecondLayer startup
 *
 * DB-backed with in-memory cache and hardcoded fallback.
 *
 * Pricing Strategy:
 * - FREE tier: 0% markup (cost pass-through for early adopters)
 * - STARTUP tier: 30% markup (standard commercial tier)
 * - BUSINESS tier: 50% markup (premium features + priority support)
 * - ENTERPRISE tier: Custom pricing (negotiated contracts)
 */

import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';

export type PricingTier = 'free' | 'startup' | 'business' | 'enterprise' | 'internal';

export interface PricingConfig {
  tier: PricingTier;
  markup_percentage: number;
  description: string;
  features: string[];
  monthly_price_usd?: number;
  annual_price_usd?: number;
  trial_days?: number;
  is_active?: boolean;
  display_name?: string;
  display_order?: number;
}

export interface PriceCalculation {
  cost_usd: number;                // Our actual cost
  markup_percentage: number;        // Applied markup
  markup_amount_usd: number;        // $ markup amount
  price_usd: number;                // What we charge the client
  tier: PricingTier;
}

export class PricingService {
  private db: Database | null;
  private cache: Map<string, PricingConfig> | null = null;
  private cacheLoadedAt: number = 0;
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // Hardcoded fallback pricing tier configurations
  private static readonly FALLBACK_TIERS: Record<PricingTier, PricingConfig> = {
    free: {
      tier: 'free',
      markup_percentage: 0,
      description: 'Free tier - cost pass-through (early adopters, testing)',
      features: [
        'Full access to all tools',
        'Cost transparency (you pay what we pay)',
        'Community support',
        'Rate limits apply',
      ],
      monthly_price_usd: 0,
      annual_price_usd: 0,
      trial_days: 0,
      is_active: true,
      display_name: 'Free',
      display_order: 0,
    },
    startup: {
      tier: 'startup',
      markup_percentage: 30,
      description: 'Startup tier - 30% markup (standard commercial)',
      features: [
        'Full access to all tools',
        '30% markup on API costs',
        'Email support (24-48h response)',
        'Standard rate limits',
        'Monthly usage reports',
      ],
      monthly_price_usd: 29,
      annual_price_usd: 290,
      trial_days: 14,
      is_active: true,
      display_name: 'Startup',
      display_order: 1,
    },
    business: {
      tier: 'business',
      markup_percentage: 50,
      description: 'Business tier - 50% markup (premium + priority)',
      features: [
        'Full access to all tools',
        '50% markup on API costs',
        'Priority email support (12h response)',
        'Higher rate limits',
        'Dedicated account manager',
        'Custom integrations support',
        'Advanced analytics dashboard',
      ],
      monthly_price_usd: 99,
      annual_price_usd: 990,
      trial_days: 14,
      is_active: true,
      display_name: 'Business',
      display_order: 2,
    },
    enterprise: {
      tier: 'enterprise',
      markup_percentage: 40,
      description: 'Enterprise tier - Custom pricing (negotiated)',
      features: [
        'Full access to all tools',
        '40% markup (negotiable)',
        'Priority 24/7 support',
        'No rate limits',
        'Dedicated infrastructure',
        'SLA guarantees (99.9% uptime)',
        'Custom tool development',
        'On-premise deployment options',
      ],
      monthly_price_usd: 499,
      annual_price_usd: 4990,
      trial_days: 30,
      is_active: true,
      display_name: 'Enterprise',
      display_order: 3,
    },
    internal: {
      tier: 'internal',
      markup_percentage: 0,
      description: 'Internal use - no markup',
      features: [
        'Internal SecondLayer team usage',
        'Cost pass-through for testing/development',
      ],
      monthly_price_usd: 0,
      annual_price_usd: 0,
      trial_days: 0,
      is_active: false,
      display_name: 'Internal',
      display_order: 99,
    },
  };

  constructor(db?: Database) {
    this.db = db || null;
  }

  /**
   * Load tiers from DB into cache, fall back to hardcoded on error / missing table
   */
  private async loadTiers(): Promise<Map<string, PricingConfig>> {
    if (this.cache && (Date.now() - this.cacheLoadedAt) < PricingService.CACHE_TTL_MS) {
      return this.cache;
    }

    const map = new Map<string, PricingConfig>();

    if (this.db) {
      try {
        const result = await this.db.query(
          `SELECT * FROM pricing_tiers ORDER BY display_order ASC`
        );
        if (result.rows.length > 0) {
          for (const row of result.rows) {
            const tier = row.tier_key as PricingTier;
            map.set(tier, {
              tier,
              markup_percentage: Number(row.markup_percentage),
              description: row.description || '',
              features: Array.isArray(row.features) ? row.features : [],
              monthly_price_usd: Number(row.monthly_price_usd) || 0,
              annual_price_usd: Number(row.annual_price_usd) || 0,
              trial_days: Number(row.trial_days) || 0,
              is_active: row.is_active ?? true,
              display_name: row.display_name || tier,
              display_order: Number(row.display_order) || 0,
            });
          }
          this.cache = map;
          this.cacheLoadedAt = Date.now();
          return map;
        }
      } catch (err: any) {
        logger.warn('Failed to load pricing tiers from DB, using fallback', { error: err.message });
      }
    }

    // Fallback: populate from hardcoded
    for (const [key, config] of Object.entries(PricingService.FALLBACK_TIERS)) {
      map.set(key, config);
    }
    this.cache = map;
    this.cacheLoadedAt = Date.now();
    return map;
  }

  /** Invalidate cache so next call re-reads from DB */
  invalidateCache(): void {
    this.cache = null;
    this.cacheLoadedAt = 0;
  }

  /**
   * Calculate price with markup for a given cost and tier
   */
  calculatePrice(costUsd: number, tier: PricingTier = 'startup'): PriceCalculation {
    // Synchronous: use cache or fallback directly
    const config = this.cache?.get(tier) || PricingService.FALLBACK_TIERS[tier];

    if (!config) {
      logger.warn('Invalid pricing tier, defaulting to startup', { tier });
      return this.calculatePrice(costUsd, 'startup');
    }

    const markupPercentage = config.markup_percentage;
    const markupAmount = costUsd * (markupPercentage / 100);
    const priceUsd = costUsd + markupAmount;

    const calculation: PriceCalculation = {
      cost_usd: Number(costUsd.toFixed(6)),
      markup_percentage: markupPercentage,
      markup_amount_usd: Number(markupAmount.toFixed(6)),
      price_usd: Number(priceUsd.toFixed(6)),
      tier,
    };

    logger.debug('Price calculated', {
      tier,
      cost: `$${calculation.cost_usd.toFixed(6)}`,
      markup: `${markupPercentage}%`,
      price: `$${calculation.price_usd.toFixed(6)}`,
    });

    return calculation;
  }

  /**
   * Get pricing configuration for a tier
   */
  getTierConfig(tier: PricingTier): PricingConfig {
    return this.cache?.get(tier) || PricingService.FALLBACK_TIERS[tier];
  }

  /**
   * Get all available pricing tiers (async — reads DB)
   */
  async getAllTiersAsync(): Promise<PricingConfig[]> {
    const map = await this.loadTiers();
    return Array.from(map.values());
  }

  /**
   * Get all available pricing tiers (sync — cache or fallback)
   */
  getAllTiers(): PricingConfig[] {
    if (this.cache) {
      return Array.from(this.cache.values());
    }
    return Object.values(PricingService.FALLBACK_TIERS);
  }

  /**
   * Update a tier in the DB and invalidate cache
   */
  async updateTier(tierKey: string, updates: Partial<PricingConfig>): Promise<void> {
    if (!this.db) throw new Error('No database connection');

    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (updates.markup_percentage !== undefined) {
      sets.push(`markup_percentage = $${idx++}`);
      params.push(updates.markup_percentage);
    }
    if (updates.monthly_price_usd !== undefined) {
      sets.push(`monthly_price_usd = $${idx++}`);
      params.push(updates.monthly_price_usd);
    }
    if (updates.annual_price_usd !== undefined) {
      sets.push(`annual_price_usd = $${idx++}`);
      params.push(updates.annual_price_usd);
    }
    if (updates.trial_days !== undefined) {
      sets.push(`trial_days = $${idx++}`);
      params.push(updates.trial_days);
    }
    if (updates.is_active !== undefined) {
      sets.push(`is_active = $${idx++}`);
      params.push(updates.is_active);
    }
    if (updates.description !== undefined) {
      sets.push(`description = $${idx++}`);
      params.push(updates.description);
    }
    if (updates.features !== undefined) {
      sets.push(`features = $${idx++}`);
      params.push(JSON.stringify(updates.features));
    }
    if (updates.display_name !== undefined) {
      sets.push(`display_name = $${idx++}`);
      params.push(updates.display_name);
    }
    if (updates.display_order !== undefined) {
      sets.push(`display_order = $${idx++}`);
      params.push(updates.display_order);
    }

    if (sets.length === 0) return;

    sets.push(`updated_at = NOW()`);
    params.push(tierKey);
    await this.db.query(
      `UPDATE pricing_tiers SET ${sets.join(', ')} WHERE tier_key = $${idx}`,
      params
    );

    this.invalidateCache();
    logger.info('Pricing tier updated', { tierKey, updates });
  }

  /**
   * Determine recommended tier based on monthly spending
   * (This can be used for upsell recommendations)
   */
  getRecommendedTier(monthlySpendingUsd: number): PricingTier {
    if (monthlySpendingUsd === 0) {
      return 'free';
    } else if (monthlySpendingUsd < 100) {
      return 'startup';
    } else if (monthlySpendingUsd < 500) {
      return 'business';
    } else {
      return 'enterprise';
    }
  }

  /**
   * Calculate volume discount for high-spending users
   * This can be applied on top of tier markup
   */
  calculateVolumeDiscount(monthlySpendingUsd: number): number {
    // Volume discounts (applied AFTER tier markup)
    if (monthlySpendingUsd >= 1000) {
      return 0.15; // 15% discount for $1000+/month
    } else if (monthlySpendingUsd >= 500) {
      return 0.10; // 10% discount for $500+/month
    } else if (monthlySpendingUsd >= 250) {
      return 0.05; // 5% discount for $250+/month
    }
    return 0;
  }

  /**
   * Calculate final price with volume discount
   */
  calculatePriceWithDiscount(
    costUsd: number,
    tier: PricingTier,
    monthlySpendingUsd: number
  ): PriceCalculation & { volume_discount_percentage: number; final_price_usd: number } {
    const baseCalculation = this.calculatePrice(costUsd, tier);
    const volumeDiscount = this.calculateVolumeDiscount(monthlySpendingUsd);
    const discountAmount = baseCalculation.price_usd * volumeDiscount;
    const finalPrice = baseCalculation.price_usd - discountAmount;

    return {
      ...baseCalculation,
      volume_discount_percentage: volumeDiscount * 100,
      final_price_usd: Number(finalPrice.toFixed(6)),
    };
  }

  /**
   * Estimate monthly revenue from a user
   */
  estimateMonthlyRevenue(
    avgDailyCostUsd: number,
    tier: PricingTier,
    daysInMonth: number = 30
  ): {
    monthly_cost_usd: number;
    monthly_price_usd: number;
    monthly_profit_usd: number;
    profit_margin_percentage: number;
  } {
    const monthlyCost = avgDailyCostUsd * daysInMonth;
    const calculation = this.calculatePrice(monthlyCost, tier);

    return {
      monthly_cost_usd: calculation.cost_usd,
      monthly_price_usd: calculation.price_usd,
      monthly_profit_usd: calculation.markup_amount_usd,
      profit_margin_percentage: calculation.markup_percentage,
    };
  }

  /**
   * Generate pricing comparison table for all tiers
   */
  generatePricingComparison(exampleCostUsd: number = 10.0): {
    example_cost: number;
    tiers: Array<{
      tier: PricingTier;
      markup: string;
      price: string;
      profit: string;
      description: string;
    }>;
  } {
    const tiers = ['free', 'startup', 'business', 'enterprise'] as PricingTier[];

    return {
      example_cost: exampleCostUsd,
      tiers: tiers.map((tier) => {
        const calc = this.calculatePrice(exampleCostUsd, tier);
        const config = this.getTierConfig(tier);

        return {
          tier,
          markup: `${calc.markup_percentage}%`,
          price: `$${calc.price_usd.toFixed(2)}`,
          profit: `$${calc.markup_amount_usd.toFixed(2)}`,
          description: config.description,
        };
      }),
    };
  }

  /**
   * Validate tier name
   */
  isValidTier(tier: string): tier is PricingTier {
    return tier in PricingService.FALLBACK_TIERS;
  }

  /**
   * Get default tier for new users
   */
  getDefaultTier(): PricingTier {
    return 'startup'; // New users start on startup tier by default
  }
}
