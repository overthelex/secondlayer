/**
 * Overview Tab
 * Displays current balance, spending limits, and usage statistics
 */

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  DollarSign,
  TrendingUp,
  Calendar,
  AlertCircle,
  RefreshCw,
  Clock,
} from 'lucide-react';
import { api } from '../../utils/api-client';
import showToast from '../../utils/toast';

interface BalanceData {
  balance_usd: number;
  balance_uah: number;
  daily_limit_usd: number;
  monthly_limit_usd: number;
  today_spending_usd: number;
  monthly_spending_usd: number;
  total_requests: number;
  last_request_at: string | null;
  is_active: boolean;
}

interface OverviewTabProps {
  onTopUp?: () => void;
}

export function OverviewTab({ onTopUp }: OverviewTabProps) {
  const [data, setData] = useState<BalanceData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());

  const fetchBalance = async () => {
    try {
      const response = await api.billing.getBalance();
      setData(response.data);
      setLastUpdated(new Date());
    } catch (error) {
      console.error('Failed to fetch balance:', error);
      showToast.error('Failed to load balance data');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchBalance();

    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchBalance, 30000);
    return () => clearInterval(interval);
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw size={32} className="text-claude-accent animate-spin" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle size={48} className="text-claude-subtext mx-auto mb-4" />
          <p className="text-claude-text">Не вдалося завантажити дані балансу</p>
          <button
            onClick={fetchBalance}
            className="mt-4 px-4 py-2 bg-claude-accent text-white rounded-lg hover:bg-opacity-90">
            Повторити
          </button>
        </div>
      </div>
    );
  }

  const n = (v: any) => Number(v) || 0;
  const dailyPercentage = (n(data.today_spending_usd) / n(data.daily_limit_usd)) * 100;
  const monthlyPercentage = (n(data.monthly_spending_usd) / n(data.monthly_limit_usd)) * 100;

  return (
    <div className="space-y-6">
      {/* Balance Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* USD Balance */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-gradient-to-br from-claude-accent to-[#C66345] rounded-xl p-6 text-white shadow-lg">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium opacity-90">Баланс USD</h3>
            <DollarSign size={24} />
          </div>
          <p className="text-4xl font-bold mb-2">${n(data.balance_usd).toFixed(2)}</p>
          <div className="flex items-center justify-between">
            <p className="text-sm opacity-75">Доступно для використання</p>
            {onTopUp && (
              <button
                onClick={onTopUp}
                className="px-4 py-1.5 bg-white/20 hover:bg-white/30 text-white rounded-lg text-sm font-medium transition-colors backdrop-blur-sm">
                Поповнити
              </button>
            )}
          </div>
        </motion.div>

        {/* UAH Balance */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-white border border-claude-border rounded-xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-claude-subtext">Баланс UAH</h3>
            <DollarSign size={24} className="text-claude-accent" />
          </div>
          <p className="text-4xl font-bold text-claude-text mb-2">
            ₴{n(data.balance_uah).toFixed(2)}
          </p>
          <p className="text-sm text-claude-subtext">Українська гривня</p>
        </motion.div>

        {/* Total Requests */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-white border border-claude-border rounded-xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-claude-subtext">Всього запитів</h3>
            <TrendingUp size={24} className="text-claude-accent" />
          </div>
          <p className="text-4xl font-bold text-claude-text mb-2">{data.total_requests}</p>
          <p className="text-sm text-claude-subtext">Виконано API-запитів</p>
        </motion.div>
      </div>

      {/* Spending Limits */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="bg-white border border-claude-border rounded-xl p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-claude-text mb-4 flex items-center gap-2">
          <Calendar size={20} />
          Ліміти витрат
        </h3>

        {/* Daily Limit */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-claude-text">Денний ліміт</span>
            <span className="text-sm text-claude-subtext">
              ${n(data.today_spending_usd).toFixed(2)} / ${n(data.daily_limit_usd).toFixed(2)}
            </span>
          </div>
          <div className="w-full bg-claude-bg rounded-full h-3 overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${Math.min(dailyPercentage, 100)}%` }}
              transition={{ duration: 0.6, delay: 0.4 }}
              className={`h-full rounded-full ${
                dailyPercentage > 90
                  ? 'bg-red-500'
                  : dailyPercentage > 70
                  ? 'bg-yellow-500'
                  : 'bg-green-500'
              }`}
            />
          </div>
          <p className="text-xs text-claude-subtext mt-1">
            {dailyPercentage.toFixed(1)}% використано сьогодні
          </p>
        </div>

        {/* Monthly Limit */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-claude-text">Місячний ліміт</span>
            <span className="text-sm text-claude-subtext">
              ${n(data.monthly_spending_usd).toFixed(2)} / ${n(data.monthly_limit_usd).toFixed(2)}
            </span>
          </div>
          <div className="w-full bg-claude-bg rounded-full h-3 overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${Math.min(monthlyPercentage, 100)}%` }}
              transition={{ duration: 0.6, delay: 0.5 }}
              className={`h-full rounded-full ${
                monthlyPercentage > 90
                  ? 'bg-red-500'
                  : monthlyPercentage > 70
                  ? 'bg-yellow-500'
                  : 'bg-green-500'
              }`}
            />
          </div>
          <p className="text-xs text-claude-subtext mt-1">
            {monthlyPercentage.toFixed(1)}% використано цього місяця
          </p>
        </div>
      </motion.div>

      {/* Last Request Info */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="bg-claude-bg border border-claude-border rounded-xl p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock size={18} className="text-claude-subtext" />
            <span className="text-sm text-claude-subtext">Останній запит</span>
          </div>
          <span className="text-sm font-medium text-claude-text">
            {data.last_request_at
              ? new Date(data.last_request_at).toLocaleString()
              : 'Запитів ще не було'}
          </span>
        </div>
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-2">
            <RefreshCw size={18} className="text-claude-subtext" />
            <span className="text-sm text-claude-subtext">Останнє оновлення</span>
          </div>
          <span className="text-sm font-medium text-claude-text">
            {lastUpdated.toLocaleTimeString()}
          </span>
        </div>
      </motion.div>

      {/* Low Balance Warning */}
      {data.balance_usd < 5 && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle size={20} className="text-yellow-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-medium text-yellow-800 mb-1">Попередження про низький баланс</p>
            <p className="text-sm text-yellow-700">
              Ваш баланс на вичерпанні. Поповніть рахунок, щоб уникнути перерви в обслуговуванні.
            </p>
          </div>
          <button
            onClick={() => onTopUp?.()}
            className="px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 text-sm font-medium whitespace-nowrap">
            Поповнити зараз
          </button>
        </motion.div>
      )}
    </div>
  );
}
