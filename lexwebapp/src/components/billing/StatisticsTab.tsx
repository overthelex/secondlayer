/**
 * Statistics Tab
 * Displays detailed billing statistics with charts and analytics
 */

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
} from 'recharts';
import {
  TrendingUp,
  AlertCircle,
  RefreshCw,
  Download,
  Calendar,
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
  topTools: Array<{ name: string; count: number; percentage: number }>;
  dailyData: Array<{ date: string; requests: number; cost: number }>;
}

type PeriodType = '7d' | '30d' | '90d' | 'year';

const COLORS = ['#D97757', '#C66345', '#B55133', '#A43F21', '#932D0F', '#823C1E'];

export function StatisticsTab() {
  const [period, setPeriod] = useState<PeriodType>('30d');
  const [data, setData] = useState<StatisticsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchStatistics = async () => {
    setIsLoading(true);
    try {
      const response = await api.billing.getStatistics(period);

      // Mock data structure - replace with real API response
      const mockData: StatisticsData = {
        period,
        totalRequests: 3847,
        totalCost: 2567,
        openaiTokens: 1245000,
        avgCostPerRequest: 0.67,
        costByService: [
          { name: 'Search', value: 1200, color: COLORS[0] },
          { name: 'Analytics', value: 800, color: COLORS[1] },
          { name: 'Legislation', value: 400, color: COLORS[2] },
          { name: 'Cache Hits', value: 167, color: COLORS[3] },
        ],
        topTools: [
          { name: 'search_legal_precedents', count: 1200, percentage: 31 },
          { name: 'get_court_decision', count: 950, percentage: 25 },
          { name: 'search_legislation', count: 820, percentage: 21 },
          { name: 'analyze_case_pattern', count: 580, percentage: 15 },
          { name: 'get_similar_reasoning', count: 297, percentage: 8 },
        ],
        dailyData: [
          { date: 'Feb 1', requests: 45, cost: 30 },
          { date: 'Feb 2', requests: 62, cost: 42 },
          { date: 'Feb 3', requests: 38, cost: 25 },
          { date: 'Feb 4', requests: 87, cost: 58 },
          { date: 'Feb 5', requests: 125, cost: 84 },
          { date: 'Feb 6', requests: 98, cost: 65 },
          { date: 'Feb 7', requests: 156, cost: 104 },
          { date: 'Feb 8', requests: 145, cost: 97 },
        ],
      };

      setData(mockData);
    } catch (error) {
      console.error('Failed to fetch statistics:', error);
      showToast.error('Failed to load statistics');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchStatistics();
  }, [period]);

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center h-96">
        <RefreshCw size={32} className="text-claude-accent animate-spin" />
      </div>
    );
  }

  const totalCostTrend =
    data.dailyData.length > 1
      ? ((data.dailyData[data.dailyData.length - 1].cost -
          data.dailyData[0].cost) /
          data.dailyData[0].cost) *
        100
      : 0;

  return (
    <div className="space-y-6">
      {/* Period Selector */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-3 flex-wrap">
        <span className="text-sm font-medium text-claude-subtext flex items-center gap-2">
          <Calendar size={18} />
          Period:
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
            {p === 'year' ? 'Year' : p.toUpperCase()}
          </button>
        ))}
        <button
          onClick={fetchStatistics}
          className="ml-auto px-4 py-2 rounded-lg bg-claude-bg text-claude-text border border-claude-border hover:border-claude-accent transition-all flex items-center gap-2">
          <RefreshCw size={16} />
          Refresh
        </button>
      </motion.div>

      {/* Metrics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-white border border-claude-border rounded-lg p-4">
          <p className="text-sm text-claude-subtext mb-2">Total Requests</p>
          <p className="text-3xl font-bold text-claude-text mb-1">{data.totalRequests}</p>
          <p className="text-xs text-green-600">+12% from last period</p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-white border border-claude-border rounded-lg p-4">
          <p className="text-sm text-claude-subtext mb-2">Total Cost</p>
          <p className="text-3xl font-bold text-claude-text mb-1">₴{data.totalCost}</p>
          <p
            className={`text-xs ${
              totalCostTrend > 0 ? 'text-red-600' : 'text-green-600'
            }`}>
            {totalCostTrend > 0 ? '+' : ''}{(Number(totalCostTrend) || 0).toFixed(1)}% from first day
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="bg-white border border-claude-border rounded-lg p-4">
          <p className="text-sm text-claude-subtext mb-2">OpenAI Tokens</p>
          <p className="text-3xl font-bold text-claude-text mb-1">
            {((Number(data.openaiTokens) || 0) / 1000).toFixed(0)}K
          </p>
          <p className="text-xs text-blue-600">API usage tracked</p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="bg-white border border-claude-border rounded-lg p-4">
          <p className="text-sm text-claude-subtext mb-2">Avg Cost/Request</p>
          <p className="text-3xl font-bold text-claude-text mb-1">₴{(Number(data.avgCostPerRequest) || 0).toFixed(2)}</p>
          <p className="text-xs text-purple-600">Per request average</p>
        </motion.div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Request Trend */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          className="bg-white border border-claude-border rounded-lg p-6">
          <h3 className="text-lg font-semibold text-claude-text mb-4 flex items-center gap-2">
            <TrendingUp size={20} />
            Request Trend
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={data.dailyData}>
              <defs>
                <linearGradient id="colorRequests" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#D97757" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="#D97757" stopOpacity={0.1} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7E0" />
              <XAxis dataKey="date" stroke="#6B6B6B" style={{ fontSize: '12px' }} />
              <YAxis stroke="#6B6B6B" style={{ fontSize: '12px' }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#F5F5F0',
                  border: '1px solid #E5E7E0',
                  borderRadius: '8px',
                }}
              />
              <Area
                type="monotone"
                dataKey="requests"
                stroke="#D97757"
                fillOpacity={1}
                fill="url(#colorRequests)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </motion.div>

        {/* Cost Distribution */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
          className="bg-white border border-claude-border rounded-lg p-6">
          <h3 className="text-lg font-semibold text-claude-text mb-4">Cost Distribution</h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={data.costByService}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, value }) => `${name}: ₴${value}`}
                outerRadius={80}
                fill="#8884d8"
                dataKey="value">
                {data.costByService.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(value) => `₴${value}`} />
            </PieChart>
          </ResponsiveContainer>
        </motion.div>
      </div>

      {/* Cost Trend */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.7 }}
        className="bg-white border border-claude-border rounded-lg p-6">
        <h3 className="text-lg font-semibold text-claude-text mb-4">Daily Cost Trend</h3>
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={data.dailyData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E5E7E0" />
            <XAxis dataKey="date" stroke="#6B6B6B" style={{ fontSize: '12px' }} />
            <YAxis stroke="#6B6B6B" style={{ fontSize: '12px' }} />
            <Tooltip
              contentStyle={{
                backgroundColor: '#F5F5F0',
                border: '1px solid #E5E7E0',
                borderRadius: '8px',
              }}
              formatter={(value) => `₴${value}`}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="cost"
              stroke="#D97757"
              strokeWidth={2}
              dot={{ fill: '#D97757', r: 4 }}
              activeDot={{ r: 6 }}
              name="Daily Cost"
            />
          </LineChart>
        </ResponsiveContainer>
      </motion.div>

      {/* Top Tools */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.8 }}
        className="bg-white border border-claude-border rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-claude-text">Top 5 Tools</h3>
          <button className="text-sm text-claude-accent hover:text-claude-text transition-colors flex items-center gap-1">
            <Download size={16} />
            Export
          </button>
        </div>
        <div className="space-y-3">
          {data.topTools.map((tool, idx) => (
            <div key={idx} className="flex items-center justify-between">
              <div className="flex-1">
                <p className="font-medium text-claude-text mb-1">{tool.name}</p>
                <div className="w-full bg-claude-bg rounded-full h-2 overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${tool.percentage}%` }}
                    transition={{ duration: 0.6, delay: 0.8 + idx * 0.1 }}
                    className="h-full bg-gradient-to-r from-claude-accent to-[#C66345] rounded-full"
                  />
                </div>
              </div>
              <div className="text-right ml-4">
                <p className="font-semibold text-claude-text">{tool.count}</p>
                <p className="text-xs text-claude-subtext">{tool.percentage}%</p>
              </div>
            </div>
          ))}
        </div>
      </motion.div>

      {/* Recommendations */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.9 }}
        className="bg-blue-50 border border-blue-200 rounded-lg p-6">
        <div className="flex items-start gap-3">
          <AlertCircle size={20} className="text-blue-600 flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="font-semibold text-blue-900 mb-2">Optimization Recommendations</h4>
            <ul className="text-sm text-blue-800 space-y-1">
              <li>• Consider caching results for frequently accessed cases to reduce API calls</li>
              <li>• Your "search_legal_precedents" tool accounts for 31% of costs</li>
              <li>• Batch processing could save up to 15% on API token usage</li>
              <li>• Consider upgrading to Business plan for volume discounts</li>
            </ul>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
