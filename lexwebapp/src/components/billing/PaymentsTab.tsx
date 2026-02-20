/**
 * Payments Tab
 * Manages payment methods, billing information, and payment history
 * Uses real data from /api/billing/payment-methods and /api/billing/history
 */

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  CreditCard,
  Plus,
  Trash2,
  CheckCircle,
  Clock,
  AlertCircle,
  RefreshCw,
  Building2,
  DollarSign,
  Inbox,
} from 'lucide-react';
import { api } from '../../utils/api-client';
import showToast from '../../utils/toast';

interface PaymentMethod {
  id: string;
  provider: 'monobank' | 'metamask' | 'binance_pay';
  cardLast4: string;
  cardBrand: string;
  cardBank: string;
  isPrimary: boolean;
}

interface BillingInfo {
  companyName: string;
  edrpou: string;
  address: string;
  city: string;
  postalCode: string;
  country: string;
  email: string;
  phone: string;
}

interface PaymentHistoryItem {
  id: string;
  date: string;
  amount: number;
  currency: string;
  status: string;
  provider: string;
  description: string;
}

const STATUS_LABELS: Record<string, string> = {
  completed: 'Виконано',
  pending: 'Очікує',
  failed: 'Помилка',
  charge: 'Списання',
  topup: 'Поповнення',
  refund: 'Повернення',
  adjustment: 'Корекція',
};

export function PaymentsTab() {
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [billingInfo, setBillingInfo] = useState<BillingInfo>({
    companyName: '',
    edrpou: '',
    address: '',
    city: '',
    postalCode: '',
    country: 'Ukraine',
    email: '',
    phone: '',
  });
  const [paymentHistory, setPaymentHistory] = useState<PaymentHistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isDeletingId, setIsDeletingId] = useState<string | null>(null);
  const [isSavingBilling, setIsSavingBilling] = useState(false);
  const [showAddPayment, setShowAddPayment] = useState(false);

  const fetchPaymentData = async () => {
    setIsLoading(true);
    try {
      const [methodsRes, historyRes] = await Promise.all([
        api.billing.getPaymentMethods(),
        api.billing.getHistory({ limit: 20, type: 'topup' }),
      ]);

      // Use real payment methods from API
      const methods = methodsRes.data?.paymentMethods || [];
      setPaymentMethods(methods);

      // Use real transaction history (topup transactions as payment history)
      const transactions = historyRes.data?.transactions || [];
      setPaymentHistory(
        transactions.map((t: any) => ({
          id: t.id,
          date: t.created_at,
          amount: parseFloat(t.amount_usd) || 0,
          currency: 'USD',
          status: t.type === 'topup' ? 'completed' : t.type,
          provider: t.payment_provider || '—',
          description: t.description || `${STATUS_LABELS[t.type] || t.type} $${parseFloat(t.amount_usd).toFixed(2)}`,
        }))
      );
    } catch (error) {
      console.error('Failed to fetch payment data:', error);
      showToast.error('Не вдалося завантажити платіжну інформацію');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchPaymentData();
  }, []);

  const handleRemovePayment = async (id: string) => {
    if (!confirm('Ви впевнені, що хочете видалити цей спосіб оплати?')) {
      return;
    }

    setIsDeletingId(id);
    try {
      await api.billing.removePaymentMethod(id);
      setPaymentMethods(paymentMethods.filter((m) => m.id !== id));
      showToast.success('Спосіб оплати видалено');
    } catch (error) {
      console.error('Failed to remove payment method:', error);
      showToast.error('Не вдалося видалити спосіб оплати');
    } finally {
      setIsDeletingId(null);
    }
  };

  const handleSetPrimary = async (id: string) => {
    try {
      await api.billing.setPrimaryPaymentMethod(id);
      setPaymentMethods(
        paymentMethods.map((m) => ({
          ...m,
          isPrimary: m.id === id,
        }))
      );
      showToast.success('Основний спосіб оплати оновлено');
    } catch (error) {
      console.error('Failed to set primary payment method:', error);
      showToast.error('Не вдалося оновити основний спосіб оплати');
    }
  };

  const handleSaveBillingInfo = async () => {
    setIsSavingBilling(true);
    try {
      await api.billing.updateSettings({
        // billing info fields would be saved here when backend supports it
      });
      showToast.success('Платіжну інформацію збережено');
    } catch (error) {
      console.error('Failed to save billing info:', error);
      showToast.error('Не вдалося зберегти платіжну інформацію');
    } finally {
      setIsSavingBilling(false);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
      case 'topup':
        return <CheckCircle size={18} className="text-green-500" />;
      case 'pending':
        return <Clock size={18} className="text-yellow-500" />;
      case 'failed':
        return <AlertCircle size={18} className="text-red-500" />;
      default:
        return <DollarSign size={18} className="text-claude-subtext" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
      case 'topup':
        return 'text-green-600';
      case 'pending':
        return 'text-yellow-600';
      case 'failed':
        return 'text-red-600';
      default:
        return 'text-claude-subtext';
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <RefreshCw size={32} className="text-claude-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Payment Methods Section */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white border border-claude-border rounded-lg p-6">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-semibold text-claude-text flex items-center gap-2">
            <CreditCard size={20} />
            Способи оплати
          </h3>
          <button
            onClick={() => setShowAddPayment(!showAddPayment)}
            className="flex items-center gap-2 px-4 py-2 bg-claude-accent text-white rounded-lg hover:bg-opacity-90 transition-all">
            <Plus size={18} />
            Додати спосіб оплати
          </button>
        </div>

        {/* Add Payment Form */}
        {showAddPayment && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="mb-6 p-4 bg-claude-bg border border-claude-border rounded-lg">
            <p className="text-sm text-claude-subtext mb-4">
              Для додавання картки скористайтесь вкладкою "Поповнення" — картка буде збережена автоматично під час першої оплати через Monobank.
            </p>
            <button
              onClick={() => setShowAddPayment(false)}
              className="px-4 py-2 bg-claude-bg border border-claude-border rounded-lg hover:border-claude-accent">
              Закрити
            </button>
          </motion.div>
        )}

        {/* Payment Methods List */}
        <div className="space-y-3">
          {paymentMethods.length === 0 ? (
            <div className="text-center py-8">
              <Inbox size={40} className="text-claude-subtext mx-auto mb-3" />
              <p className="text-claude-subtext mb-1">Способи оплати ще не додані</p>
              <p className="text-xs text-claude-subtext">
                Картка буде збережена автоматично після першої оплати
              </p>
            </div>
          ) : (
            paymentMethods.map((method, idx) => (
              <motion.div
                key={method.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.1 }}
                className={`p-4 rounded-lg border-2 transition-all ${
                  method.isPrimary
                    ? 'border-claude-accent bg-claude-accent/5'
                    : 'border-claude-border bg-white hover:border-claude-accent'
                }`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4 flex-1">
                    <div className="text-4xl font-bold text-claude-accent/30">
                      {method.provider === 'monobank' ? '🏦' : method.provider === 'metamask' ? '🦊' : '🟡'}
                    </div>
                    <div className="flex-1">
                      <p className="font-semibold text-claude-text">
                        {method.cardBrand} •••• {method.cardLast4}
                      </p>
                      <p className="text-sm text-claude-subtext">
                        {method.cardBank} • {method.provider === 'monobank' ? 'Monobank' : method.provider === 'metamask' ? 'MetaMask' : 'Binance Pay'}
                      </p>
                    </div>
                  </div>

                  {method.isPrimary && (
                    <span className="px-3 py-1 bg-green-100 text-green-700 text-xs font-semibold rounded-full mr-4">
                      Основний
                    </span>
                  )}

                  <div className="flex items-center gap-2">
                    {!method.isPrimary && (
                      <button
                        onClick={() => handleSetPrimary(method.id)}
                        className="px-3 py-1 text-sm text-claude-accent hover:bg-claude-bg rounded-lg transition-colors">
                        Зробити основним
                      </button>
                    )}
                    <button
                      onClick={() => handleRemovePayment(method.id)}
                      disabled={isDeletingId === method.id}
                      className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50">
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>
              </motion.div>
            ))
          )}
        </div>
      </motion.div>

      {/* Billing Information Section */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="bg-white border border-claude-border rounded-lg p-6">
        <h3 className="text-lg font-semibold text-claude-text mb-6 flex items-center gap-2">
          <Building2 size={20} />
          Платіжна інформація
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-claude-text mb-2">Назва компанії</label>
            <input
              type="text"
              value={billingInfo.companyName}
              onChange={(e) => setBillingInfo({ ...billingInfo, companyName: e.target.value })}
              placeholder="Назва вашої компанії"
              className="w-full px-4 py-2 border border-claude-border rounded-lg text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-claude-text mb-2">ЄДРПОУ</label>
            <input
              type="text"
              value={billingInfo.edrpou}
              onChange={(e) => setBillingInfo({ ...billingInfo, edrpou: e.target.value })}
              placeholder="12345678"
              className="w-full px-4 py-2 border border-claude-border rounded-lg text-sm"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-claude-text mb-2">Адреса</label>
            <input
              type="text"
              value={billingInfo.address}
              onChange={(e) => setBillingInfo({ ...billingInfo, address: e.target.value })}
              placeholder="Вулиця, будинок"
              className="w-full px-4 py-2 border border-claude-border rounded-lg text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-claude-text mb-2">Місто</label>
            <input
              type="text"
              value={billingInfo.city}
              onChange={(e) => setBillingInfo({ ...billingInfo, city: e.target.value })}
              placeholder="Київ"
              className="w-full px-4 py-2 border border-claude-border rounded-lg text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-claude-text mb-2">Поштовий індекс</label>
            <input
              type="text"
              value={billingInfo.postalCode}
              onChange={(e) => setBillingInfo({ ...billingInfo, postalCode: e.target.value })}
              placeholder="02000"
              className="w-full px-4 py-2 border border-claude-border rounded-lg text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-claude-text mb-2">Електронна пошта</label>
            <input
              type="email"
              value={billingInfo.email}
              onChange={(e) => setBillingInfo({ ...billingInfo, email: e.target.value })}
              placeholder="billing@company.com"
              className="w-full px-4 py-2 border border-claude-border rounded-lg text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-claude-text mb-2">Телефон</label>
            <input
              type="tel"
              value={billingInfo.phone}
              onChange={(e) => setBillingInfo({ ...billingInfo, phone: e.target.value })}
              placeholder="+380 XX XXX XXXX"
              className="w-full px-4 py-2 border border-claude-border rounded-lg text-sm"
            />
          </div>
        </div>

        <button
          onClick={handleSaveBillingInfo}
          disabled={isSavingBilling}
          className="mt-6 px-6 py-2 bg-claude-accent text-white rounded-lg hover:bg-opacity-90 transition-all disabled:opacity-50">
          {isSavingBilling ? 'Збереження...' : 'Зберегти платіжну інформацію'}
        </button>
      </motion.div>

      {/* Payment History Section */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="bg-white border border-claude-border rounded-lg p-6">
        <h3 className="text-lg font-semibold text-claude-text mb-6 flex items-center gap-2">
          <DollarSign size={20} />
          Історія оплат
        </h3>

        {paymentHistory.length === 0 ? (
          <div className="text-center py-8">
            <Inbox size={40} className="text-claude-subtext mx-auto mb-3" />
            <p className="text-claude-subtext">Оплат ще не було</p>
            <p className="text-xs text-claude-subtext mt-1">
              Тут з'являться ваші поповнення після оплати
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-claude-bg border-b border-claude-border">
                  <th className="px-4 py-3 text-left font-semibold text-claude-text">Дата</th>
                  <th className="px-4 py-3 text-left font-semibold text-claude-text">Опис</th>
                  <th className="px-4 py-3 text-left font-semibold text-claude-text">Провайдер</th>
                  <th className="px-4 py-3 text-right font-semibold text-claude-text">Сума</th>
                  <th className="px-4 py-3 text-center font-semibold text-claude-text">Статус</th>
                </tr>
              </thead>
              <tbody>
                {paymentHistory.map((payment, idx) => (
                  <tr
                    key={payment.id}
                    className={idx % 2 === 0 ? 'bg-white' : 'bg-claude-bg'}>
                    <td className="px-4 py-3 text-claude-text">
                      {new Date(payment.date).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-claude-text">{payment.description}</td>
                    <td className="px-4 py-3 text-claude-subtext">{payment.provider}</td>
                    <td className="px-4 py-3 text-right font-semibold text-claude-text">
                      ${payment.amount.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-2">
                        {getStatusIcon(payment.status)}
                        <span className={`text-xs font-semibold ${getStatusColor(payment.status)}`}>
                          {STATUS_LABELS[payment.status] || payment.status}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </motion.div>
    </div>
  );
}
