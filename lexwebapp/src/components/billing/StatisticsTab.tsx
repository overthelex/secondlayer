/**
 * Statistics Tab
 * Displays real billing statistics from /api/billing/statistics
 */

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  Legend,
  BarChart,
  Bar,
} from 'recharts';
import {
  TrendingUp,
  TrendingDown,
  AlertCircle,
  RefreshCw,
  Download,
  Calendar,
  DollarSign,
  Zap,
  Hash,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
} from 'lucide-react';
import { api } from '../../utils/api-client';
import showToast from '../../utils/toast';

interface StatisticsData {
  period: string;
  totalRequests: number;
  totalCost: number;
  openaiTokens: number;
  avgCostPerRequest: number;
  costByService: Array<{ name: string; value: number; color: string }>;
  topTools: Array<{ name: string; count: number; cost: number; percentage: number }>;
  dailyData: Array<{ date: string; requests: number; cost: number }>;
  previousPeriod?: {
    totalRequests: number;
    totalCost: number;
    requestsChange: number;
    costChange: number;
  };
}

type PeriodType = '7d' | '30d' | '90d' | 'year';

const COLORS = ['#D97757', '#C66345', '#B55133', '#A43F21', '#932D0F', '#823C1E', '#6B2E15', '#54200C'];

const PERIOD_LABELS: Record<PeriodType, string> = {
  '7d': '7 днів',
  '30d': '30 днів',
  '90d': '90 днів',
  'year': 'Рік',
};

function formatCost(value: number): string {
  if (value < 0.01 && value > 0) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return value.toString();
}

function ChangeIndicator({ value, suffix = '' }: { value: number; suffix?: string }) {
  if (value === 0) {
    return (
      <span className="text-xs text-claude-subtext flex items-center gap-1">
        <Minus size={12} />
        Без змін
      </span>
    );
  }
  const isPositive = value > 0;
  return (
    <span className={`text-xs flex items-center gap-1 ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
      {isPositive ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
      {isPositive ? '+' : ''}{value}%{suffix}
    </span>
  );
}

export function StatisticsTab() {
  const [period, setPeriod] = useState<PeriodType>('30d');
  const [data, setData] = useState<StatisticsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatistics = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.billing.getStatistics(period);
      setData(response.data);
    } catch (err: any) {
      console.error('Failed to fetch statistics:', err);
      setError('Не вдалося завантажити статистику');
      showToast.error('Не вдалося завантажити статистику');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchStatistics();
  }, [period]);

  const handleExportCSV = () => {
    if (!data) return;
    const rows = [
      ['Дата', 'Запити', 'Витрати (USD)'],
      ...data.dailyData.map((d) => [d.date, d.requests.toString(), d.cost.toFixed(4)]),
    ];
    const csv = rows.map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `statistics_${period}_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast.success('CSV-файл завантажено');
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <RefreshCw size={32} className="text-claude-accent animate-spin mx-auto mb-3" />
          <p className="text-sm text-claude-subtext">Завантаження статистики...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle size={48} className="text-claude-subtext mx-auto mb-4" />
          <p className="text-claude-text mb-2">{error || 'Дані недоступні'}</p>
          <button
            onClick={fetchStatistics}
            className="px-4 py-2 bg-claude-accent text-white rounded-lg hover:bg-opacity-90">
            Повторити
          </button>
        </div>
      </div>
    );
  }

  const hasData = data.totalRequests > 0;
  const prev = data.previousPeriod;

  return (
    <div className="space-y-6">
      {/* Period Selector */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-3 flex-wrap">
        <span className="text-sm font-medium text-claude-subtext flex items-center gap-2">
          <Calendar size={18} />
          Період:
        </span>
        {(['7d', '30d', '90d', 'year'] as PeriodType[]).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`px-4 py-2 rounded-lg font-medium text-sm transition-all ${
              period === p
                ? 'bg-claude-accent text-white'
                : 'bg-claude-bg text-claude-text border border-claude-border hover:border-claude-accent'
            }`}>
            {PERIOD_LABELS[p]}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={handleExportCSV}
            disabled={!hasData}
            className="px-4 py-2 rounded-lg bg-claude-bg text-claude-text border border-claude-border hover:border-claude-accent transition-all flex items-center gap-2 disabled:opacity-50">
            <Download size={16} />
            CSV
          </button>
          <button
            onClick={fetchStatistics}
            className="px-4 py-2 rounded-lg bg-claude-bg text-claude-text border border-claude-border hover:border-claude-accent transition-all flex items-center gap-2">
            <RefreshCw size={16} />
            Оновити
          </button>
        </div>
      </motion.div>

      {/* Empty State */}
      {!hasData && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-claude-bg border border-claude-border rounded-xl p-12 text-center">
          <Zap size={48} className="text-claude-subtext mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-claude-text mb-2">
            Немає даних за {PERIOD_LABELS[period]}
          </h3>
          <p className="text-sm text-claude-subtext max-w-md mx-auto">
            Статистика з'явиться після того, як ви почнете використовувати інструменти платформи.
            Спробуйте виконати пошук судових рішень або аналіз законодавства.
          </p>
        </motion.div>
      )}

      {/* Metrics Cards */}
      {hasData && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="bg-white border border-claude-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm text-claude-subtext">Всього запитів</p>
                <Hash size={18} className="text-claude-subtext" />
              </div>
              <p className="text-3xl font-bold text-claude-text mb-1">
                {data.totalRequests.toLocaleString()}
              </p>
              {prev && <ChangeIndicator value={prev.requestsChange} suffix=" з мин. періоду" />}
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="bg-white border border-claude-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm text-claude-subtext">Загальні витрати</p>
                <DollarSign size={18} className="text-claude-subtext" />
              </div>
              <p className="text-3xl font-bold text-claude-text mb-1">
                {formatCost(data.totalCost)}
              </p>
              {prev && (
                <ChangeIndicator
                  value={prev.costChange}
                  suffix=" з мин. періоду"
                />
              )}
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="bg-white border border-claude-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm text-claude-subtext">Токени OpenAI</p>
                <Zap size={18} className="text-claude-subtext" />
              </div>
              <p className="text-3xl font-bold text-claude-text mb-1">
                {formatTokens(data.openaiTokens)}
              </p>
              <span className="text-xs text-claude-subtext">prompt + completion</span>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4 }}
              className="bg-white border border-claude-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm text-claude-subtext">Сер. вартість / запит</p>
                <TrendingUp size={18} className="text-claude-subtext" />
              </div>
              <p className="text-3xl font-bold text-claude-text mb-1">
                {formatCost(data.avgCostPerRequest)}
              </p>
              <span className="text-xs text-claude-subtext">
                за {PERIOD_LABELS[period]}
              </span>
            </motion.div>
          </div>

          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Request Trend */}
            {data.dailyData.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5 }}
                className="bg-white border border-claude-border rounded-lg p-6">
                <h3 className="text-lg font-semibold text-claude-text mb-4 flex items-center gap-2">
                  <TrendingUp size={20} />
                  Запити по днях
                </h3>
                <ResponsiveContainer width="100%" height={280}>
                  <AreaChart data={data.dailyData}>
                    <defs>
                      <linearGradient id="colorRequests" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#D97757" stopOpacity={0.8} />
                        <stop offset="95%" stopColor="#D97757" stopOpacity={0.1} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E5E7E0" />
                    <XAxis dataKey="date" stroke="#6B6B6B" style={{ fontSize: '11px' }} />
                    <YAxis stroke="#6B6B6B" style={{ fontSize: '11px' }} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#F5F5F0',
                        border: '1px solid #E5E7E0',
                        borderRadius: '8px',
                        fontSize: '13px',
                      }}
                      formatter={(value: number) => [value, 'Запитів']}
                    />
                    <Area
                      type="monotone"
                      dataKey="requests"
                      stroke="#D97757"
                      fillOpacity={1}
                      fill="url(#colorRequests)"
                      name="Запити"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </motion.div>
            )}

            {/* Cost Distribution Pie */}
            {data.costByService.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.6 }}
                className="bg-white border border-claude-border rounded-lg p-6">
                <h3 className="text-lg font-semibold text-claude-text mb-4">
                  Витрати по інструментах
                </h3>
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie
                      data={data.costByService}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ name, value }) => `${name}: ${formatCost(value)}`}
                      outerRadius={80}
                      fill="#8884d8"
                      dataKey="value">
                      {data.costByService.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value: number) => formatCost(value)} />
                  </PieChart>
                </ResponsiveContainer>
              </motion.div>
            )}
          </div>

          {/* Daily Cost Trend */}
          {data.dailyData.length > 1 && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.7 }}
              className="bg-white border border-claude-border rounded-lg p-6">
              <h3 className="text-lg font-semibold text-claude-text mb-4">
                Витрати по днях (USD)
              </h3>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={data.dailyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E5E7E0" />
                  <XAxis dataKey="date" stroke="#6B6B6B" style={{ fontSize: '11px' }} />
                  <YAxis stroke="#6B6B6B" style={{ fontSize: '11px' }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#F5F5F0',
                      border: '1px solid #E5E7E0',
                      borderRadius: '8px',
                      fontSize: '13px',
                    }}
                    formatter={(value: number) => [formatCost(value), 'Витрати']}
                  />
                  <Bar
                    dataKey="cost"
                    fill="#D97757"
                    radius={[4, 4, 0, 0]}
                    name="Витрати"
                  />
                </BarChart>
              </ResponsiveContainer>
            </motion.div>
          )}

          {/* Top Tools */}
          {data.topTools.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.8 }}
              className="bg-white border border-claude-border rounded-lg p-6">
              <h3 className="text-lg font-semibold text-claude-text mb-4">
                Топ інструментів
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-claude-border">
                      <th className="px-4 py-3 text-left font-medium text-claude-subtext">#</th>
                      <th className="px-4 py-3 text-left font-medium text-claude-subtext">Інструмент</th>
                      <th className="px-4 py-3 text-right font-medium text-claude-subtext">Запити</th>
                      <th className="px-4 py-3 text-right font-medium text-claude-subtext">Витрати</th>
                      <th className="px-4 py-3 text-left font-medium text-claude-subtext w-1/3">Частка</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topTools.map((tool, idx) => (
                      <tr key={idx} className="border-b border-claude-border/50 hover:bg-claude-bg/50">
                        <td className="px-4 py-3 text-claude-subtext">{idx + 1}</td>
                        <td className="px-4 py-3 font-medium text-claude-text font-mono text-xs">
                          {tool.name}
                        </td>
                        <td className="px-4 py-3 text-right text-claude-text">
                          {tool.count.toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-right text-claude-text">
                          {formatCost(tool.cost)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="flex-1 bg-claude-bg rounded-full h-2 overflow-hidden">
                              <motion.div
                                initial={{ width: 0 }}
                                animate={{ width: `${tool.percentage}%` }}
                                transition={{ duration: 0.6, delay: 0.8 + idx * 0.1 }}
                                className="h-full bg-gradient-to-r from-claude-accent to-[#C66345] rounded-full"
                              />
                            </div>
                            <span className="text-xs text-claude-subtext w-8 text-right">
                              {tool.percentage}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </motion.div>
          )}
        </>
      )}
    </div>
  );
}
