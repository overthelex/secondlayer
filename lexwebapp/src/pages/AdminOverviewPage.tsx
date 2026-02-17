/**
 * Admin Overview Page
 * System dashboard with KPIs, recharts visualizations, Prometheus metrics
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  RefreshCw,
  DollarSign,
  Users,
  TrendingUp,
  AlertTriangle,
  Activity,
  XCircle,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  ComposedChart,
  Bar,
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

// ── Types ──────────────────────────────────────────────

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

interface TimeSeriesPoint {
  timestamp: number;
  value: number;
}

interface TrafficData {
  rps: TimeSeriesPoint[];
  errors: TimeSeriesPoint[];
}

interface LatencyData {
  p50: TimeSeriesPoint[];
  p95: TimeSeriesPoint[];
  p99: TimeSeriesPoint[];
}

interface ServiceHealth {
  job: string;
  instance: string;
  up: boolean;
}

interface SystemMetrics {
  pg_pool: { active: number; max: number; utilization_pct: number };
  redis: { used_bytes: number; max_bytes: number; utilization_pct: number };
  upload_queue: { depth: number };
}

interface ToolUsage {
  tool_name: string;
  request_count: number;
  total_revenue_usd: number;
  avg_cost_usd: number;
}

type TimeRange = '1h' | '6h' | '24h';

// ── Formatters ─────────────────────────────────────────

function formatUSD(n: number | null | undefined): string {
  if (n == null) return '$0.00';
  return `$${Number(n).toFixed(2)}`;
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return '0';
  return Number(n).toLocaleString('en-US');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-US', {
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

const PIE_COLORS = [COLORS.blue, COLORS.emerald, COLORS.amber, COLORS.red, COLORS.purple, COLORS.indigo, COLORS.cyan, COLORS.pink];

// ── Shared tooltip style ───────────────────────────────

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

function ServiceHealthBar({ services }: { services: ServiceHealth[] }) {
  // Group known services
  const known = ['backend', 'rada', 'openreyestr'];
  const serviceMap = new Map<string, boolean>();

  for (const s of services) {
    const job = s.job.toLowerCase();
    for (const k of known) {
      if (job.includes(k) || job.includes('app')) {
        serviceMap.set(k, s.up);
      }
    }
    if (!known.some((k) => job.includes(k))) {
      serviceMap.set(s.job, s.up);
    }
  }

  // If no Prometheus data, show the 3 known services as unknown
  if (serviceMap.size === 0) {
    for (const k of known) serviceMap.set(k, false);
  }

  return (
    <div className="bg-white rounded-xl border border-claude-border p-4 shadow-sm mb-6">
      <h3 className="text-sm font-medium text-claude-text mb-3">Service Health</h3>
      <div className="flex flex-wrap gap-4">
        {Array.from(serviceMap.entries()).map(([name, up]) => (
          <div key={name} className="flex items-center gap-2">
            <div
              className={`w-2.5 h-2.5 rounded-full ${up ? 'bg-emerald-400' : 'bg-red-400'}`}
            />
            <span className="text-sm text-claude-text capitalize">{name}</span>
            <span className={`text-xs ${up ? 'text-emerald-600' : 'text-red-500'}`}>
              {up ? 'Up' : 'Down'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GaugeCard({
  label,
  value,
  max,
  unit,
  pct,
}: {
  label: string;
  value: string;
  max: string;
  unit: string;
  pct: number;
}) {
  const barColor =
    pct > 80 ? 'bg-red-400' : pct > 60 ? 'bg-amber-400' : 'bg-emerald-400';

  return (
    <div className="bg-white rounded-xl border border-claude-border p-4 shadow-sm">
      <div className="text-sm text-claude-subtext mb-2">{label}</div>
      <div className="text-lg font-semibold text-claude-text font-sans mb-1">
        {value} <span className="text-xs text-claude-subtext font-normal">/ {max} {unit}</span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full ${barColor} rounded-full transition-all`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <div className="text-xs text-claude-subtext mt-1">{pct.toFixed(1)}%</div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────

export function AdminOverviewPage() {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [revenueChart, setRevenueChart] = useState<RevenuePoint[]>([]);
  const [tiers, setTiers] = useState<TierInfo[]>([]);
  const [traffic, setTraffic] = useState<TrafficData | null>(null);
  const [latency, setLatency] = useState<LatencyData | null>(null);
  const [services, setServices] = useState<ServiceHealth[]>([]);
  const [system, setSystem] = useState<SystemMetrics | null>(null);
  const [toolUsage, setToolUsage] = useState<ToolUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>('1h');

  const fetchAll = useCallback(async (range: TimeRange = timeRange) => {
    setLoading(true);
    setError(null);
    try {
      const [ovRes, chartRes, tierRes, trafficRes, latencyRes, svcRes, sysRes, usageRes] =
        await Promise.all([
          api.admin.getOverview(),
          api.admin.getRevenueChart(30),
          api.admin.getTierDistribution(),
          api.admin.getTrafficMetrics(range).catch(() => ({ data: null })),
          api.admin.getLatencyMetrics(range).catch(() => ({ data: null })),
          api.admin.getServicesHealth().catch(() => ({ data: { services: [] } })),
          api.admin.getSystemMetrics().catch(() => ({ data: null })),
          api.admin.getUsageAnalytics(30).catch(() => ({ data: { usage: [] } })),
        ]);

      setOverview(ovRes.data);
      setRevenueChart((chartRes.data?.data || []).reverse());
      setTiers(tierRes.data?.tiers || []);
      setTraffic(trafficRes.data);
      setLatency(latencyRes.data);
      setServices(svcRes.data?.services || []);
      setSystem(sysRes.data);
      setToolUsage((usageRes.data?.usage || []).slice(0, 8));
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to load overview');
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  useEffect(() => {
    fetchAll();
  }, []);

  const handleRangeChange = (range: TimeRange) => {
    setTimeRange(range);
    fetchAll(range);
  };

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
          <button
            onClick={() => fetchAll()}
            className="px-4 py-2 bg-claude-text text-white rounded-lg text-sm"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Merge traffic data for the area chart
  const trafficChartData = (traffic?.rps || []).map((p, i) => ({
    time: formatTime(p.timestamp),
    rps: parseFloat(p.value.toFixed(2)),
    errors: parseFloat((traffic?.errors?.[i]?.value || 0).toFixed(3)),
  }));

  // Merge latency data
  const latencyChartData = (latency?.p50 || []).map((p, i) => ({
    time: formatTime(p.timestamp),
    p50: parseFloat(p.value.toFixed(1)),
    p95: parseFloat((latency?.p95?.[i]?.value || 0).toFixed(1)),
    p99: parseFloat((latency?.p99?.[i]?.value || 0).toFixed(1)),
  }));

  // Revenue chart data for composed chart
  const revenueChartData = revenueChart.map((p) => ({
    date: new Date(p.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    revenue: p.revenue_usd,
    cost: p.cost_usd,
    profit: p.profit_usd,
  }));

  // Tool usage for pie chart
  const totalToolRequests = toolUsage.reduce((s, t) => s + t.request_count, 0) || 1;

  const totalTierUsers = tiers.reduce((s, t) => s + t.user_count, 0) || 1;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-claude-text font-sans">System Overview</h1>
          <p className="text-sm text-claude-subtext mt-1">Real-time platform metrics</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Time range selector */}
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            {(['1h', '6h', '24h'] as TimeRange[]).map((r) => (
              <button
                key={r}
                onClick={() => handleRangeChange(r)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  timeRange === r
                    ? 'bg-white text-claude-text shadow-sm'
                    : 'text-claude-subtext hover:text-claude-text'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <button
            onClick={() => fetchAll()}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-claude-border rounded-lg text-sm text-claude-text hover:bg-claude-bg transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* KPI Row */}
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
          label="Active Users (30d)"
          value={formatNumber(overview?.users.active)}
          icon={Users}
          color="bg-indigo-50 text-indigo-600"
          subLabel="Total"
          subValue={formatNumber(overview?.users.total)}
        />
      </div>

      {/* Service Health Bar */}
      <ServiceHealthBar services={services} />

      {/* Chart Row 1: Traffic + Revenue */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <ChartCard title="Request Traffic">
          {trafficChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={trafficChartData}>
                <XAxis
                  dataKey="time"
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  axisLine={false}
                  tickLine={false}
                  width={40}
                />
                <Tooltip {...tooltipStyle} />
                <Area
                  type="monotone"
                  dataKey="rps"
                  stroke={COLORS.blue}
                  fill={COLORS.blue}
                  fillOpacity={0.15}
                  strokeWidth={2}
                  name="RPS"
                />
                <Line
                  type="monotone"
                  dataKey="errors"
                  stroke={COLORS.red}
                  strokeWidth={1.5}
                  dot={false}
                  name="Errors/s"
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-sm text-claude-subtext">
              No traffic data from Prometheus
            </div>
          )}
        </ChartCard>

        <ChartCard title="Revenue & Costs (30d)">
          {revenueChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart data={revenueChartData}>
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
                  width={45}
                  tickFormatter={(v) => `$${v}`}
                />
                <Tooltip
                  {...tooltipStyle}
                  formatter={(value: number) => [`$${Number(value).toFixed(2)}`]}
                />
                <Legend
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }}
                />
                <Bar dataKey="revenue" fill={COLORS.emerald} opacity={0.8} name="Revenue" radius={[2, 2, 0, 0]} />
                <Bar dataKey="cost" fill={COLORS.amber} opacity={0.8} name="Cost" radius={[2, 2, 0, 0]} />
                <Line
                  type="monotone"
                  dataKey="profit"
                  stroke={COLORS.blue}
                  strokeWidth={2}
                  dot={false}
                  name="Profit"
                />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-sm text-claude-subtext">
              No revenue data available
            </div>
          )}
        </ChartCard>
      </div>

      {/* Chart Row 2: Latency + Tool Usage */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <ChartCard title="Latency (ms)">
          {latencyChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={latencyChartData}>
                <XAxis
                  dataKey="time"
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  axisLine={false}
                  tickLine={false}
                  width={45}
                  tickFormatter={(v) => `${v}ms`}
                />
                <Tooltip
                  {...tooltipStyle}
                  formatter={(value: number) => [`${Number(value).toFixed(1)}ms`]}
                />
                <Legend
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }}
                />
                <Line type="monotone" dataKey="p50" stroke={COLORS.emerald} strokeWidth={2} dot={false} name="P50" />
                <Line type="monotone" dataKey="p95" stroke={COLORS.amber} strokeWidth={2} dot={false} name="P95" />
                <Line type="monotone" dataKey="p99" stroke={COLORS.red} strokeWidth={2} dot={false} name="P99" />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-sm text-claude-subtext">
              No latency data from Prometheus
            </div>
          )}
        </ChartCard>

        <ChartCard title="Tool Usage (30d)">
          {toolUsage.length > 0 ? (
            <div className="flex items-center gap-4">
              <ResponsiveContainer width="50%" height={220}>
                <PieChart>
                  <Pie
                    data={toolUsage}
                    dataKey="request_count"
                    nameKey="tool_name"
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                  >
                    {toolUsage.map((_, idx) => (
                      <Cell key={idx} fill={PIE_COLORS[idx % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    {...tooltipStyle}
                    formatter={(value: number) => [formatNumber(value), 'Requests']}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex-1 space-y-1.5 overflow-y-auto max-h-[220px]">
                {toolUsage.map((t, idx) => (
                  <div key={t.tool_name} className="flex items-center gap-2 text-xs">
                    <div
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: PIE_COLORS[idx % PIE_COLORS.length] }}
                    />
                    <span className="text-claude-text truncate flex-1">{t.tool_name}</span>
                    <span className="text-claude-subtext">{((t.request_count / totalToolRequests) * 100).toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-sm text-claude-subtext">
              No tool usage data
            </div>
          )}
        </ChartCard>
      </div>

      {/* System Gauges Row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <GaugeCard
          label="PG Pool Utilization"
          value={String(Math.round(system?.pg_pool.active || 0))}
          max={String(system?.pg_pool.max || 500)}
          unit="connections"
          pct={system?.pg_pool.utilization_pct || 0}
        />
        <GaugeCard
          label="Redis Memory"
          value={formatBytes(system?.redis.used_bytes || 0)}
          max={formatBytes(system?.redis.max_bytes || 0)}
          unit=""
          pct={system?.redis.utilization_pct || 0}
        />
        <GaugeCard
          label="Upload Queue"
          value={String(Math.round(system?.upload_queue.depth || 0))}
          max="200"
          unit="jobs"
          pct={Math.min(((system?.upload_queue.depth || 0) / 200) * 100, 100)}
        />
      </div>

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

      {/* Alerts Row */}
      {(overview?.alerts.failed_requests_today || 0) > 0 && (
        <section className="mb-8">
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
            <AlertTriangle size={20} className="text-red-500 flex-shrink-0" />
            <div>
              <span className="text-sm font-medium text-red-800">
                {overview?.alerts.failed_requests_today} failed requests today
              </span>
              <span className="text-xs text-red-600 ml-2">
                Check logs for details
              </span>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
