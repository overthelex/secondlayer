/**
 * Pricing Service
 * Manages pricing tiers and markup calculations for SecondLayer startup
 *
 * Pricing Strategy:
 * - FREE tier: 0% markup (cost pass-through for early adopters)
 * - STARTUP tier: 30% markup (standard commercial tier)
 * - BUSINESS tier: 50% markup (premium features + priority support)
 * - ENTERPRISE tier: Custom pricing (negotiated contracts)
 */

import { logger } from '../utils/logger.js';

export type PricingTier = 'free' | 'startup' | 'business' | 'enterprise' | 'internal';

export interface PricingConfig {
  tier: PricingTier;
  markup_percentage: number;
  description: string;
  features: string[];
}

export interface PriceCalculation {
  cost_usd: number;                // Our actual cost
  markup_percentage: number;        // Applied markup
  markup_amount_usd: number;        // $ markup amount
  price_usd: number;                // What we charge the client
  tier: PricingTier;
}

export class PricingService {
  // Pricing tier configurations
  private readonly PRICING_TIERS: Record<PricingTier, PricingConfig> = {
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
    },
    internal: {
      tier: 'internal',
      markup_percentage: 0,
      description: 'Internal use - no markup',
      features: [
        'Internal SecondLayer team usage',
        'Cost pass-through for testing/development',
      ],
    },
  };

  /**
   * Calculate price with markup for a given cost and tier
   */
  calculatePrice(costUsd: number, tier: PricingTier = 'startup'): PriceCalculation {
    const config = this.PRICING_TIERS[tier];

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
    return this.PRICING_TIERS[tier];
  }

  /**
   * Get all available pricing tiers
   */
  getAllTiers(): PricingConfig[] {
    return Object.values(this.PRICING_TIERS);
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
    return tier in this.PRICING_TIERS;
  }

  /**
   * Get default tier for new users
   */
  getDefaultTier(): PricingTier {
    return 'startup'; // New users start on startup tier by default
  }
}
