/**
 * Admin Overview Page
 * System dashboard with KPIs, revenue chart, tier distribution
 */

import React, { useEffect, useState } from 'react';
import {
  RefreshCw,
  DollarSign,
  Users,
  TrendingUp,
  AlertTriangle,
  Activity,
  XCircle,
} from 'lucide-react';
import { api } from '../utils/api-client';

interface OverviewData {
  today: { revenue_usd: number; profit_usd: number; requests: number };
  month: { revenue_usd: number; profit_usd: number; requests: number };
  users: { total: number; active: number; low_balance: number };
  alerts: { failed_requests_today: number };
}

interface RevenuePoint {
  date: string;
  revenue_usd: number;
  cost_usd: number;
  profit_usd: number;
  requests: number;
}

interface TierInfo {
  tier: string;
  user_count: number;
  total_balance_usd: number;
}

function formatUSD(n: number | null | undefined): string {
  if (n == null) return '$0.00';
  return `$${n.toFixed(2)}`;
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return '0';
  return n.toLocaleString('en-US');
}

function KPICard({
  label,
  value,
  icon: Icon,
  color,
  subLabel,
  subValue,
}: {
  label: string;
  value: string;
  icon: React.ElementType;
  color: string;
  subLabel?: string;
  subValue?: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-claude-border p-5 shadow-sm">
      <div className="flex items-center gap-3 mb-3">
        <div className={`p-2 rounded-lg ${color}`}>
          <Icon size={18} />
        </div>
        <span className="text-sm text-claude-subtext">{label}</span>
      </div>
      <div className="text-2xl font-semibold text-claude-text font-sans">{value}</div>
      {subLabel && (
        <div className="text-xs text-claude-subtext mt-1">
          {subLabel}: <span className="font-medium text-claude-text">{subValue}</span>
        </div>
      )}
    </div>
  );
}

export function AdminOverviewPage() {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [chart, setChart] = useState<RevenuePoint[]>([]);
  const [tiers, setTiers] = useState<TierInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [ovRes, chartRes, tierRes] = await Promise.all([
        api.admin.getOverview(),
        api.admin.getRevenueChart(30),
        api.admin.getTierDistribution(),
      ]);
      setOverview(ovRes.data);
      setChart(chartRes.data?.data || []);
      setTiers(tierRes.data?.tiers || []);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to load overview');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
  }, []);

  if (loading && !overview) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <RefreshCw size={32} className="text-claude-subtext animate-spin" />
          <p className="text-claude-subtext">Loading overview...</p>
        </div>
      </div>
    );
  }

  if (error && !overview) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center">
          <XCircle size={32} className="text-red-500" />
          <p className="text-red-600">{error}</p>
          <button onClick={fetchAll} className="px-4 py-2 bg-claude-text text-white rounded-lg text-sm">
            Retry
          </button>
        </div>
      </div>
    );
  }

  const maxRevenue = Math.max(...chart.map((p) => p.revenue_usd), 1);
  const totalTierUsers = tiers.reduce((s, t) => s + t.user_count, 0) || 1;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-claude-text font-sans">System Overview</h1>
          <p className="text-sm text-claude-subtext mt-1">Real-time platform metrics</p>
        </div>
        <button
          onClick={fetchAll}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-claude-border rounded-lg text-sm text-claude-text hover:bg-claude-bg transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* KPI Row — Today */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <KPICard
          label="Revenue Today"
          value={formatUSD(overview?.today.revenue_usd)}
          icon={DollarSign}
          color="bg-green-50 text-green-600"
          subLabel="Profit"
          subValue={formatUSD(overview?.today.profit_usd)}
        />
        <KPICard
          label="Revenue This Month"
          value={formatUSD(overview?.month.revenue_usd)}
          icon={TrendingUp}
          color="bg-blue-50 text-blue-600"
          subLabel="Profit"
          subValue={formatUSD(overview?.month.profit_usd)}
        />
        <KPICard
          label="Requests Today"
          value={formatNumber(overview?.today.requests)}
          icon={Activity}
          color="bg-purple-50 text-purple-600"
          subLabel="This month"
          subValue={formatNumber(overview?.month.requests)}
        />
        <KPICard
          label="Failed Requests"
          value={formatNumber(overview?.alerts.failed_requests_today)}
          icon={AlertTriangle}
          color={
            (overview?.alerts.failed_requests_today || 0) > 0
              ? 'bg-red-50 text-red-600'
              : 'bg-gray-50 text-gray-500'
          }
        />
      </div>

      {/* Users Row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <KPICard
          label="Total Users"
          value={formatNumber(overview?.users.total)}
          icon={Users}
          color="bg-indigo-50 text-indigo-600"
        />
        <KPICard
          label="Active (30d)"
          value={formatNumber(overview?.users.active)}
          icon={Users}
          color="bg-emerald-50 text-emerald-600"
        />
        <KPICard
          label="Low Balance Alerts"
          value={formatNumber(overview?.users.low_balance)}
          icon={AlertTriangle}
          color={
            (overview?.users.low_balance || 0) > 0
              ? 'bg-amber-50 text-amber-600'
              : 'bg-gray-50 text-gray-500'
          }
        />
      </div>

      {/* Revenue Chart */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-claude-text font-sans mb-4">Revenue (Last 30 Days)</h2>
        <div className="bg-white rounded-xl border border-claude-border p-5 shadow-sm">
          {chart.length === 0 ? (
            <p className="text-claude-subtext text-sm text-center py-8">No revenue data available</p>
          ) : (
            <div className="flex items-end gap-[2px] h-40">
              {chart.map((point) => {
                const height = Math.max((point.revenue_usd / maxRevenue) * 100, 2);
                const dateStr = new Date(point.date).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                });
                return (
                  <div
                    key={point.date}
                    className="flex-1 group relative flex flex-col items-center justify-end"
                  >
                    <div
                      className="w-full bg-blue-400 hover:bg-blue-500 rounded-t transition-colors cursor-pointer min-w-[4px]"
                      style={{ height: `${height}%` }}
                      title={`${dateStr}: ${formatUSD(point.revenue_usd)} rev / ${formatUSD(point.profit_usd)} profit`}
                    />
                  </div>
                );
              })}
            </div>
          )}
          {chart.length > 0 && (
            <div className="flex justify-between mt-2 text-[10px] text-claude-subtext">
              <span>
                {new Date(chart[0]?.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
              <span>
                {new Date(chart[chart.length - 1]?.date).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
            </div>
          )}
        </div>
      </section>

      {/* Tier Distribution */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-claude-text font-sans mb-4">Tier Distribution</h2>
        <div className="bg-white rounded-xl border border-claude-border p-5 shadow-sm space-y-3">
          {tiers.length === 0 ? (
            <p className="text-claude-subtext text-sm text-center py-4">No tier data</p>
          ) : (
            tiers.map((t) => {
              const pct = (t.user_count / totalTierUsers) * 100;
              return (
                <div key={t.tier}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="font-medium text-claude-text capitalize">{t.tier}</span>
                    <span className="text-claude-subtext">
                      {t.user_count} users &middot; {formatUSD(t.total_balance_usd)} balance
                    </span>
                  </div>
                  <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
