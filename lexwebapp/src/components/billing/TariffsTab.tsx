/**
 * Tariffs Tab
 * Displays pricing plans with feature comparison and FAQ
 * Fetches actual tier data from backend /api/billing/pricing-info
 */

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  Check,
  X,
  ChevronDown,
  ChevronUp,
  Zap,
  RefreshCw,
  AlertCircle,
  Crown,
  Sparkles,
} from 'lucide-react';
import { api } from '../../utils/api-client';
import showToast from '../../utils/toast';

interface TierFromBackend {
  tier: string;
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

interface PricingInfoResponse {
  current_tier: string;
  tier_config: TierFromBackend;
  recommended_tier?: string;
  monthly_spending_usd: number;
  available_tiers: TierFromBackend[];
}

interface FAQItem {
  question: string;
  answer: string;
}

// Display config per tier for UI (icons, colors, CTA text)
const TIER_UI: Record<string, {
  icon: typeof Zap;
  gradient?: string;
  borderColor: string;
}> = {
  free: {
    icon: Zap,
    borderColor: 'border-claude-border',
  },
  startup: {
    icon: Sparkles,
    borderColor: 'border-blue-400',
  },
  business: {
    icon: Crown,
    borderColor: 'border-purple-400',
  },
  enterprise: {
    icon: Crown,
    gradient: 'from-purple-600 to-indigo-600',
    borderColor: 'border-indigo-400',
  },
};

const TIER_LABELS: Record<string, string> = {
  free: 'Free',
  startup: 'Startup',
  business: 'Business',
  enterprise: 'Enterprise',
};

const TIER_DESCRIPTIONS: Record<string, string> = {
  free: 'Для знайомства з платформою',
  startup: 'Для практикуючих юристів',
  business: 'Для юридичних компаній',
  enterprise: 'Для великих організацій',
};

interface TariffsTabProps {
  onUpgradeTopUp?: (amount: number, targetTier: string) => void;
}

export function TariffsTab({ onUpgradeTopUp }: TariffsTabProps) {
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [expandedFAQ, setExpandedFAQ] = useState<number | null>(null);
  const [isUpgrading, setIsUpgrading] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [currentTier, setCurrentTier] = useState<string>('free');
  const [tiers, setTiers] = useState<TierFromBackend[]>([]);
  const [recommendedTier, setRecommendedTier] = useState<string | undefined>();

  useEffect(() => {
    fetchPricingInfo();
  }, []);

  const fetchPricingInfo = async () => {
    setIsLoading(true);
    try {
      const response = await api.billing.getPricingInfo();
      const data: PricingInfoResponse = response.data;
      setCurrentTier(data.current_tier);
      setRecommendedTier(data.recommended_tier);
      // Filter to only active, visible tiers (exclude 'internal')
      const activeTiers = (data.available_tiers || [])
        .filter((t) => t.is_active !== false && t.tier !== 'internal')
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
      setTiers(activeTiers);
    } catch (error) {
      console.error('Failed to fetch pricing info:', error);
      // Use fallback tiers
      setTiers([
        {
          tier: 'free',
          markup_percentage: 0,
          description: 'Free tier',
          features: ['Повний доступ до інструментів', 'Прозорі витрати', 'Підтримка спільноти'],
          monthly_price_usd: 0,
          annual_price_usd: 0,
          is_active: true,
          display_name: 'Free',
          display_order: 0,
        },
        {
          tier: 'startup',
          markup_percentage: 30,
          description: 'Startup tier',
          features: ['Повний доступ до інструментів', 'Email-підтримка', 'Щомісячні звіти'],
          monthly_price_usd: 29,
          annual_price_usd: 290,
          trial_days: 14,
          is_active: true,
          display_name: 'Startup',
          display_order: 1,
        },
        {
          tier: 'business',
          markup_percentage: 50,
          description: 'Business tier',
          features: ['Повний доступ до інструментів', 'Пріоритетна підтримка', 'Аналітика', 'Персональний менеджер'],
          monthly_price_usd: 99,
          annual_price_usd: 990,
          trial_days: 14,
          is_active: true,
          display_name: 'Business',
          display_order: 2,
        },
        {
          tier: 'enterprise',
          markup_percentage: 40,
          description: 'Enterprise tier',
          features: ['Без лімітів', 'Підтримка 24/7', 'SLA 99.9%', 'Власна інфраструктура'],
          monthly_price_usd: 499,
          annual_price_usd: 4990,
          trial_days: 30,
          is_active: true,
          display_name: 'Enterprise',
          display_order: 3,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const faqs: FAQItem[] = [
    {
      question: 'Чи можу я змінити тариф у будь-який час?',
      answer:
        'Так! Ви можете підвищити або знизити тариф у будь-який час. Підвищення набирає чинності одразу, зниження — з початку наступного платіжного періоду.',
    },
    {
      question: 'Як працює ціноутворення?',
      answer:
        'Кожен тариф має базову місячну вартість та відсоток націнки на API-витрати. Наприклад, на тарифі Startup ви оплачуєте 30% понад собівартість API-запитів. Тариф Free — без націнки.',
    },
    {
      question: 'Чи є безкоштовний пробний період?',
      answer:
        'Тариф Free доступний безкоштовно без обмежень у часі. Платні тарифи мають пробний період — 14 днів для Startup і Business, 30 днів для Enterprise.',
    },
    {
      question: 'Чи є знижка за річну оплату?',
      answer:
        'Так! Перейдіть на річну оплату та заощадьте ~17% на всіх тарифах. Річні підписки продовжуються автоматично.',
    },
    {
      question: 'Чи повертаєте ви кошти?',
      answer:
        'Ми гарантуємо повернення коштів протягом 30 днів для річних планів. Місячні плани можна скасувати у будь-який час без штрафів.',
    },
  ];

  // Build feature comparison matrix from backend tiers
  const featureLabels = [
    'Базова вартість / міс.',
    'Націнка на API',
    'Пробний період',
    'Інструменти пошуку',
    'Email-підтримка',
    'Пріоритетна підтримка',
    'Аналітика',
    'Персональний менеджер',
    'SLA',
    'Власна інфраструктура',
  ];

  const featureMatrix: Record<string, Record<string, boolean | string>> = {};
  for (const tier of tiers) {
    const key = tier.tier;
    const price = billingCycle === 'monthly'
      ? tier.monthly_price_usd || 0
      : tier.annual_price_usd || 0;

    featureMatrix[key] = {
      'Базова вартість / міс.': price === 0 ? 'Безкоштовно' : `$${price}`,
      'Націнка на API': tier.markup_percentage === 0 ? 'Без націнки' : `${tier.markup_percentage}%`,
      'Пробний період': tier.trial_days ? `${tier.trial_days} днів` : 'Н/д',
      'Інструменти пошуку': true,
      'Email-підтримка': key !== 'free',
      'Пріоритетна підтримка': key === 'business' || key === 'enterprise',
      'Аналітика': key === 'business' || key === 'enterprise',
      'Персональний менеджер': key === 'business' || key === 'enterprise',
      'SLA': key === 'enterprise' ? '99.9%' : false,
      'Власна інфраструктура': key === 'enterprise',
    };
  }

  const handleUpgrade = async (tierId: string) => {
    if (tierId === currentTier) return;
    if (tierId === 'enterprise') {
      window.open('mailto:sales@legal.org.ua?subject=Enterprise%20план', '_blank');
      return;
    }

    const tierOrder = ['free', 'startup', 'business', 'enterprise'];
    const currentIdx = tierOrder.indexOf(currentTier);
    const targetIdx = tierOrder.indexOf(tierId);
    const isUpgrade = targetIdx > currentIdx;

    if (isUpgrade) {
      // Calculate cost difference
      const currentTierData = tiers.find((t) => t.tier === currentTier);
      const targetTierData = tiers.find((t) => t.tier === tierId);

      const currentPrice = billingCycle === 'monthly'
        ? (currentTierData?.monthly_price_usd || 0)
        : (currentTierData?.annual_price_usd || 0);
      const targetPrice = billingCycle === 'monthly'
        ? (targetTierData?.monthly_price_usd || 0)
        : (targetTierData?.annual_price_usd || 0);

      const priceDifference = targetPrice - currentPrice;

      if (priceDifference > 0) {
        if (onUpgradeTopUp) {
          onUpgradeTopUp(priceDifference, tierId);
        }
        return;
      }
    }

    // Downgrade or free tier — apply directly
    setIsUpgrading(tierId);
    try {
      await api.billing.upgradePlan(tierId);
      setCurrentTier(tierId);
      showToast.success(`Тариф ${TIER_LABELS[tierId] || tierId} успішно активовано`);
    } catch (error) {
      console.error('Upgrade failed:', error);
      showToast.error('Не вдалося змінити тариф');
    } finally {
      setIsUpgrading(null);
    }
  };

  const getUpgradeCost = (tierId: string): number => {
    const currentTierData = tiers.find((t) => t.tier === currentTier);
    const targetTierData = tiers.find((t) => t.tier === tierId);
    const currentPrice = billingCycle === 'monthly'
      ? (currentTierData?.monthly_price_usd || 0)
      : (currentTierData?.annual_price_usd || 0);
    const targetPrice = billingCycle === 'monthly'
      ? (targetTierData?.monthly_price_usd || 0)
      : (targetTierData?.annual_price_usd || 0);
    return targetPrice - currentPrice;
  };

  const getCtaText = (tierId: string): string => {
    if (tierId === currentTier) return 'Поточний план';
    if (tierId === 'enterprise') return "Зв'язатися з нами";
    const tierOrder = ['free', 'startup', 'business', 'enterprise'];
    const currentIdx = tierOrder.indexOf(currentTier);
    const targetIdx = tierOrder.indexOf(tierId);
    if (targetIdx > currentIdx) {
      const cost = getUpgradeCost(tierId);
      if (cost > 0) return `Перейти за $${cost}${billingCycle === 'monthly' ? '/міс' : '/рік'}`;
      return `Перейти на ${TIER_LABELS[tierId] || tierId}`;
    }
    return `Знизити до ${TIER_LABELS[tierId] || tierId}`;
  };

  const isPopular = (tierId: string): boolean => {
    return tierId === 'startup';
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw size={32} className="text-claude-accent animate-spin" />
      </div>
    );
  }

  if (tiers.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle size={48} className="text-claude-subtext mx-auto mb-4" />
          <p className="text-claude-text">Не вдалося завантажити тарифи</p>
          <button
            onClick={fetchPricingInfo}
            className="mt-4 px-4 py-2 bg-claude-accent text-white rounded-lg hover:bg-opacity-90">
            Повторити
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Billing Cycle Toggle */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-center gap-4">
        <span
          className={`text-sm font-medium ${
            billingCycle === 'monthly' ? 'text-claude-text' : 'text-claude-subtext'
          }`}>
          Щомісяця
        </span>
        <button
          onClick={() => setBillingCycle(billingCycle === 'monthly' ? 'yearly' : 'monthly')}
          className={`relative inline-flex h-8 w-14 items-center rounded-full transition-colors ${
            billingCycle === 'yearly' ? 'bg-claude-accent' : 'bg-claude-border'
          }`}>
          <motion.div
            layout
            className="inline-block h-6 w-6 transform rounded-full bg-white shadow-lg"
            style={{
              marginLeft: billingCycle === 'yearly' ? '24px' : '4px',
            }}
          />
        </button>
        <div className="flex items-center gap-2">
          <span
            className={`text-sm font-medium ${
              billingCycle === 'yearly' ? 'text-claude-text' : 'text-claude-subtext'
            }`}>
            Щорічно
          </span>
          {billingCycle === 'yearly' && (
            <span className="text-xs font-semibold bg-green-100 text-green-700 px-2 py-1 rounded-full">
              Заощаджуйте ~17%
            </span>
          )}
        </div>
      </motion.div>

      {/* Plans Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {tiers.map((tier, index) => {
          const popular = isPopular(tier.tier);
          const isCurrent = tier.tier === currentTier;
          const isRecommended = tier.tier === recommendedTier;
          const price = billingCycle === 'monthly'
            ? tier.monthly_price_usd || 0
            : tier.annual_price_usd || 0;
          const isCustomPrice = tier.tier === 'enterprise';
          const ui = TIER_UI[tier.tier] || TIER_UI.free;

          return (
            <motion.div
              key={tier.tier}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
              className={`rounded-xl border-2 transition-all relative ${
                isCurrent
                  ? 'border-green-400 bg-green-50/30 shadow-lg'
                  : popular
                  ? 'border-claude-accent bg-claude-accent/5 shadow-lg scale-105'
                  : `${ui.borderColor} bg-white`
              }`}>
              {/* Badges */}
              {isCurrent && (
                <div className="bg-green-500 text-white px-4 py-2 text-center text-xs font-bold rounded-t-lg">
                  ВАШ ПОТОЧНИЙ ПЛАН
                </div>
              )}
              {!isCurrent && popular && (
                <div className="bg-claude-accent text-white px-4 py-2 text-center text-xs font-bold rounded-t-lg">
                  НАЙПОПУЛЯРНІШИЙ
                </div>
              )}
              {!isCurrent && !popular && isRecommended && (
                <div className="bg-blue-500 text-white px-4 py-2 text-center text-xs font-bold rounded-t-lg">
                  РЕКОМЕНДОВАНИЙ
                </div>
              )}

              <div className="p-6 flex flex-col h-full">
                {/* Plan Header */}
                <div className="mb-4">
                  <h3 className="text-2xl font-bold text-claude-text mb-1">
                    {tier.display_name || TIER_LABELS[tier.tier] || tier.tier}
                  </h3>
                  <p className="text-sm text-claude-subtext">
                    {TIER_DESCRIPTIONS[tier.tier] || tier.description}
                  </p>
                </div>

                {/* Pricing */}
                <div className="mb-6">
                  {isCustomPrice ? (
                    <p className="text-2xl font-bold text-claude-text">Індивідуальна ціна</p>
                  ) : price === 0 ? (
                    <div className="flex items-baseline gap-2">
                      <span className="text-4xl font-bold text-claude-text">$0</span>
                      <span className="text-sm text-claude-subtext">/міс</span>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-baseline gap-2">
                        <span className="text-4xl font-bold text-claude-text">
                          ${price}
                        </span>
                        <span className="text-sm text-claude-subtext">
                          {billingCycle === 'monthly' ? '/міс' : '/рік'}
                        </span>
                      </div>
                      {billingCycle === 'yearly' && price > 0 && (
                        <p className="text-xs text-green-600 mt-1">
                          ${(price / 12).toFixed(2)}/міс при річній оплаті
                        </p>
                      )}
                    </>
                  )}
                  {tier.markup_percentage > 0 && (
                    <p className="text-xs text-claude-subtext mt-1">
                      + {tier.markup_percentage}% на API-витрати
                    </p>
                  )}
                  {tier.markup_percentage === 0 && tier.tier !== 'enterprise' && (
                    <p className="text-xs text-green-600 mt-1">
                      Без націнки на API
                    </p>
                  )}
                </div>

                {/* CTA Button */}
                <button
                  onClick={() => handleUpgrade(tier.tier)}
                  disabled={isCurrent || isUpgrading === tier.tier}
                  className={`w-full py-3 px-4 rounded-lg font-semibold transition-all mb-6 ${
                    isCurrent
                      ? 'bg-green-100 text-green-700 border border-green-300 cursor-default'
                      : popular
                      ? 'bg-claude-accent text-white hover:bg-opacity-90'
                      : 'bg-claude-bg text-claude-text border border-claude-border hover:border-claude-accent'
                  } disabled:opacity-50`}>
                  {isUpgrading === tier.tier ? 'Обробка...' : getCtaText(tier.tier)}
                </button>

                {/* Trial info */}
                {!isCurrent && tier.trial_days && tier.trial_days > 0 && (
                  <p className="text-xs text-blue-600 text-center mb-4 -mt-4">
                    {tier.trial_days} днів безкоштовно
                  </p>
                )}

                {/* Features List */}
                <div className="space-y-3 flex-1">
                  {tier.features.map((feature, idx) => (
                    <div key={idx} className="flex items-start gap-3">
                      <Check size={18} className="text-green-500 flex-shrink-0 mt-0.5" />
                      <span className="text-sm text-claude-text">{feature}</span>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Feature Comparison Table */}
      {tiers.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="bg-white border border-claude-border rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-claude-border">
            <h3 className="text-lg font-semibold text-claude-text">Порівняння тарифів</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-claude-bg border-b border-claude-border">
                  <th className="px-6 py-4 text-left font-semibold text-claude-text w-1/3">
                    Функції
                  </th>
                  {tiers.map((tier) => (
                    <th
                      key={tier.tier}
                      className={`px-6 py-4 text-center font-semibold whitespace-nowrap ${
                        tier.tier === currentTier ? 'text-green-700 bg-green-50' : 'text-claude-text'
                      }`}>
                      {tier.display_name || TIER_LABELS[tier.tier] || tier.tier}
                      {tier.tier === currentTier && (
                        <span className="block text-xs font-normal text-green-600">Ваш план</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {featureLabels.map((feature, idx) => (
                  <tr key={idx} className={idx % 2 === 0 ? 'bg-white' : 'bg-claude-bg'}>
                    <td className="px-6 py-4 font-medium text-claude-text">{feature}</td>
                    {tiers.map((tier) => {
                      const value = featureMatrix[tier.tier]?.[feature];
                      return (
                        <td
                          key={tier.tier}
                          className={`px-6 py-4 text-center ${
                            tier.tier === currentTier ? 'bg-green-50/50' : ''
                          }`}>
                          {typeof value === 'boolean' ? (
                            value ? (
                              <Check size={20} className="text-green-500 mx-auto" />
                            ) : (
                              <X size={20} className="text-claude-border mx-auto" />
                            )
                          ) : (
                            <span className="text-sm text-claude-text">{value}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </motion.div>
      )}

      {/* FAQ Section */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}>
        <h3 className="text-2xl font-bold text-claude-text mb-6 flex items-center gap-2">
          <Zap size={24} />
          Часті запитання
        </h3>
        <div className="space-y-3">
          {faqs.map((faq, idx) => (
            <motion.div
              key={idx}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 + idx * 0.05 }}
              className="bg-white border border-claude-border rounded-lg overflow-hidden">
              <button
                onClick={() => setExpandedFAQ(expandedFAQ === idx ? null : idx)}
                className="w-full px-6 py-4 flex items-center justify-between hover:bg-claude-bg transition-colors">
                <span className="font-medium text-claude-text text-left">{faq.question}</span>
                {expandedFAQ === idx ? (
                  <ChevronUp size={20} className="text-claude-accent flex-shrink-0" />
                ) : (
                  <ChevronDown size={20} className="text-claude-subtext flex-shrink-0" />
                )}
              </button>
              {expandedFAQ === idx && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="px-6 py-4 bg-claude-bg border-t border-claude-border">
                  <p className="text-claude-text text-sm leading-relaxed">{faq.answer}</p>
                </motion.div>
              )}
            </motion.div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
