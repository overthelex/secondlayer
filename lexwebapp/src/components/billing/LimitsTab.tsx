/**
 * Limits Tab
 * Manage spending limits, budgets, and notification preferences
 */

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  Bell,
  Zap,
  TrendingUp,
  Target,
  RefreshCw,
  Toggle2,
} from 'lucide-react';
import { api } from '../../utils/api-client';
import showToast from '../../utils/toast';

interface BillingLimits {
  daily_limit_usd: number;
  monthly_limit_usd: number;
  openai_api_limit_usd: number;
  external_apis_limit_usd: number;
  email_notifications: boolean;
  notify_at_50: boolean;
  notify_at_80: boolean;
  notify_at_95: boolean;
  notify_at_100: boolean;
  limit_behavior: 'auto_upgrade' | 'pay_as_you_go' | 'hard_limit';
  webhook_url: string;
  webhook_enabled: boolean;
}

interface CurrentUsage {
  daily_spent: number;
  daily_limit: number;
  monthly_spent: number;
  monthly_limit: number;
  openai_spent: number;
  openai_limit: number;
  projected_monthly: number;
  days_remaining: number;
}

export function LimitsTab() {
  const [limits, setLimits] = useState<BillingLimits>({
    daily_limit_usd: 50,
    monthly_limit_usd: 1000,
    openai_api_limit_usd: 800,
    external_apis_limit_usd: 200,
    email_notifications: true,
    notify_at_50: true,
    notify_at_80: true,
    notify_at_95: true,
    notify_at_100: false,
    limit_behavior: 'auto_upgrade',
    webhook_url: '',
    webhook_enabled: false,
  });

  const [usage, setUsage] = useState<CurrentUsage>({
    daily_spent: 35,
    daily_limit: 50,
    monthly_spent: 650,
    monthly_limit: 1000,
    openai_spent: 520,
    openai_limit: 800,
    projected_monthly: 780,
    days_remaining: 18,
  });

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    fetchLimits();
  }, []);

  const fetchLimits = async () => {
    setIsLoading(true);
    try {
      const response = await api.billing.getSettings();
      // In a real app, update limits from API response
      console.log('Fetched limits:', response);
    } catch (error) {
      console.error('Failed to fetch limits:', error);
      showToast.error('Failed to load limits');
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
        notify_low_balance: limits.notify_at_80,
        notify_payment_success: limits.notify_at_100,
        notify_payment_failure: false,
        notify_monthly_report: true,
        low_balance_threshold_usd: 20,
      });
      showToast.success('Limits updated successfully');
    } catch (error) {
      console.error('Failed to save limits:', error);
      showToast.error('Failed to update limits');
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
  const dailyPercentage = (n(usage.daily_spent) / n(usage.daily_limit)) * 100;
  const monthlyPercentage = (n(usage.monthly_spent) / n(usage.monthly_limit)) * 100;
  const openaiPercentage = (n(usage.openai_spent) / n(usage.openai_limit)) * 100;

  const getPercentageColor = (percentage: number) => {
    if (percentage >= 100) return 'from-red-600 to-red-500';
    if (percentage >= 95) return 'from-red-500 to-orange-500';
    if (percentage >= 80) return 'from-orange-500 to-yellow-500';
    if (percentage >= 50) return 'from-yellow-500 to-green-500';
    return 'from-green-600 to-green-500';
  };

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
          <p className="text-sm text-claude-subtext mb-3">Daily Usage</p>
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
                className={`h-full rounded-full bg-gradient-to-r ${getPercentageColor(
                  dailyPercentage
                )}`}
              />
            </div>
          </div>
          <p className="text-xs text-claude-subtext">{dailyPercentage.toFixed(0)}% used</p>
        </motion.div>

        {/* Monthly Usage */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-white border border-claude-border rounded-lg p-4">
          <p className="text-sm text-claude-subtext mb-3">Monthly Usage</p>
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
                className={`h-full rounded-full bg-gradient-to-r ${getPercentageColor(
                  monthlyPercentage
                )}`}
              />
            </div>
          </div>
          <p className="text-xs text-claude-subtext">{usage.days_remaining} days remaining</p>
        </motion.div>

        {/* Projected Monthly */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="bg-white border border-claude-border rounded-lg p-4">
          <p className="text-sm text-claude-subtext mb-3">Projected Monthly Cost</p>
          <div className="mb-3">
            <div className="flex items-baseline justify-between mb-1">
              <p className="text-2xl font-bold text-claude-text">
                ${n(usage.projected_monthly).toFixed(2)}
              </p>
              <p className="text-xs text-claude-subtext">est.</p>
            </div>
            <div className="flex items-center justify-between">
              {usage.projected_monthly > usage.monthly_limit ? (
                <span className="text-xs text-red-600 font-semibold flex items-center gap-1">
                  <AlertTriangle size={14} />
                  Over limit
                </span>
              ) : (
                <span className="text-xs text-green-600 font-semibold">On track</span>
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
          Spending Limits
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-claude-text mb-2">Daily Limit (USD)</label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-claude-subtext">$</span>
              <input
                type="number"
                value={limits.daily_limit_usd}
                onChange={(e) =>
                  setLimits({ ...limits, daily_limit_usd: parseFloat(e.target.value) || 0 })
                }
                className="flex-1 px-4 py-2 border border-claude-border rounded-lg text-sm"
              />
            </div>
            <p className="text-xs text-claude-subtext mt-1">Hard limit per day</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-claude-text mb-2">
              Monthly Limit (USD)
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-claude-subtext">$</span>
              <input
                type="number"
                value={limits.monthly_limit_usd}
                onChange={(e) =>
                  setLimits({ ...limits, monthly_limit_usd: parseFloat(e.target.value) || 0 })
                }
                className="flex-1 px-4 py-2 border border-claude-border rounded-lg text-sm"
              />
            </div>
            <p className="text-xs text-claude-subtext mt-1">Hard limit per month</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-claude-text mb-2">
              OpenAI API Limit (USD)
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-claude-subtext">$</span>
              <input
                type="number"
                value={limits.openai_api_limit_usd}
                onChange={(e) =>
                  setLimits({ ...limits, openai_api_limit_usd: parseFloat(e.target.value) || 0 })
                }
                className="flex-1 px-4 py-2 border border-claude-border rounded-lg text-sm"
              />
            </div>
            <p className="text-xs text-claude-subtext mt-1">Currently: ${n(usage.openai_spent).toFixed(2)}</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-claude-text mb-2">
              External APIs Limit (USD)
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-claude-subtext">$</span>
              <input
                type="number"
                value={limits.external_apis_limit_usd}
                onChange={(e) =>
                  setLimits({
                    ...limits,
                    external_apis_limit_usd: parseFloat(e.target.value) || 0,
                  })
                }
                className="flex-1 px-4 py-2 border border-claude-border rounded-lg text-sm"
              />
            </div>
            <p className="text-xs text-claude-subtext mt-1">ZakonOnline, Rada APIs, etc.</p>
          </div>
        </div>
      </motion.div>

      {/* Limit Behavior */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
        className="bg-white border border-claude-border rounded-lg p-6">
        <h3 className="text-lg font-semibold text-claude-text mb-6 flex items-center gap-2">
          <Zap size={20} />
          When Limit is Reached
        </h3>

        <div className="space-y-3">
          {[
            {
              value: 'auto_upgrade',
              label: 'Auto-upgrade to higher plan',
              description: 'Automatically upgrade your plan to continue without interruption',
            },
            {
              value: 'pay_as_you_go',
              label: 'Pay as you go',
              description: 'Charge overage fees at standard rates (₴0.67 per request)',
            },
            {
              value: 'hard_limit',
              label: 'Hard limit (block requests)',
              description: 'Stop processing requests when limit is reached',
            },
          ].map((option) => (
            <label
              key={option.value}
              className={`w-full p-4 rounded-lg border-2 cursor-pointer transition-all ${
                limits.limit_behavior === option.value
                  ? 'border-claude-accent bg-claude-accent/5'
                  : 'border-claude-border hover:border-claude-accent'
              }`}>
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  name="limit_behavior"
                  value={option.value}
                  checked={limits.limit_behavior === option.value as any}
                  onChange={(e) =>
                    setLimits({
                      ...limits,
                      limit_behavior: e.target.value as any,
                    })
                  }
                  className="w-6 h-6 mt-0.5 cursor-pointer accent-claude-accent flex-shrink-0"
                />
                <div className="flex-1">
                  <p className="font-medium text-claude-text">{option.label}</p>
                  <p className="text-sm text-claude-subtext mt-1">{option.description}</p>
                </div>
              </div>
            </label>
          ))}
        </div>
      </motion.div>

      {/* Email Notifications */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6 }}
        className="bg-white border border-claude-border rounded-lg p-6">
        <h3 className="text-lg font-semibold text-claude-text mb-6 flex items-center gap-2">
          <Bell size={20} />
          Email Notifications
        </h3>

        <div className="space-y-4">
          <label className="flex items-center justify-between p-4 bg-claude-bg rounded-lg cursor-pointer hover:bg-opacity-80 transition-colors">
            <span className="font-medium text-claude-text">Enable email notifications</span>
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
                { key: 'notify_at_50', label: 'At 50% of limit', color: 'green' },
                { key: 'notify_at_80', label: 'At 80% of limit', color: 'yellow' },
                { key: 'notify_at_95', label: 'At 95% of limit', color: 'orange' },
                { key: 'notify_at_100', label: 'At 100% (limit reached)', color: 'red' },
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

      {/* Webhook Notifications */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.7 }}
        className="bg-white border border-claude-border rounded-lg p-6">
        <h3 className="text-lg font-semibold text-claude-text mb-6">Webhook Notifications</h3>

        <div className="space-y-4">
          <label className="flex items-center justify-between p-4 bg-claude-bg rounded-lg cursor-pointer hover:bg-opacity-80 transition-colors">
            <span className="font-medium text-claude-text">Enable webhook notifications</span>
            <input
              type="checkbox"
              checked={limits.webhook_enabled}
              onChange={(e) => setLimits({ ...limits, webhook_enabled: e.target.checked })}
              className="w-5 h-5"
            />
          </label>

          {limits.webhook_enabled && (
            <div>
              <label className="block text-sm font-medium text-claude-text mb-2">Webhook URL</label>
              <input
                type="url"
                value={limits.webhook_url}
                onChange={(e) => setLimits({ ...limits, webhook_url: e.target.value })}
                placeholder="https://your-domain.com/webhooks/billing"
                className="w-full px-4 py-2 border border-claude-border rounded-lg text-sm"
              />
              <p className="text-xs text-claude-subtext mt-2">
                POST requests will be sent when spending limits are reached
              </p>
            </div>
          )}
        </div>
      </motion.div>

      {/* Forecast Section */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.8 }}
        className="bg-blue-50 border border-blue-200 rounded-lg p-6">
        <h3 className="text-lg font-semibold text-blue-900 mb-4 flex items-center gap-2">
          <TrendingUp size={20} />
          Spending Forecast
        </h3>
        <div className="space-y-2 text-sm text-blue-800">
          <p>
            Based on your current usage pattern, you'll reach your monthly limit of{' '}
            <strong>${n(limits.monthly_limit_usd).toFixed(2)}</strong> in approximately{' '}
            <strong>25 days</strong>.
          </p>
          <p>
            <strong>Recommendation:</strong> Consider increasing your monthly limit or optimizing
            API usage to reduce costs.
          </p>
        </div>
      </motion.div>

      {/* Save Button */}
      <motion.button
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.9 }}
        onClick={handleSaveLimits}
        disabled={isSaving}
        className="w-full px-6 py-3 bg-claude-accent text-white rounded-lg hover:bg-opacity-90 transition-all disabled:opacity-50 font-semibold">
        {isSaving ? 'Saving...' : 'Save Limits Configuration'}
      </motion.button>
    </div>
  );
}
