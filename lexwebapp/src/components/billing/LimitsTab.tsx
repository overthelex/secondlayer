/**
 * Limits Tab
 * Manage spending limits and notification preferences
 * Fetches real data from /api/billing/settings and /api/billing/balance
 */

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  Bell,
  Zap,
  TrendingUp,
  Target,
  RefreshCw,
} from 'lucide-react';
import { api } from '../../utils/api-client';
import showToast from '../../utils/toast';

interface BillingLimits {
  daily_limit_usd: number;
  monthly_limit_usd: number;
  email_notifications: boolean;
  notify_low_balance: boolean;
  notify_payment_success: boolean;
  notify_payment_failure: boolean;
  notify_monthly_report: boolean;
  low_balance_threshold_usd: number;
}

interface CurrentUsage {
  daily_spent: number;
  daily_limit: number;
  monthly_spent: number;
  monthly_limit: number;
  projected_monthly: number;
  days_remaining: number;
}

export function LimitsTab() {
  const [limits, setLimits] = useState<BillingLimits>({
    daily_limit_usd: 0,
    monthly_limit_usd: 0,
    email_notifications: true,
    notify_low_balance: true,
    notify_payment_success: true,
    notify_payment_failure: false,
    notify_monthly_report: true,
    low_balance_threshold_usd: 20,
  });

  const [usage, setUsage] = useState<CurrentUsage>({
    daily_spent: 0,
    daily_limit: 0,
    monthly_spent: 0,
    monthly_limit: 0,
    projected_monthly: 0,
    days_remaining: 0,
  });

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const [settingsRes, balanceRes] = await Promise.all([
        api.billing.getSettings(),
        api.billing.getBalance(),
      ]);

      const s = settingsRes.data;
      setLimits({
        daily_limit_usd: s.daily_limit_usd ?? 50,
        monthly_limit_usd: s.monthly_limit_usd ?? 1000,
        email_notifications: s.email_notifications ?? true,
        notify_low_balance: s.notify_low_balance ?? true,
        notify_payment_success: s.notify_payment_success ?? true,
        notify_payment_failure: s.notify_payment_failure ?? false,
        notify_monthly_report: s.notify_monthly_report ?? true,
        low_balance_threshold_usd: s.low_balance_threshold_usd ?? 20,
      });

      const b = balanceRes.data;
      const dailySpent = parseFloat(b.today_spent_usd || b.today_spending_usd || '0') || 0;
      const monthlySpent = parseFloat(b.month_spent_usd || b.monthly_spending_usd || '0') || 0;
      const dailyLimit = parseFloat(b.daily_limit_usd || s.daily_limit_usd || '50') || 50;
      const monthlyLimit = parseFloat(b.monthly_limit_usd || s.monthly_limit_usd || '1000') || 1000;

      // Calculate days remaining in the month
      const now = new Date();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const dayOfMonth = now.getDate();
      const daysRemaining = daysInMonth - dayOfMonth;

      // Project monthly spending based on current average
      const avgDailySpend = dayOfMonth > 0 ? monthlySpent / dayOfMonth : 0;
      const projectedMonthly = avgDailySpend * daysInMonth;

      setUsage({
        daily_spent: dailySpent,
        daily_limit: dailyLimit,
        monthly_spent: monthlySpent,
        monthly_limit: monthlyLimit,
        projected_monthly: projectedMonthly,
        days_remaining: daysRemaining,
      });
    } catch (error) {
      console.error('Failed to fetch limits:', error);
      showToast.error('Не вдалося завантажити ліміти');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveLimits = async () => {
    setIsSaving(true);
    try {
      await api.billing.updateSettings({
        daily_limit_usd: limits.daily_limit_usd,
        monthly_limit_usd: limits.monthly_limit_usd,
        email_notifications: limits.email_notifications,
        notify_low_balance: limits.notify_low_balance,
        notify_payment_success: limits.notify_payment_success,
        notify_payment_failure: limits.notify_payment_failure,
        notify_monthly_report: limits.notify_monthly_report,
        low_balance_threshold_usd: limits.low_balance_threshold_usd,
      });
      // Update usage limits to match saved values
      setUsage((prev) => ({
        ...prev,
        daily_limit: limits.daily_limit_usd,
        monthly_limit: limits.monthly_limit_usd,
      }));
      showToast.success('Ліміти оновлено');
    } catch (error) {
      console.error('Failed to save limits:', error);
      showToast.error('Не вдалося оновити ліміти');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <RefreshCw size={32} className="text-claude-accent animate-spin" />
      </div>
    );
  }

  const n = (v: any) => Number(v) || 0;
  const dailyPercentage = usage.daily_limit > 0 ? (n(usage.daily_spent) / n(usage.daily_limit)) * 100 : 0;
  const monthlyPercentage = usage.monthly_limit > 0 ? (n(usage.monthly_spent) / n(usage.monthly_limit)) * 100 : 0;

  const getPercentageColor = (percentage: number) => {
    if (percentage >= 100) return 'from-red-600 to-red-500';
    if (percentage >= 95) return 'from-red-500 to-orange-500';
    if (percentage >= 80) return 'from-orange-500 to-yellow-500';
    if (percentage >= 50) return 'from-yellow-500 to-green-500';
    return 'from-green-600 to-green-500';
  };

  // Calculate forecast: days until monthly limit is reached
  const now = new Date();
  const dayOfMonth = now.getDate();
  const avgDailySpend = dayOfMonth > 0 ? usage.monthly_spent / dayOfMonth : 0;
  const daysUntilLimit = avgDailySpend > 0
    ? Math.round((usage.monthly_limit - usage.monthly_spent) / avgDailySpend)
    : Infinity;

  return (
    <div className="space-y-6">
      {/* Current Usage Cards */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Daily Usage */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-white border border-claude-border rounded-lg p-4">
          <p className="text-sm text-claude-subtext mb-3">Денне використання</p>
          <div className="mb-3">
            <div className="flex items-baseline justify-between mb-1">
              <p className="text-2xl font-bold text-claude-text">${n(usage.daily_spent).toFixed(2)}</p>
              <p className="text-xs text-claude-subtext">/ ${n(usage.daily_limit).toFixed(2)}</p>
            </div>
            <div className="w-full bg-claude-bg rounded-full h-3 overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(dailyPercentage, 100)}%` }}
                transition={{ duration: 0.6 }}
                className={`h-full rounded-full bg-gradient-to-r ${getPercentageColor(dailyPercentage)}`}
              />
            </div>
          </div>
          <p className="text-xs text-claude-subtext">{dailyPercentage.toFixed(0)}% використано</p>
        </motion.div>

        {/* Monthly Usage */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-white border border-claude-border rounded-lg p-4">
          <p className="text-sm text-claude-subtext mb-3">Місячне використання</p>
          <div className="mb-3">
            <div className="flex items-baseline justify-between mb-1">
              <p className="text-2xl font-bold text-claude-text">${n(usage.monthly_spent).toFixed(2)}</p>
              <p className="text-xs text-claude-subtext">/ ${n(usage.monthly_limit).toFixed(2)}</p>
            </div>
            <div className="w-full bg-claude-bg rounded-full h-3 overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(monthlyPercentage, 100)}%` }}
                transition={{ duration: 0.6, delay: 0.1 }}
                className={`h-full rounded-full bg-gradient-to-r ${getPercentageColor(monthlyPercentage)}`}
              />
            </div>
          </div>
          <p className="text-xs text-claude-subtext">{usage.days_remaining} днів залишилось</p>
        </motion.div>

        {/* Projected Monthly */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="bg-white border border-claude-border rounded-lg p-4">
          <p className="text-sm text-claude-subtext mb-3">Прогноз на місяць</p>
          <div className="mb-3">
            <div className="flex items-baseline justify-between mb-1">
              <p className="text-2xl font-bold text-claude-text">
                ${n(usage.projected_monthly).toFixed(2)}
              </p>
              <p className="text-xs text-claude-subtext">прогноз</p>
            </div>
            <div className="flex items-center justify-between">
              {usage.projected_monthly > usage.monthly_limit ? (
                <span className="text-xs text-red-600 font-semibold flex items-center gap-1">
                  <AlertTriangle size={14} />
                  Перевищить ліміт
                </span>
              ) : usage.projected_monthly > 0 ? (
                <span className="text-xs text-green-600 font-semibold">В межах плану</span>
              ) : (
                <span className="text-xs text-claude-subtext">Немає даних</span>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>

      {/* Spending Limits Configuration */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="bg-white border border-claude-border rounded-lg p-6">
        <h3 className="text-lg font-semibold text-claude-text mb-6 flex items-center gap-2">
          <Target size={20} />
          Ліміти витрат
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-claude-text mb-2">Денний ліміт (USD)</label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-claude-subtext">$</span>
              <input
                id="limits-daily"
                name="dailyLimit"
                type="number"
                min="0"
                step="1"
                value={limits.daily_limit_usd}
                onChange={(e) =>
                  setLimits({ ...limits, daily_limit_usd: parseFloat(e.target.value) || 0 })
                }
                className="flex-1 px-4 py-2 border border-claude-border rounded-lg text-sm"
              />
            </div>
            <p className="text-xs text-claude-subtext mt-1">
              Поточне: ${n(usage.daily_spent).toFixed(2)} витрачено сьогодні
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-claude-text mb-2">
              Місячний ліміт (USD)
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-claude-subtext">$</span>
              <input
                id="limits-monthly"
                name="monthlyLimit"
                type="number"
                min="0"
                step="10"
                value={limits.monthly_limit_usd}
                onChange={(e) =>
                  setLimits({ ...limits, monthly_limit_usd: parseFloat(e.target.value) || 0 })
                }
                className="flex-1 px-4 py-2 border border-claude-border rounded-lg text-sm"
              />
            </div>
            <p className="text-xs text-claude-subtext mt-1">
              Поточне: ${n(usage.monthly_spent).toFixed(2)} витрачено цього місяця
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-claude-text mb-2">
              Поріг низького балансу (USD)
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-claude-subtext">$</span>
              <input
                id="limits-low-balance"
                name="lowBalance"
                type="number"
                min="0"
                step="1"
                value={limits.low_balance_threshold_usd}
                onChange={(e) =>
                  setLimits({ ...limits, low_balance_threshold_usd: parseFloat(e.target.value) || 0 })
                }
                className="flex-1 px-4 py-2 border border-claude-border rounded-lg text-sm"
              />
            </div>
            <p className="text-xs text-claude-subtext mt-1">
              Сповіщення при балансі нижче цієї суми
            </p>
          </div>
        </div>
      </motion.div>

      {/* Email Notifications */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
        className="bg-white border border-claude-border rounded-lg p-6">
        <h3 className="text-lg font-semibold text-claude-text mb-6 flex items-center gap-2">
          <Bell size={20} />
          Email-сповіщення
        </h3>

        <div className="space-y-4">
          <label className="flex items-center justify-between p-4 bg-claude-bg rounded-lg cursor-pointer hover:bg-opacity-80 transition-colors">
            <span className="font-medium text-claude-text">Увімкнути email-сповіщення</span>
            <input
              type="checkbox"
              checked={limits.email_notifications}
              onChange={(e) => setLimits({ ...limits, email_notifications: e.target.checked })}
              className="w-5 h-5"
            />
          </label>

          {limits.email_notifications && (
            <div className="space-y-3 pl-4 border-l-2 border-claude-accent">
              {[
                { key: 'notify_low_balance', label: 'Попередження про низький баланс' },
                { key: 'notify_payment_success', label: 'Успішна оплата' },
                { key: 'notify_payment_failure', label: 'Невдала оплата' },
                { key: 'notify_monthly_report', label: 'Щомісячний звіт' },
              ].map((notif) => (
                <label
                  key={notif.key}
                  className="flex items-center justify-between p-3 bg-white border border-claude-border rounded-lg cursor-pointer hover:border-claude-accent transition-colors">
                  <span className="text-sm text-claude-text">{notif.label}</span>
                  <input
                    type="checkbox"
                    checked={(limits as any)[notif.key]}
                    onChange={(e) =>
                      setLimits({ ...limits, [notif.key]: e.target.checked })
                    }
                    className="w-4 h-4"
                  />
                </label>
              ))}
            </div>
          )}
        </div>
      </motion.div>

      {/* Forecast Section */}
      {avgDailySpend > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
          className="bg-blue-50 border border-blue-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-blue-900 mb-4 flex items-center gap-2">
            <TrendingUp size={20} />
            Прогноз витрат
          </h3>
          <div className="space-y-2 text-sm text-blue-800">
            <p>
              Середні щоденні витрати: <strong>${avgDailySpend.toFixed(2)}</strong>
            </p>
            {daysUntilLimit < Infinity && daysUntilLimit > 0 ? (
              <p>
                При поточному темпі ви досягнете місячного ліміту{' '}
                <strong>${n(limits.monthly_limit_usd).toFixed(2)}</strong> приблизно за{' '}
                <strong>{daysUntilLimit} {daysUntilLimit === 1 ? 'день' : daysUntilLimit < 5 ? 'дні' : 'днів'}</strong>.
              </p>
            ) : daysUntilLimit <= 0 ? (
              <p className="text-red-700 font-semibold">
                Місячний ліміт вже досягнуто або перевищено.
              </p>
            ) : (
              <p>Витрати в межах ліміту до кінця місяця.</p>
            )}
          </div>
        </motion.div>
      )}

      {/* Save Button */}
      <motion.button
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.7 }}
        onClick={handleSaveLimits}
        disabled={isSaving}
        className="w-full px-6 py-3 bg-claude-accent text-white rounded-lg hover:bg-opacity-90 transition-all disabled:opacity-50 font-semibold">
        {isSaving ? 'Збереження...' : 'Зберегти конфігурацію лімітів'}
      </motion.button>
    </div>
  );
}
