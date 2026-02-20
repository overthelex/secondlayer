/**
 * Admin Costs Page
 * Cost breakdown by provider/model, daily chart, plus tool usage, transactions, cohort analysis
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  RefreshCw,
  XCircle,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  BarChart3,
  Users,
  Cpu,
  Globe,
  Zap,
  Server,
  Layers,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { api } from '../utils/api-client';
import toast from 'react-hot-toast';

// ── Types ──────────────────────────────────────────────

interface CostBreakdown {
  period: { from: string; to: string; days: number };
  totals: {
    openai_cost_usd: number;
    anthropic_cost_usd: number;
    zakononline_cost_usd: number;
    secondlayer_cost_usd: number;
    voyage_cost_usd: number;
    total_cost_usd: number;
    total_requests: number;
  };
  by_provider: Array<{
    provider: string;
    cost_usd: number;
    requests?: number;
    tokens?: number;
    calls?: number;
  }>;
  by_model: Array<{
    provider: string;
    model: string;
    cost_usd: number;
    tokens: number;
    requests: number;
  }>;
  daily: Array<{
    date: string;
    openai: number;
    anthropic: number;
    zakononline: number;
    secondlayer: number;
    voyage: number;
  }>;
}

interface ToolUsage {
  tool_name: string;
  request_count: number;
  total_revenue_usd: number;
  avg_cost_usd: number;
}

interface Transaction {
  id: string;
  user_id: string;
  user_email?: string;
  type: string;
  status: string;
  amount_usd: number;
  description?: string;
  created_at: string;
}

interface Cohort {
  month: string;
  users: number;
  active_users: number;
  total_revenue_usd: number;
  retention_rate: number;
}

interface Pagination {
  limit: number;
  offset: number;
  total: number;
}

// ── Formatters ─────────────────────────────────────────

function formatUSD(n: number | null | undefined): string {
  if (n == null) return '$0.00';
  return `$${Number(n).toFixed(2)}`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'N/A';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'N/A';
  return d.toLocaleDateString('uk-UA', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ── Chart colors ───────────────────────────────────────

const COLORS = {
  blue: '#60a5fa',
  emerald: '#34d399',
  amber: '#fbbf24',
  red: '#f87171',
  purple: '#a78bfa',
  indigo: '#818cf8',
  cyan: '#22d3ee',
  pink: '#f472b6',
};

const PROVIDER_COLORS: Record<string, string> = {
  OpenAI: COLORS.emerald,
  Anthropic: COLORS.purple,
  VoyageAI: COLORS.cyan,
  ZakonOnline: COLORS.amber,
  'SecondLayer API': COLORS.blue,
};

const PIE_COLORS = [COLORS.emerald, COLORS.purple, COLORS.amber, COLORS.blue, COLORS.red, COLORS.indigo];

const tooltipStyle = {
  contentStyle: {
    backgroundColor: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
    fontSize: '12px',
    padding: '8px 12px',
  },
  labelStyle: { fontSize: '11px', color: '#6b7280' },
};

// ── Components ─────────────────────────────────────────

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

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-claude-border p-5 shadow-sm">
      <h3 className="text-sm font-medium text-claude-text mb-4">{title}</h3>
      {children}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────

const PAGE_SIZE = 20;

export function AdminCostsPage() {
  // Cost breakdown state
  const [costDays, setCostDays] = useState(30);
  const [costData, setCostData] = useState<CostBreakdown | null>(null);
  const [costLoading, setCostLoading] = useState(true);

  // Tool usage state
  const [toolUsage, setToolUsage] = useState<ToolUsage[]>([]);
  const [usageLoading, setUsageLoading] = useState(true);

  // Transaction state
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [txPagination, setTxPagination] = useState<Pagination>({ limit: PAGE_SIZE, offset: 0, total: 0 });
  const [txLoading, setTxLoading] = useState(true);
  const [txTypeFilter, setTxTypeFilter] = useState('');
  const [txStatusFilter, setTxStatusFilter] = useState('');

  // Cohort state
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [cohortsLoading, setCohortsLoading] = useState(true);

  const [error, setError] = useState<string | null>(null);

  const fetchCostBreakdown = useCallback(async () => {
    setCostLoading(true);
    try {
      const res = await api.admin.getCostBreakdown(costDays);
      setCostData(res.data);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setCostLoading(false);
    }
  }, [costDays]);

  const fetchUsage = useCallback(async () => {
    setUsageLoading(true);
    try {
      const res = await api.admin.getUsageAnalytics(costDays);
      setToolUsage(res.data?.usage || []);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setUsageLoading(false);
    }
  }, [costDays]);

  const fetchTransactions = useCallback(async (offset = 0) => {
    setTxLoading(true);
    try {
      const params: any = { limit: PAGE_SIZE, offset };
      if (txTypeFilter) params.type = txTypeFilter;
      if (txStatusFilter) params.status = txStatusFilter;
      const res = await api.admin.getTransactions(params);
      setTransactions(res.data?.transactions || []);
      setTxPagination(res.data?.pagination || { limit: PAGE_SIZE, offset, total: 0 });
    } catch (err: any) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setTxLoading(false);
    }
  }, [txTypeFilter, txStatusFilter]);

  const fetchCohorts = async () => {
    setCohortsLoading(true);
    try {
      const res = await api.admin.getCohorts();
      setCohorts(res.data?.cohorts || []);
    } catch {
      // non-critical
    } finally {
      setCohortsLoading(false);
    }
  };

  useEffect(() => {
    fetchCostBreakdown();
    fetchUsage();
  }, [fetchCostBreakdown, fetchUsage]);

  useEffect(() => {
    fetchTransactions(0);
  }, [fetchTransactions]);

  useEffect(() => {
    fetchCohorts();
  }, []);

  const handleRefund = async (txId: string) => {
    const reason = prompt('Refund reason:');
    if (!reason) return;
    try {
      await api.admin.refundTransaction(txId, reason);
      toast.success('Transaction refunded');
      fetchTransactions(txPagination.offset);
    } catch {
      toast.error('Failed to refund');
    }
  };

  const txTotalPages = Math.ceil(txPagination.total / PAGE_SIZE);
  const txCurrentPage = Math.floor(txPagination.offset / PAGE_SIZE) + 1;

  const totalRequests = toolUsage.reduce((s, t) => s + t.request_count, 0);

  if (error && !costData && toolUsage.length === 0 && transactions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center">
          <XCircle size={32} className="text-red-500" />
          <p className="text-red-600">{error}</p>
          <button
            onClick={() => {
              setError(null);
              fetchCostBreakdown();
              fetchUsage();
              fetchTransactions(0);
            }}
            className="px-4 py-2 bg-claude-text text-white rounded-lg text-sm"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Daily chart data
  const dailyChartData = (costData?.daily || []).map((d) => ({
    date: new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    OpenAI: d.openai,
    Anthropic: d.anthropic,
    VoyageAI: d.voyage,
    ZakonOnline: d.zakononline,
    SecondLayer: d.secondlayer,
  }));

  // Provider pie data
  const providerPieData = (costData?.by_provider || []).filter((p) => p.cost_usd > 0);
  const totalProviderCost = providerPieData.reduce((s, p) => s + p.cost_usd, 0) || 1;

  // Model breakdown
  const byModel = costData?.by_model || [];
  const totalModelCost = byModel.reduce((s, m) => s + m.cost_usd, 0) || 1;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-claude-text font-sans">Cost Breakdown</h1>
          <p className="text-sm text-claude-subtext mt-1">
            {costData
              ? `${costData.period.from} — ${costData.period.to} | ${costData.totals.total_requests.toLocaleString()} requests`
              : 'Loading...'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                onClick={() => setCostDays(d)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  costDays === d
                    ? 'bg-white text-claude-text shadow-sm'
                    : 'text-claude-subtext hover:text-claude-text'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            onClick={() => {
              fetchCostBreakdown();
              fetchUsage();
            }}
            disabled={costLoading}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-claude-border rounded-lg text-sm text-claude-text hover:bg-claude-bg transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={costLoading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      {costLoading && !costData ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4 mb-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-claude-border p-5 shadow-sm animate-pulse h-28" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4 mb-6">
          <KPICard
            label="Total Cost"
            value={formatUSD(costData?.totals.total_cost_usd)}
            icon={DollarSign}
            color="bg-red-50 text-red-600"
            subLabel="Requests"
            subValue={costData?.totals.total_requests.toLocaleString()}
          />
          <KPICard
            label="OpenAI"
            value={formatUSD(costData?.totals.openai_cost_usd)}
            icon={Cpu}
            color="bg-emerald-50 text-emerald-600"
          />
          <KPICard
            label="Anthropic"
            value={formatUSD(costData?.totals.anthropic_cost_usd)}
            icon={Zap}
            color="bg-purple-50 text-purple-600"
          />
          <KPICard
            label="VoyageAI"
            value={formatUSD(costData?.totals.voyage_cost_usd)}
            icon={Layers}
            color="bg-cyan-50 text-cyan-600"
          />
          <KPICard
            label="ZakonOnline"
            value={formatUSD(costData?.totals.zakononline_cost_usd)}
            icon={Globe}
            color="bg-amber-50 text-amber-600"
          />
          <KPICard
            label="SecondLayer"
            value={formatUSD(costData?.totals.secondlayer_cost_usd)}
            icon={Server}
            color="bg-blue-50 text-blue-600"
          />
        </div>
      )}

      {/* Charts Row: Daily Stacked Area + Provider Pie */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="lg:col-span-2">
          <ChartCard title="Daily Cost by Provider">
            {dailyChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={dailyChartData}>
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10, fill: '#9ca3af' }}
                    axisLine={false}
                    tickLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: '#9ca3af' }}
                    axisLine={false}
                    tickLine={false}
                    width={50}
                    tickFormatter={(v) => `$${v}`}
                  />
                  <Tooltip
                    {...tooltipStyle}
                    formatter={(value: number) => [`$${Number(value).toFixed(4)}`]}
                  />
                  <Legend
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="OpenAI"
                    stackId="1"
                    stroke={COLORS.emerald}
                    fill={COLORS.emerald}
                    fillOpacity={0.7}
                  />
                  <Area
                    type="monotone"
                    dataKey="Anthropic"
                    stackId="1"
                    stroke={COLORS.purple}
                    fill={COLORS.purple}
                    fillOpacity={0.7}
                  />
                  <Area
                    type="monotone"
                    dataKey="VoyageAI"
                    stackId="1"
                    stroke={COLORS.cyan}
                    fill={COLORS.cyan}
                    fillOpacity={0.7}
                  />
                  <Area
                    type="monotone"
                    dataKey="ZakonOnline"
                    stackId="1"
                    stroke={COLORS.amber}
                    fill={COLORS.amber}
                    fillOpacity={0.7}
                  />
                  <Area
                    type="monotone"
                    dataKey="SecondLayer"
                    stackId="1"
                    stroke={COLORS.blue}
                    fill={COLORS.blue}
                    fillOpacity={0.7}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[280px] flex items-center justify-center text-sm text-claude-subtext">
                {costLoading ? 'Loading...' : 'No cost data for this period'}
              </div>
            )}
          </ChartCard>
        </div>

        <ChartCard title="Cost Share by Provider">
          {providerPieData.length > 0 ? (
            <div className="flex flex-col items-center">
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={providerPieData}
                    dataKey="cost_usd"
                    nameKey="provider"
                    cx="50%"
                    cy="50%"
                    innerRadius={45}
                    outerRadius={75}
                    paddingAngle={2}
                  >
                    {providerPieData.map((p, idx) => (
                      <Cell
                        key={idx}
                        fill={PROVIDER_COLORS[p.provider] || PIE_COLORS[idx % PIE_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    {...tooltipStyle}
                    formatter={(value: number) => [`$${Number(value).toFixed(4)}`]}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="w-full space-y-1.5 mt-2">
                {providerPieData.map((p, idx) => (
                  <div key={p.provider} className="flex items-center gap-2 text-xs">
                    <div
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: PROVIDER_COLORS[p.provider] || PIE_COLORS[idx % PIE_COLORS.length] }}
                    />
                    <span className="text-claude-text flex-1">{p.provider}</span>
                    <span className="text-claude-subtext font-mono">{formatUSD(p.cost_usd)}</span>
                    <span className="text-claude-subtext w-10 text-right">
                      {((p.cost_usd / totalProviderCost) * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="h-[280px] flex items-center justify-center text-sm text-claude-subtext">
              {costLoading ? 'Loading...' : 'No cost data'}
            </div>
          )}
        </ChartCard>
      </div>

      {/* Model Breakdown Table */}
      <section className="mb-10">
        <div className="flex items-center gap-2 mb-4">
          <Cpu size={18} className="text-claude-subtext" />
          <h2 className="text-lg font-semibold text-claude-text font-sans">Cost by Model</h2>
        </div>

        <div className="bg-white rounded-xl border border-claude-border shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-claude-border bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-claude-subtext">Provider</th>
                  <th className="text-left px-4 py-3 font-medium text-claude-subtext">Model</th>
                  <th className="text-right px-4 py-3 font-medium text-claude-subtext">Requests</th>
                  <th className="text-right px-4 py-3 font-medium text-claude-subtext">Tokens</th>
                  <th className="text-right px-4 py-3 font-medium text-claude-subtext">Cost</th>
                  <th className="px-4 py-3 font-medium text-claude-subtext">Share</th>
                </tr>
              </thead>
              <tbody>
                {costLoading && byModel.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-8 text-claude-subtext">
                      <RefreshCw size={20} className="animate-spin inline-block mr-2" />
                      Loading...
                    </td>
                  </tr>
                ) : byModel.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-8 text-claude-subtext">
                      No model data for this period
                    </td>
                  </tr>
                ) : (
                  byModel.map((m) => {
                    const pct = (m.cost_usd / totalModelCost) * 100;
                    return (
                      <tr key={`${m.provider}-${m.model}`} className="border-b border-claude-border/50 hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <span
                            className="inline-block px-2 py-0.5 rounded-full text-xs font-medium"
                            style={{
                              backgroundColor: `${PROVIDER_COLORS[m.provider] || COLORS.blue}20`,
                              color: PROVIDER_COLORS[m.provider] || COLORS.blue,
                            }}
                          >
                            {m.provider}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-claude-text">{m.model}</td>
                        <td className="px-4 py-3 text-right">{m.requests.toLocaleString()}</td>
                        <td className="px-4 py-3 text-right">{m.tokens.toLocaleString()}</td>
                        <td className="px-4 py-3 text-right font-mono">{formatUSD(m.cost_usd)}</td>
                        <td className="px-4 py-3 w-32">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                              <div
                                className="h-full rounded-full"
                                style={{
                                  width: `${pct}%`,
                                  backgroundColor: PROVIDER_COLORS[m.provider] || COLORS.blue,
                                }}
                              />
                            </div>
                            <span className="text-xs text-claude-subtext w-10 text-right">
                              {pct.toFixed(0)}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Tool Usage Section */}
      <section className="mb-10">
        <div className="flex items-center gap-2 mb-4">
          <BarChart3 size={18} className="text-claude-subtext" />
          <h2 className="text-lg font-semibold text-claude-text font-sans">Tool Usage</h2>
        </div>

        <div className="bg-white rounded-xl border border-claude-border shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-claude-border bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-claude-subtext">Tool</th>
                  <th className="text-right px-4 py-3 font-medium text-claude-subtext">Requests</th>
                  <th className="text-right px-4 py-3 font-medium text-claude-subtext">Revenue</th>
                  <th className="text-right px-4 py-3 font-medium text-claude-subtext">Avg Cost</th>
                  <th className="px-4 py-3 font-medium text-claude-subtext">Share</th>
                </tr>
              </thead>
              <tbody>
                {usageLoading ? (
                  <tr>
                    <td colSpan={5} className="text-center py-8 text-claude-subtext">
                      <RefreshCw size={20} className="animate-spin inline-block mr-2" />
                      Loading...
                    </td>
                  </tr>
                ) : toolUsage.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center py-8 text-claude-subtext">
                      No usage data
                    </td>
                  </tr>
                ) : (
                  toolUsage.map((t) => {
                    const pct = totalRequests > 0 ? (t.request_count / totalRequests) * 100 : 0;
                    return (
                      <tr key={t.tool_name} className="border-b border-claude-border/50 hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-claude-text font-mono text-xs">
                          {t.tool_name}
                        </td>
                        <td className="px-4 py-3 text-right">{t.request_count.toLocaleString()}</td>
                        <td className="px-4 py-3 text-right font-mono">${t.total_revenue_usd.toFixed(2)}</td>
                        <td className="px-4 py-3 text-right font-mono">${t.avg_cost_usd.toFixed(4)}</td>
                        <td className="px-4 py-3 w-32">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-blue-500 rounded-full"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-xs text-claude-subtext w-10 text-right">
                              {pct.toFixed(0)}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Transactions Section */}
      <section className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <DollarSign size={18} className="text-claude-subtext" />
            <h2 className="text-lg font-semibold text-claude-text font-sans">Transactions</h2>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={txTypeFilter}
              onChange={(e) => setTxTypeFilter(e.target.value)}
              className="px-3 py-1.5 border border-claude-border rounded-lg text-sm bg-white"
            >
              <option value="">All Types</option>
              <option value="charge">Charge</option>
              <option value="topup">Top-up</option>
              <option value="refund">Refund</option>
              <option value="adjustment">Adjustment</option>
            </select>
            <select
              value={txStatusFilter}
              onChange={(e) => setTxStatusFilter(e.target.value)}
              className="px-3 py-1.5 border border-claude-border rounded-lg text-sm bg-white"
            >
              <option value="">All Statuses</option>
              <option value="completed">Completed</option>
              <option value="pending">Pending</option>
              <option value="refunded">Refunded</option>
              <option value="failed">Failed</option>
            </select>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-claude-border shadow-sm overflow-hidden mb-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-claude-border bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-claude-subtext">Date</th>
                  <th className="text-left px-4 py-3 font-medium text-claude-subtext">User</th>
                  <th className="text-left px-4 py-3 font-medium text-claude-subtext">Type</th>
                  <th className="text-left px-4 py-3 font-medium text-claude-subtext">Status</th>
                  <th className="text-right px-4 py-3 font-medium text-claude-subtext">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-claude-subtext">Actions</th>
                </tr>
              </thead>
              <tbody>
                {txLoading ? (
                  <tr>
                    <td colSpan={6} className="text-center py-8 text-claude-subtext">
                      <RefreshCw size={20} className="animate-spin inline-block mr-2" />
                      Loading...
                    </td>
                  </tr>
                ) : transactions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-8 text-claude-subtext">
                      No transactions found
                    </td>
                  </tr>
                ) : (
                  transactions.map((tx) => (
                    <tr key={tx.id} className="border-b border-claude-border/50 hover:bg-gray-50">
                      <td className="px-4 py-3 text-xs text-claude-subtext">{formatDate(tx.created_at)}</td>
                      <td className="px-4 py-3 text-xs">{tx.user_email || tx.user_id?.slice(0, 8)}</td>
                      <td className="px-4 py-3">
                        <span className="capitalize text-xs">{tx.type}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                            tx.status === 'completed'
                              ? 'bg-green-50 text-green-700'
                              : tx.status === 'refunded'
                              ? 'bg-amber-50 text-amber-700'
                              : tx.status === 'failed'
                              ? 'bg-red-50 text-red-700'
                              : 'bg-gray-50 text-gray-700'
                          }`}
                        >
                          {tx.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono">${Number(tx.amount_usd || 0).toFixed(4)}</td>
                      <td className="px-4 py-3">
                        {tx.status === 'completed' && tx.type === 'charge' && (
                          <button
                            onClick={() => handleRefund(tx.id)}
                            className="px-2 py-1 text-xs border border-red-200 text-red-600 rounded hover:bg-red-50 transition-colors"
                          >
                            Refund
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Transactions Pagination */}
        {txTotalPages > 1 && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-claude-subtext">
              Page {txCurrentPage} of {txTotalPages}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => fetchTransactions(txPagination.offset - PAGE_SIZE)}
                disabled={txPagination.offset === 0}
                className="p-2 border border-claude-border rounded-lg hover:bg-gray-50 disabled:opacity-30 transition-colors"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                onClick={() => fetchTransactions(txPagination.offset + PAGE_SIZE)}
                disabled={txPagination.offset + PAGE_SIZE >= txPagination.total}
                className="p-2 border border-claude-border rounded-lg hover:bg-gray-50 disabled:opacity-30 transition-colors"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Cohort Analysis */}
      <section className="mb-8">
        <div className="flex items-center gap-2 mb-4">
          <Users size={18} className="text-claude-subtext" />
          <h2 className="text-lg font-semibold text-claude-text font-sans">Cohort Analysis</h2>
        </div>

        <div className="bg-white rounded-xl border border-claude-border shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-claude-border bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-claude-subtext">Month</th>
                  <th className="text-right px-4 py-3 font-medium text-claude-subtext">Signups</th>
                  <th className="text-right px-4 py-3 font-medium text-claude-subtext">Active</th>
                  <th className="text-right px-4 py-3 font-medium text-claude-subtext">Revenue</th>
                  <th className="px-4 py-3 font-medium text-claude-subtext">Retention</th>
                </tr>
              </thead>
              <tbody>
                {cohortsLoading ? (
                  <tr>
                    <td colSpan={5} className="text-center py-8 text-claude-subtext">
                      <RefreshCw size={20} className="animate-spin inline-block mr-2" />
                      Loading...
                    </td>
                  </tr>
                ) : cohorts.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center py-8 text-claude-subtext">
                      No cohort data
                    </td>
                  </tr>
                ) : (
                  cohorts.map((c) => (
                    <tr key={c.month} className="border-b border-claude-border/50 hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium">
                        {new Date(c.month + '-01').toLocaleDateString('en-US', {
                          month: 'short',
                          year: 'numeric',
                        })}
                      </td>
                      <td className="px-4 py-3 text-right">{c.users}</td>
                      <td className="px-4 py-3 text-right">{c.active_users}</td>
                      <td className="px-4 py-3 text-right font-mono">${c.total_revenue_usd.toFixed(2)}</td>
                      <td className="px-4 py-3 w-36">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-emerald-500 rounded-full"
                              style={{ width: `${c.retention_rate}%` }}
                            />
                          </div>
                          <span className="text-xs text-claude-subtext w-10 text-right">
                            {c.retention_rate.toFixed(0)}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
