/**
 * Tariffs Tab
 * Displays pricing plans with feature comparison and FAQ
 */

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Check,
  X,
  ChevronDown,
  ChevronUp,
  Zap,
} from 'lucide-react';
import { api } from '../../utils/api-client';
import showToast from '../../utils/toast';

interface PricingPlan {
  id: string;
  name: string;
  monthlyPrice: number;
  yearlyPrice: number;
  description: string;
  features: string[];
  popular: boolean;
  ctaText: string;
}

interface FAQItem {
  question: string;
  answer: string;
}

export function TariffsTab() {
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [expandedFAQ, setExpandedFAQ] = useState<number | null>(null);
  const [isUpgrading, setIsUpgrading] = useState<string | null>(null);

  const plans: PricingPlan[] = [
    {
      id: 'free',
      name: 'Free',
      monthlyPrice: 0,
      yearlyPrice: 0,
      description: 'Perfect for getting started',
      features: [
        'Up to 100 requests/month',
        'Basic search tools',
        '2 team members',
        'Email support',
        'Community access',
      ],
      popular: false,
      ctaText: 'Current Plan',
    },
    {
      id: 'professional',
      name: 'Professional',
      monthlyPrice: 29,
      yearlyPrice: 290,
      description: 'For professional users',
      features: [
        'Up to 5,000 requests/month',
        'Advanced search & analytics',
        '10 team members',
        'Priority email support',
        'Custom integrations',
        'Usage analytics dashboard',
      ],
      popular: true,
      ctaText: 'Upgrade to Professional',
    },
    {
      id: 'business',
      name: 'Business',
      monthlyPrice: 99,
      yearlyPrice: 990,
      description: 'For growing teams',
      features: [
        'Up to 50,000 requests/month',
        'All Professional features',
        'Unlimited team members',
        '24/7 phone support',
        'Advanced compliance tools',
        'Webhook integrations',
        'Dedicated account manager',
      ],
      popular: false,
      ctaText: 'Upgrade to Business',
    },
    {
      id: 'enterprise',
      name: 'Enterprise',
      monthlyPrice: 0,
      yearlyPrice: 0,
      description: 'Custom enterprise solution',
      features: [
        'Unlimited requests',
        'All Business features',
        'White-label options',
        'Custom SLA',
        'On-premise deployment',
        'Custom integrations',
        'Dedicated support team',
        'Security audit included',
      ],
      popular: false,
      ctaText: 'Contact Sales',
    },
  ];

  const faqs: FAQItem[] = [
    {
      question: 'Can I change my plan anytime?',
      answer:
        'Yes! You can upgrade or downgrade your plan at any time. Changes take effect immediately for upgrades, or at the end of your billing cycle for downgrades.',
    },
    {
      question: 'What happens if I exceed my request limit?',
      answer:
        'We offer flexible overage handling. You can set auto-upgrade to Professional, enable pay-as-you-go at standard rates, or set a hard limit that blocks additional requests.',
    },
    {
      question: 'Do you offer refunds?',
      answer:
        'We offer a 30-day money-back guarantee for annual plans. For monthly plans, you can cancel anytime without penalties.',
    },
    {
      question: 'Is there a free trial?',
      answer:
        'Yes! All features of the Free plan are available to test. No credit card required to start.',
    },
    {
      question: 'Can I get a discount for annual billing?',
      answer:
        'Absolutely! Switch to yearly billing and save 17% on all plans. Annual subscriptions are automatically renewed.',
    },
  ];

  const allFeatures = [
    'Requests per month',
    'Search tools',
    'Team members',
    'Support',
    'Integrations',
    'Analytics',
    'Webhooks',
    'Custom SLA',
    'White-label',
    'Deployment options',
  ];

  const featureMatrix: Record<string, Record<string, boolean | string>> = {
    free: {
      'Requests per month': 'Up to 100',
      'Search tools': true,
      'Team members': 'Up to 2',
      'Support': 'Email',
      'Integrations': false,
      'Analytics': false,
      'Webhooks': false,
      'Custom SLA': false,
      'White-label': false,
      'Deployment options': 'Cloud',
    },
    professional: {
      'Requests per month': 'Up to 5,000',
      'Search tools': true,
      'Team members': 'Up to 10',
      'Support': 'Email & chat',
      'Integrations': true,
      'Analytics': true,
      'Webhooks': false,
      'Custom SLA': false,
      'White-label': false,
      'Deployment options': 'Cloud',
    },
    business: {
      'Requests per month': 'Up to 50,000',
      'Search tools': true,
      'Team members': 'Unlimited',
      'Support': '24/7 Phone',
      'Integrations': true,
      'Analytics': true,
      'Webhooks': true,
      'Custom SLA': 'Available',
      'White-label': false,
      'Deployment options': 'Cloud',
    },
    enterprise: {
      'Requests per month': 'Unlimited',
      'Search tools': true,
      'Team members': 'Unlimited',
      'Support': 'Dedicated team',
      'Integrations': true,
      'Analytics': true,
      'Webhooks': true,
      'Custom SLA': 'Included',
      'White-label': true,
      'Deployment options': 'Cloud & On-premise',
    },
  };

  const handleUpgrade = async (planId: string) => {
    setIsUpgrading(planId);
    try {
      await api.billing.upgradePlan(planId);
      showToast.success(`Successfully upgraded to ${planId} plan`);
    } catch (error) {
      console.error('Upgrade failed:', error);
      showToast.error('Failed to upgrade plan');
    } finally {
      setIsUpgrading(null);
    }
  };

  const discountPercentage = 17;
  const yearlyDiscount = `Save ${discountPercentage}%`;

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
          Monthly
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
            Yearly
          </span>
          {billingCycle === 'yearly' && (
            <span className="text-xs font-semibold bg-green-100 text-green-700 px-2 py-1 rounded-full">
              {yearlyDiscount}
            </span>
          )}
        </div>
      </motion.div>

      {/* Plans Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {plans.map((plan, index) => (
          <motion.div
            key={plan.id}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.1 }}
            className={`rounded-xl border-2 transition-all ${
              plan.popular
                ? 'border-claude-accent bg-claude-accent/5 shadow-lg scale-105'
                : 'border-claude-border bg-white'
            }`}>
            {plan.popular && (
              <div className="bg-claude-accent text-white px-4 py-2 text-center text-xs font-bold rounded-t-lg">
                MOST POPULAR
              </div>
            )}

            <div className="p-6 flex flex-col h-full">
              {/* Plan Header */}
              <div className="mb-4">
                <h3 className="text-2xl font-bold text-claude-text mb-1">{plan.name}</h3>
                <p className="text-sm text-claude-subtext">{plan.description}</p>
              </div>

              {/* Pricing */}
              <div className="mb-6">
                {plan.monthlyPrice === 0 && plan.yearlyPrice === 0 ? (
                  <p className="text-2xl font-bold text-claude-text">Custom Pricing</p>
                ) : (
                  <>
                    <div className="flex items-baseline gap-2">
                      <span className="text-4xl font-bold text-claude-text">
                        ${billingCycle === 'monthly' ? plan.monthlyPrice : plan.yearlyPrice}
                      </span>
                      <span className="text-sm text-claude-subtext">
                        {billingCycle === 'monthly' ? '/month' : '/year'}
                      </span>
                    </div>
                    {billingCycle === 'yearly' && plan.monthlyPrice > 0 && (
                      <p className="text-xs text-green-600 mt-1">
                        ${(plan.yearlyPrice / 12).toFixed(2)}/month billed yearly
                      </p>
                    )}
                  </>
                )}
              </div>

              {/* CTA Button */}
              <button
                onClick={() => handleUpgrade(plan.id)}
                disabled={isUpgrading === plan.id}
                className={`w-full py-3 px-4 rounded-lg font-semibold transition-all mb-6 ${
                  plan.popular
                    ? 'bg-claude-accent text-white hover:bg-opacity-90'
                    : 'bg-claude-bg text-claude-text border border-claude-border hover:border-claude-accent'
                } disabled:opacity-50`}>
                {isUpgrading === plan.id ? 'Processing...' : plan.ctaText}
              </button>

              {/* Features List */}
              <div className="space-y-3 flex-1">
                {plan.features.map((feature, idx) => (
                  <div key={idx} className="flex items-start gap-3">
                    <Check size={18} className="text-green-500 flex-shrink-0 mt-0.5" />
                    <span className="text-sm text-claude-text">{feature}</span>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Feature Comparison Table */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="bg-white border border-claude-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-claude-bg border-b border-claude-border">
                <th className="px-6 py-4 text-left font-semibold text-claude-text w-1/3">
                  Features
                </th>
                {['Free', 'Professional', 'Business', 'Enterprise'].map((name) => (
                  <th
                    key={name}
                    className="px-6 py-4 text-center font-semibold text-claude-text whitespace-nowrap">
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allFeatures.map((feature, idx) => (
                <tr key={idx} className={idx % 2 === 0 ? 'bg-white' : 'bg-claude-bg'}>
                  <td className="px-6 py-4 font-medium text-claude-text">{feature}</td>
                  {Object.keys(featureMatrix).map((planKey) => {
                    const value = featureMatrix[planKey][feature];
                    return (
                      <td key={planKey} className="px-6 py-4 text-center">
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

      {/* FAQ Section */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}>
        <h3 className="text-2xl font-bold text-claude-text mb-6 flex items-center gap-2">
          <Zap size={24} />
          Frequently Asked Questions
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
