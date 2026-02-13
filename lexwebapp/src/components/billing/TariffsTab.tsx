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
      description: 'Ідеально для знайомства з платформою',
      features: [
        'До 100 запитів/місяць',
        'Базовий пошук судових рішень',
        '2 учасники команди',
        'Підтримка електронною поштою',
        'Доступ до спільноти',
      ],
      popular: false,
      ctaText: 'Поточний план',
    },
    {
      id: 'professional',
      name: 'Professional',
      monthlyPrice: 29,
      yearlyPrice: 290,
      description: 'Для практикуючих юристів',
      features: [
        'До 5 000 запитів/місяць',
        'Розширений пошук та аналітика',
        '10 учасників команди',
        'Пріоритетна підтримка',
        'Користувацькі інтеграції',
        'Панель аналітики використання',
      ],
      popular: true,
      ctaText: 'Перейти на Professional',
    },
    {
      id: 'business',
      name: 'Business',
      monthlyPrice: 99,
      yearlyPrice: 990,
      description: 'Для юридичних компаній',
      features: [
        'До 50 000 запитів/місяць',
        'Усі функції Professional',
        'Необмежена кількість учасників',
        'Підтримка 24/7 телефоном',
        'Інструменти комплаєнсу',
        'Webhook-інтеграції',
        'Персональний менеджер',
      ],
      popular: false,
      ctaText: 'Перейти на Business',
    },
    {
      id: 'enterprise',
      name: 'Enterprise',
      monthlyPrice: 0,
      yearlyPrice: 0,
      description: 'Індивідуальне рішення для великих компаній',
      features: [
        'Необмежена кількість запитів',
        'Усі функції Business',
        'White-label опції',
        'Індивідуальний SLA',
        'Розгортання на власних серверах',
        'Індивідуальні інтеграції',
        'Виділена команда підтримки',
        'Аудит безпеки включено',
      ],
      popular: false,
      ctaText: "Зв'язатися з відділом продажів",
    },
  ];

  const faqs: FAQItem[] = [
    {
      question: 'Чи можу я змінити тариф у будь-який час?',
      answer:
        'Так! Ви можете підвищити або знизити тариф у будь-який час. Підвищення набирає чинності одразу, зниження — з початку наступного платіжного періоду.',
    },
    {
      question: 'Що станеться, якщо я перевищу ліміт запитів?',
      answer:
        'Ми пропонуємо гнучкі варіанти: автоматичне підвищення тарифу до Professional, оплата за фактом використання за стандартними тарифами або жорсткий ліміт, що блокує додаткові запити.',
    },
    {
      question: 'Чи повертаєте ви кошти?',
      answer:
        'Ми гарантуємо повернення коштів протягом 30 днів для річних планів. Місячні плани можна скасувати у будь-який час без штрафів.',
    },
    {
      question: 'Чи є безкоштовний пробний період?',
      answer:
        'Так! Усі функції безкоштовного плану доступні для тестування. Для реєстрації кредитна картка не потрібна.',
    },
    {
      question: 'Чи є знижка за річну оплату?',
      answer:
        'Так! Перейдіть на річну оплату та заощадьте 17% на всіх тарифах. Річні підписки продовжуються автоматично.',
    },
  ];

  const allFeatures = [
    'Запитів на місяць',
    'Інструменти пошуку',
    'Учасники команди',
    'Підтримка',
    'Інтеграції',
    'Аналітика',
    'Webhooks',
    'Індивідуальний SLA',
    'White-label',
    'Варіанти розгортання',
  ];

  const featureMatrix: Record<string, Record<string, boolean | string>> = {
    free: {
      'Запитів на місяць': 'До 100',
      'Інструменти пошуку': true,
      'Учасники команди': 'До 2',
      'Підтримка': 'Email',
      'Інтеграції': false,
      'Аналітика': false,
      'Webhooks': false,
      'Індивідуальний SLA': false,
      'White-label': false,
      'Варіанти розгортання': 'Хмара',
    },
    professional: {
      'Запитів на місяць': 'До 5 000',
      'Інструменти пошуку': true,
      'Учасники команди': 'До 10',
      'Підтримка': 'Email та чат',
      'Інтеграції': true,
      'Аналітика': true,
      'Webhooks': false,
      'Індивідуальний SLA': false,
      'White-label': false,
      'Варіанти розгортання': 'Хмара',
    },
    business: {
      'Запитів на місяць': 'До 50 000',
      'Інструменти пошуку': true,
      'Учасники команди': 'Необмежено',
      'Підтримка': 'Телефон 24/7',
      'Інтеграції': true,
      'Аналітика': true,
      'Webhooks': true,
      'Індивідуальний SLA': 'Доступно',
      'White-label': false,
      'Варіанти розгортання': 'Хмара',
    },
    enterprise: {
      'Запитів на місяць': 'Необмежено',
      'Інструменти пошуку': true,
      'Учасники команди': 'Необмежено',
      'Підтримка': 'Виділена команда',
      'Інтеграції': true,
      'Аналітика': true,
      'Webhooks': true,
      'Індивідуальний SLA': 'Включено',
      'White-label': true,
      'Варіанти розгортання': 'Хмара та локально',
    },
  };

  const handleUpgrade = async (planId: string) => {
    setIsUpgrading(planId);
    try {
      await api.billing.upgradePlan(planId);
      showToast.success(`Тариф ${planId} успішно активовано`);
    } catch (error) {
      console.error('Upgrade failed:', error);
      showToast.error('Не вдалося змінити тариф');
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
                НАЙПОПУЛЯРНІШИЙ
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
                  <p className="text-2xl font-bold text-claude-text">Індивідуальна ціна</p>
                ) : (
                  <>
                    <div className="flex items-baseline gap-2">
                      <span className="text-4xl font-bold text-claude-text">
                        ${billingCycle === 'monthly' ? plan.monthlyPrice : plan.yearlyPrice}
                      </span>
                      <span className="text-sm text-claude-subtext">
                        {billingCycle === 'monthly' ? '/міс' : '/рік'}
                      </span>
                    </div>
                    {billingCycle === 'yearly' && plan.monthlyPrice > 0 && (
                      <p className="text-xs text-green-600 mt-1">
                        ${(plan.yearlyPrice / 12).toFixed(2)}/міс при річній оплаті
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
                {isUpgrading === plan.id ? 'Обробка...' : plan.ctaText}
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
                  Функції
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
