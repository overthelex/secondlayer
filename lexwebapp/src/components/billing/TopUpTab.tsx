/**
 * Top-up Tab
 * Allows users to add funds via Stripe or Fondy
 */

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  CreditCard,
  DollarSign,
  CheckCircle,
  AlertCircle,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { api } from '../../utils/api-client';
import showToast from '../../utils/toast';

const STRIPE_KEY = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || '';
const MOCK_PAYMENTS = import.meta.env.VITE_MOCK_PAYMENTS === 'true';

const stripePromise = STRIPE_KEY ? loadStripe(STRIPE_KEY) : null;

type PaymentProvider = 'stripe' | 'fondy';

const cardElementOptions = {
  style: {
    base: {
      fontSize: '16px',
      color: '#2D2D2D',
      '::placeholder': {
        color: '#6B6B6B',
      },
    },
    invalid: {
      color: '#ff4d4f',
    },
  },
};

function StripePaymentForm({ amount, onSuccess }: { amount: number; onSuccess: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      // Create payment intent
      const { data } = await api.payment.createStripe({
        amount_usd: amount,
        metadata: { source: 'billing_dashboard' },
      });

      if (MOCK_PAYMENTS) {
        // Mock mode - simulate success
        showToast.success(`Тестова оплата $${amount} успішна!`);
        setTimeout(onSuccess, 1000);
        return;
      }

      const { clientSecret } = data;

      // Confirm card payment
      const { error: stripeError, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
        payment_method: {
          card: elements.getElement(CardElement)!,
        },
      });

      if (stripeError) {
        setError(stripeError.message || 'Помилка оплати');
        showToast.error(stripeError.message || 'Помилка оплати');
      } else if (paymentIntent?.status === 'succeeded') {
        showToast.success('Оплату здійснено! Ваш баланс буде оновлено найближчим часом.');
        onSuccess();
      }
    } catch (err: any) {
      const message = err.response?.data?.message || 'Помилка оплати. Спробуйте ще раз.';
      setError(message);
      showToast.error(message);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-claude-text mb-2">Дані картки</label>
        <div className="p-4 border border-claude-border rounded-lg bg-white">
          <CardElement options={cardElementOptions} />
        </div>
        {error && (
          <p className="mt-2 text-sm text-red-600 flex items-center gap-1">
            <AlertCircle size={14} />
            {error}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={!stripe || isProcessing}
        className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-claude-accent text-white rounded-lg hover:bg-opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium">
        {isProcessing ? (
          <>
            <Loader2 size={18} className="animate-spin" />
            Обробка...
          </>
        ) : (
          <>
            <CreditCard size={18} />
            Сплатити ${amount.toFixed(2)}
          </>
        )}
      </button>

      {MOCK_PAYMENTS && (
        <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
          <p className="text-xs text-yellow-800">
            <strong>Mock Mode:</strong> Payments are simulated. No real charges will be made.
          </p>
        </div>
      )}
    </form>
  );
}

export function TopUpTab() {
  const [provider, setProvider] = useState<PaymentProvider>('stripe');
  const [amount, setAmount] = useState<number>(25);
  const [customAmount, setCustomAmount] = useState<string>('');
  const [isFondyProcessing, setIsFondyProcessing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  const presetAmounts = provider === 'stripe' ? [10, 25, 50, 100] : [100, 250, 500, 1000];

  const handleFondyPayment = async () => {
    setIsFondyProcessing(true);

    try {
      const { data } = await api.payment.createFondy({
        amount_uah: amount,
      });

      if (MOCK_PAYMENTS) {
        // Mock mode - simulate success
        showToast.success(`Тестова оплата Fondy на ₴${amount} розпочата!`);
        setShowSuccess(true);
        setTimeout(() => setShowSuccess(false), 3000);
      } else {
        // Real mode - redirect to Fondy
        showToast.info('Перенаправлення на сторінку оплати Fondy...');
        window.open(data.paymentUrl, '_blank');
      }
    } catch (err: any) {
      const message = err.response?.data?.message || 'Не вдалося створити платіж. Спробуйте ще раз.';
      showToast.error(message);
    } finally {
      setIsFondyProcessing(false);
    }
  };

  const handleSuccess = () => {
    setShowSuccess(true);
    setAmount(25);
    setCustomAmount('');
    setTimeout(() => setShowSuccess(false), 5000);
  };

  const handleCustomAmountChange = (value: string) => {
    setCustomAmount(value);
    const parsed = parseFloat(value);
    if (!isNaN(parsed) && parsed > 0) {
      setAmount(parsed);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Success Message */}
      {showSuccess && (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-green-50 border border-green-200 rounded-xl p-4 flex items-center gap-3">
          <CheckCircle size={24} className="text-green-600" />
          <div>
            <p className="font-medium text-green-800">Оплату здійснено!</p>
            <p className="text-sm text-green-700">
              Ваш баланс буде оновлено найближчим часом.
            </p>
          </div>
        </motion.div>
      )}

      {/* Provider Selection */}
      <div className="bg-white border border-claude-border rounded-xl p-6">
        <h3 className="text-lg font-semibold text-claude-text mb-4">Оберіть спосіб оплати</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <button
            onClick={() => {
              setProvider('stripe');
              setAmount(25);
              setCustomAmount('');
            }}
            className={`p-4 border-2 rounded-xl transition-all ${
              provider === 'stripe'
                ? 'border-claude-accent bg-claude-accent/5'
                : 'border-claude-border hover:border-claude-accent/50'
            }`}>
            <div className="flex items-center gap-3 mb-2">
              <CreditCard size={24} className={provider === 'stripe' ? 'text-claude-accent' : 'text-claude-subtext'} />
              <h4 className="font-semibold text-claude-text">Stripe</h4>
            </div>
            <p className="text-sm text-claude-subtext text-left">
              Кредитні/дебетові картки (міжнародні)
            </p>
            <p className="text-xs text-claude-subtext mt-1 text-left">Рекомендовано для оплати в USD</p>
          </button>

          <button
            onClick={() => {
              setProvider('fondy');
              setAmount(250);
              setCustomAmount('');
            }}
            className={`p-4 border-2 rounded-xl transition-all ${
              provider === 'fondy'
                ? 'border-claude-accent bg-claude-accent/5'
                : 'border-claude-border hover:border-claude-accent/50'
            }`}>
            <div className="flex items-center gap-3 mb-2">
              <DollarSign size={24} className={provider === 'fondy' ? 'text-claude-accent' : 'text-claude-subtext'} />
              <h4 className="font-semibold text-claude-text">Fondy</h4>
            </div>
            <p className="text-sm text-claude-subtext text-left">Українські картки (UAH)</p>
            <p className="text-xs text-claude-subtext mt-1 text-left">Для карток українських банків</p>
          </button>
        </div>
      </div>

      {/* Amount Selection */}
      <div className="bg-white border border-claude-border rounded-xl p-6">
        <h3 className="text-lg font-semibold text-claude-text mb-4">Оберіть суму</h3>

        {/* Preset Amounts */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {presetAmounts.map((preset) => (
            <button
              key={preset}
              onClick={() => {
                setAmount(preset);
                setCustomAmount('');
              }}
              className={`p-4 border-2 rounded-xl font-semibold transition-all ${
                amount === preset && !customAmount
                  ? 'border-claude-accent bg-claude-accent text-white'
                  : 'border-claude-border text-claude-text hover:border-claude-accent'
              }`}>
              {provider === 'stripe' ? `$${preset}` : `₴${preset}`}
            </button>
          ))}
        </div>

        {/* Custom Amount */}
        <div>
          <label className="block text-sm font-medium text-claude-text mb-2">Інша сума</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-claude-subtext font-medium">
              {provider === 'stripe' ? '$' : '₴'}
            </span>
            <input
              type="number"
              min={provider === 'stripe' ? '1' : '10'}
              step={provider === 'stripe' ? '0.01' : '1'}
              value={customAmount}
              onChange={(e) => handleCustomAmountChange(e.target.value)}
              placeholder={provider === 'stripe' ? '25.00' : '250'}
              className="w-full pl-8 pr-4 py-3 border border-claude-border rounded-lg focus:outline-none focus:ring-2 focus:ring-claude-accent/20"
            />
          </div>
          <p className="text-xs text-claude-subtext mt-2">
            Мінімум: {provider === 'stripe' ? '$1.00' : '₴10'}
          </p>
        </div>

        {/* Amount Summary */}
        <div className="mt-4 p-4 bg-claude-bg rounded-lg">
          <div className="flex items-center justify-between">
            <span className="text-sm text-claude-subtext">До оплати:</span>
            <span className="text-2xl font-bold text-claude-text">
              {provider === 'stripe' ? `$${amount.toFixed(2)}` : `₴${amount.toFixed(2)}`}
            </span>
          </div>
          {provider === 'fondy' && (
            <p className="text-xs text-claude-subtext mt-2">
              ≈ ${(amount * 0.027).toFixed(2)} USD (орієнтовний курс)
            </p>
          )}
        </div>
      </div>

      {/* Payment Form */}
      <div className="bg-white border border-claude-border rounded-xl p-6">
        <h3 className="text-lg font-semibold text-claude-text mb-4">Деталі оплати</h3>

        {provider === 'stripe' ? (
          stripePromise ? (
            <Elements stripe={stripePromise}>
              <StripePaymentForm amount={amount} onSuccess={handleSuccess} />
            </Elements>
          ) : (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-800">
                Stripe не налаштовано. Додайте VITE_STRIPE_PUBLISHABLE_KEY до змінних оточення.
              </p>
            </div>
          )
        ) : (
          <div className="space-y-4">
            <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <p className="text-sm text-blue-800">
                Вас буде перенаправлено на захищену сторінку оплати Fondy для завершення транзакції.
              </p>
            </div>

            <button
              onClick={handleFondyPayment}
              disabled={isFondyProcessing || amount < 10}
              className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-claude-accent text-white rounded-lg hover:bg-opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium">
              {isFondyProcessing ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  Обробка...
                </>
              ) : (
                <>
                  <ExternalLink size={18} />
                  Сплатити ₴{amount.toFixed(2)} через Fondy
                </>
              )}
            </button>

            {MOCK_PAYMENTS && (
              <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                <p className="text-xs text-yellow-800">
                  <strong>Тестовий режим:</strong> Оплати симулюються. Реальні списання не проводяться.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Security Notice */}
      <div className="p-4 bg-claude-bg border border-claude-border rounded-lg">
        <p className="text-xs text-claude-subtext text-center">
          🔒 Усі платежі обробляються безпечно через {provider === 'stripe' ? 'Stripe' : 'Fondy'}.
          Дані вашої картки не зберігаються на наших серверах.
        </p>
      </div>
    </div>
  );
}
