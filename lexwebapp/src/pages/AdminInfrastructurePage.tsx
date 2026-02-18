/**
 * Admin Infrastructure Page
 * Dashboards for Backend Performance, Upload Pipeline, API Cost Trends, and Infrastructure
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Server,
  Upload,
  DollarSign,
  Cpu,
  AlertTriangle,
  Lightbulb,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { api } from '../utils/api-client';

// ── Types ──────────────────────────────────────────────

type TimeRange = '1h' | '6h' | '24h';

interface SectionState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

// ── Formatters ─────────────────────────────────────────

function formatUSD(n: number | null | undefined): string {
  if (n == null) return '$0.00';
  return `$${Number(n).toFixed(4)}`;
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

function formatPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

// ── Colors ─────────────────────────────────────────────

const COLORS = {
  blue: '#60a5fa',
  emerald: '#34d399',
  amber: '#fbbf24',
  red: '#f87171',
  purple: '#a78bfa',
  indigo: '#818cf8',
  cyan: '#22d3ee',
  pink: '#f472b6',
  slate: '#94a3b8',
  orange: '#fb923c',
};

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

// ── Shared Components ──────────────────────────────────

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-claude-border p-5 shadow-sm">
      <h3 className="text-sm font-medium text-claude-text mb-4">{title}</h3>
      {children}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-xl border border-claude-border p-4 shadow-sm">
      <div className="text-xs text-claude-subtext mb-1">{label}</div>
      <div className="text-xl font-semibold text-claude-text font-sans">{value}</div>
      {sub && <div className="text-xs text-claude-subtext mt-1">{sub}</div>}
    </div>
  );
}

function GaugeBar({ label, pct, detail }: { label: string; pct: number; detail: string }) {
  const barColor = pct > 80 ? 'bg-red-400' : pct > 60 ? 'bg-amber-400' : 'bg-emerald-400';
  return (
    <div className="bg-white rounded-xl border border-claude-border p-4 shadow-sm">
      <div className="flex justify-between items-center mb-2">
        <span className="text-sm text-claude-subtext">{label}</span>
        <span className="text-sm font-semibold text-claude-text">{formatPct(pct)}</span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden mb-1">
        <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <div className="text-xs text-claude-subtext">{detail}</div>
    </div>
  );
}

interface Recommendation {
  severity: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
}

function generateRecommendations(data: any): Recommendation[] {
  const recommendations: Recommendation[] = [];

  if (!data) return recommendations;

  const cpuSeries = data?.cpu?.series || [];
  const memPct = data?.memory?.used_pct || 0;
  const pgCacheHit = data?.pg?.cache_hit_ratio || 0;
  const redisEvictedSeries = data?.redis?.evicted_keys?.series || [];

  const lastCpu = cpuSeries.length > 0 ? cpuSeries[cpuSeries.length - 1] : null;
  const cpuIowait = lastCpu?.iowait || 0;

  if (memPct > 80) {
    recommendations.push({
      severity: memPct > 90 ? 'critical' : 'warning',
      title: 'High Memory Usage',
      description: `Memory usage is at ${memPct.toFixed(1)}%. Consider adding more RAM or optimizing memory usage.`,
    });
  }

  if (pgCacheHit < 0.95 && pgCacheHit > 0) {
    recommendations.push({
      severity: pgCacheHit < 0.90 ? 'critical' : 'warning',
      title: 'Low PostgreSQL Cache Hit Ratio',
      description: `Cache hit ratio is ${(pgCacheHit * 100).toFixed(1)}%. Increase shared_buffers to 25% of RAM (currently 8GB).`,
    });
  }

  if (cpuIowait > 0.2) {
    recommendations.push({
      severity: cpuIowait > 0.4 ? 'critical' : 'warning',
      title: 'High CPU Iowait',
      description: `CPU iowait is ${(cpuIowait * 100).toFixed(1)}%. Consider using SSD for database or optimizing disk I/O.`,
    });
  }

  if (redisEvictedSeries.length > 1) {
    const lastEvicted = redisEvictedSeries[redisEvictedSeries.length - 1]?.value || 0;
    const prevEvicted = redisEvictedSeries[redisEvictedSeries.length - 2]?.value || 0;
    const evictedRate = lastEvicted - prevEvicted;
    if (evictedRate > 0) {
      recommendations.push({
        severity: 'warning',
        title: 'Redis Key Evictions',
        description: `Redis is evicting keys. Increase maxmemory or switch to allkeys-lru eviction policy.`,
      });
    }
  }

  if (recommendations.length === 0) {
    recommendations.push({
      severity: 'info',
      title: 'All Systems Healthy',
      description: 'No infrastructure issues detected. Keep monitoring regularly.',
    });
  }

  return recommendations;
}

function RecommendationsSection({ data }: { data: any }) {
  const recommendations = generateRecommendations(data);

  return (
    <div className="space-y-3">
      {recommendations.map((rec, idx) => (
        <div
          key={idx}
          className={`flex items-start gap-3 p-4 rounded-xl border ${
            rec.severity === 'critical'
              ? 'bg-red-50 border-red-200'
              : rec.severity === 'warning'
              ? 'bg-amber-50 border-amber-200'
              : 'bg-emerald-50 border-emerald-200'
          }`}
        >
          {rec.severity === 'info' ? (
            <Lightbulb size={18} className="text-emerald-600 mt-0.5 flex-shrink-0" />
          ) : (
            <AlertTriangle size={18} className={rec.severity === 'critical' ? 'text-red-600 mt-0.5 flex-shrink-0' : 'text-amber-600 mt-0.5 flex-shrink-0'} />
          )}
          <div>
            <div className={`text-sm font-medium ${
              rec.severity === 'critical' ? 'text-red-800' : rec.severity === 'warning' ? 'text-amber-800' : 'text-emerald-800'
            }`}>
              {rec.title}
            </div>
            <div className={`text-xs mt-0.5 ${
              rec.severity === 'critical' ? 'text-red-600' : rec.severity === 'warning' ? 'text-amber-600' : 'text-emerald-600'
            }`}>
              {rec.description}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function SectionHeader({
  title,
  icon: Icon,
  open,
  onToggle,
}: {
  title: string;
  icon: React.ElementType;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between py-3 px-1 text-left group"
    >
      <div className="flex items-center gap-2">
        <Icon size={18} className="text-claude-subtext" />
        <h2 className="text-lg font-semibold text-claude-text">{title}</h2>
      </div>
      {open ? (
        <ChevronUp size={18} className="text-claude-subtext" />
      ) : (
        <ChevronDown size={18} className="text-claude-subtext" />
      )}
    </button>
  );
}

function LoadingPlaceholder() {
  return (
    <div className="flex items-center justify-center py-12 text-claude-subtext">
      <RefreshCw size={18} className="animate-spin mr-2" />
      Завантаження...
    </div>
  );
}

function ErrorPlaceholder({ message }: { message: string }) {
  return (
    <div className="text-center py-8 text-red-500 text-sm">
      {message}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────

export function AdminInfrastructurePage() {
  const [range, setRange] = useState<TimeRange>('1h');
  const [refreshKey, setRefreshKey] = useState(0);

  // Section open/close state
  const [openSections, setOpenSections] = useState({
    backend: true,
    upload: true,
    cost: true,
    infra: true,
  });

  const toggleSection = (key: keyof typeof openSections) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Data states
  const [backendDetail, setBackendDetail] = useState<SectionState<any>>({ data: null, loading: true, error: null });
  const [uploadPipeline, setUploadPipeline] = useState<SectionState<any>>({ data: null, loading: true, error: null });
  const [costRealtime, setCostRealtime] = useState<SectionState<any>>({ data: null, loading: true, error: null });
  const [infrastructure, setInfrastructure] = useState<SectionState<any>>({ data: null, loading: true, error: null });

  const fetchBackendDetail = useCallback(async () => {
    setBackendDetail((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const { data } = await api.admin.getBackendDetailMetrics(range);
      setBackendDetail({ data, loading: false, error: null });
    } catch (e: any) {
      setBackendDetail({ data: null, loading: false, error: e.message || 'Failed to load' });
    }
  }, [range]);

  const fetchUploadPipeline = useCallback(async () => {
    setUploadPipeline((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const { data } = await api.admin.getUploadPipelineMetrics(range);
      setUploadPipeline({ data, loading: false, error: null });
    } catch (e: any) {
      setUploadPipeline({ data: null, loading: false, error: e.message || 'Failed to load' });
    }
  }, [range]);

  const fetchCostRealtime = useCallback(async () => {
    setCostRealtime((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const { data } = await api.admin.getCostRealtimeMetrics(range);
      setCostRealtime({ data, loading: false, error: null });
    } catch (e: any) {
      setCostRealtime({ data: null, loading: false, error: e.message || 'Failed to load' });
    }
  }, [range]);

  const fetchInfrastructure = useCallback(async () => {
    setInfrastructure((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const { data } = await api.admin.getInfrastructureMetrics(range);
      setInfrastructure({ data, loading: false, error: null });
    } catch (e: any) {
      setInfrastructure({ data: null, loading: false, error: e.message || 'Failed to load' });
    }
  }, [range]);

  useEffect(() => {
    fetchBackendDetail();
    fetchUploadPipeline();
    fetchCostRealtime();
    fetchInfrastructure();
  }, [fetchBackendDetail, fetchUploadPipeline, fetchCostRealtime, fetchInfrastructure, refreshKey]);

  const handleRefresh = () => setRefreshKey((k) => k + 1);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-claude-text">Інфраструктура</h1>
          <p className="text-sm text-claude-subtext mt-1">
            Детальний моніторинг бекенду, черг та ресурсів
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Time range selector */}
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            {(['1h', '6h', '24h'] as TimeRange[]).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3 py-1.5 rounded-md text-sm transition-all ${
                  range === r
                    ? 'bg-white shadow-sm text-claude-text font-medium'
                    : 'text-claude-subtext hover:text-claude-text'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <button
            onClick={handleRefresh}
            className="p-2 rounded-lg text-claude-subtext hover:text-claude-text hover:bg-gray-100 transition-colors"
            title="Оновити"
          >
            <RefreshCw size={18} />
          </button>
        </div>
      </div>

      {/* Section 1: Backend Performance */}
      <div className="border-b border-claude-border">
        <SectionHeader title="Backend Performance" icon={Server} open={openSections.backend} onToggle={() => toggleSection('backend')} />
        {openSections.backend && (
          <div className="pb-6">
            {backendDetail.loading ? (
              <LoadingPlaceholder />
            ) : backendDetail.error ? (
              <ErrorPlaceholder message={backendDetail.error} />
            ) : (
              <BackendDetailSection data={backendDetail.data} />
            )}
          </div>
        )}
      </div>

      {/* Section 2: Upload Pipeline */}
      <div className="border-b border-claude-border">
        <SectionHeader title="Upload Pipeline" icon={Upload} open={openSections.upload} onToggle={() => toggleSection('upload')} />
        {openSections.upload && (
          <div className="pb-6">
            {uploadPipeline.loading ? (
              <LoadingPlaceholder />
            ) : uploadPipeline.error ? (
              <ErrorPlaceholder message={uploadPipeline.error} />
            ) : (
              <UploadPipelineSection data={uploadPipeline.data} />
            )}
          </div>
        )}
      </div>

      {/* Section 3: API Cost Trends */}
      <div className="border-b border-claude-border">
        <SectionHeader title="API Cost Trends" icon={DollarSign} open={openSections.cost} onToggle={() => toggleSection('cost')} />
        {openSections.cost && (
          <div className="pb-6">
            {costRealtime.loading ? (
              <LoadingPlaceholder />
            ) : costRealtime.error ? (
              <ErrorPlaceholder message={costRealtime.error} />
            ) : (
              <CostRealtimeSection data={costRealtime.data} />
            )}
          </div>
        )}
      </div>

      {/* Section 4: Infrastructure */}
      <div>
        <SectionHeader title="Infrastructure" icon={Cpu} open={openSections.infra} onToggle={() => toggleSection('infra')} />
        {openSections.infra && (
          <div className="pb-6">
            {infrastructure.loading ? (
              <LoadingPlaceholder />
            ) : infrastructure.error ? (
              <ErrorPlaceholder message={infrastructure.error} />
            ) : (
              <>
                <InfrastructureSection data={infrastructure.data} />
                <div className="mt-6">
                  <h3 className="text-sm font-medium text-claude-text mb-3">Рекомендації</h3>
                  <RecommendationsSection data={infrastructure.data} />
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Section: Backend Detail ────────────────────────────

function BackendDetailSection({ data }: { data: any }) {
  const statusCodes = data?.status_codes?.series || [];
  const byRoute = (data?.by_route || []).slice(0, 8); // Top 8 routes

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Status codes stacked area */}
      <ChartCard title="HTTP Status Codes">
        <ResponsiveContainer width="100%" height={250}>
          <AreaChart data={statusCodes}>
            <XAxis dataKey="timestamp" tickFormatter={formatTime} tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip {...tooltipStyle} labelFormatter={formatTime} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Area type="monotone" dataKey="2xx" stackId="1" stroke={COLORS.emerald} fill={COLORS.emerald} fillOpacity={0.6} />
            <Area type="monotone" dataKey="3xx" stackId="1" stroke={COLORS.blue} fill={COLORS.blue} fillOpacity={0.6} />
            <Area type="monotone" dataKey="4xx" stackId="1" stroke={COLORS.amber} fill={COLORS.amber} fillOpacity={0.6} />
            <Area type="monotone" dataKey="5xx" stackId="1" stroke={COLORS.red} fill={COLORS.red} fillOpacity={0.6} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Request rate by route */}
      <ChartCard title="Request Rate by Route (RPS)">
        <ResponsiveContainer width="100%" height={250}>
          <LineChart>
            <XAxis
              dataKey="timestamp"
              tickFormatter={formatTime}
              tick={{ fontSize: 11 }}
              type="number"
              domain={['dataMin', 'dataMax']}
            />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip {...tooltipStyle} labelFormatter={formatTime} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {byRoute.map((route: any, i: number) => (
              <Line
                key={route.route}
                data={route.series}
                dataKey="rps"
                name={route.route}
                stroke={Object.values(COLORS)[i % 10]}
                dot={false}
                strokeWidth={1.5}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* External API calls */}
      {data?.external_apis?.calls?.length > 0 && (
        <ChartCard title="External API Calls (rate/s)">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart>
              <XAxis dataKey="timestamp" tickFormatter={formatTime} tick={{ fontSize: 11 }} type="number" domain={['dataMin', 'dataMax']} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip {...tooltipStyle} labelFormatter={formatTime} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {(data.external_apis.calls || []).map((svc: any, i: number) => (
                <Line key={svc.service} data={svc.series} dataKey="value" name={svc.service} stroke={Object.values(COLORS)[i % 10]} dot={false} strokeWidth={1.5} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* External API latency P95 */}
      {data?.external_apis?.duration_p95?.length > 0 && (
        <ChartCard title="External API Latency P95 (ms)">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart>
              <XAxis dataKey="timestamp" tickFormatter={formatTime} tick={{ fontSize: 11 }} type="number" domain={['dataMin', 'dataMax']} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip {...tooltipStyle} labelFormatter={formatTime} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {(data.external_apis.duration_p95 || []).map((svc: any, i: number) => (
                <Line key={svc.service} data={svc.series} dataKey="value" name={svc.service} stroke={Object.values(COLORS)[(i + 3) % 10]} dot={false} strokeWidth={1.5} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
    </div>
  );
}

// ── Section: Upload Pipeline ───────────────────────────

function UploadPipelineSection({ data }: { data: any }) {
  const jobs = data?.jobs?.series || [];
  const duration = data?.processing_duration?.series || [];
  const queueDepth = data?.queue_depth?.series || [];
  const concurrency = data?.concurrency?.series || [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Jobs by status */}
      <ChartCard title="BullMQ Jobs by Status">
        <ResponsiveContainer width="100%" height={250}>
          <AreaChart data={jobs}>
            <XAxis dataKey="timestamp" tickFormatter={formatTime} tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip {...tooltipStyle} labelFormatter={formatTime} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Area type="monotone" dataKey="completed" stackId="1" stroke={COLORS.emerald} fill={COLORS.emerald} fillOpacity={0.6} />
            <Area type="monotone" dataKey="active" stackId="1" stroke={COLORS.blue} fill={COLORS.blue} fillOpacity={0.6} />
            <Area type="monotone" dataKey="waiting" stackId="1" stroke={COLORS.amber} fill={COLORS.amber} fillOpacity={0.6} />
            <Area type="monotone" dataKey="delayed" stackId="1" stroke={COLORS.purple} fill={COLORS.purple} fillOpacity={0.6} />
            <Area type="monotone" dataKey="failed" stackId="1" stroke={COLORS.red} fill={COLORS.red} fillOpacity={0.6} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Processing duration percentiles */}
      <ChartCard title="Processing Duration (ms)">
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={duration}>
            <XAxis dataKey="timestamp" tickFormatter={formatTime} tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip {...tooltipStyle} labelFormatter={formatTime} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="p50" stroke={COLORS.emerald} dot={false} strokeWidth={1.5} name="P50" />
            <Line type="monotone" dataKey="p95" stroke={COLORS.amber} dot={false} strokeWidth={1.5} name="P95" />
            <Line type="monotone" dataKey="p99" stroke={COLORS.red} dot={false} strokeWidth={1.5} name="P99" />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Queue depth */}
      <ChartCard title="Queue Depth">
        <ResponsiveContainer width="100%" height={250}>
          <AreaChart data={queueDepth}>
            <XAxis dataKey="timestamp" tickFormatter={formatTime} tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip {...tooltipStyle} labelFormatter={formatTime} />
            <Area type="monotone" dataKey="value" stroke={COLORS.indigo} fill={COLORS.indigo} fillOpacity={0.3} name="Queue Depth" />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Concurrency */}
      <ChartCard title="Concurrency">
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={concurrency}>
            <XAxis dataKey="timestamp" tickFormatter={formatTime} tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip {...tooltipStyle} labelFormatter={formatTime} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="active" stroke={COLORS.blue} dot={false} strokeWidth={1.5} name="Active" />
            <Line type="monotone" dataKey="max" stroke={COLORS.slate} dot={false} strokeWidth={1.5} strokeDasharray="5 5" name="Max" />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}

// ── Section: Cost Realtime ─────────────────────────────

function CostRealtimeSection({ data }: { data: any }) {
  const byModel = data?.by_model?.series || [];
  const topTools = data?.top_tools || [];

  // Extract all model keys from the first data point
  const modelKeys = byModel.length > 0
    ? Object.keys(byModel[0]).filter((k) => k !== 'timestamp')
    : [];

  return (
    <div className="space-y-4">
      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Вартість / годину" value={formatUSD(data?.cost_per_hour)} sub="Поточний рейт" />
        <StatCard label="Вартість / день" value={formatUSD(data?.cost_per_day)} sub="Екстраполяція" />
        <StatCard label="Вартість / місяць" value={`$${(data?.cost_per_month || 0).toFixed(2)}`} sub="Екстраполяція" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Cost by model trend */}
        <ChartCard title="Cost by Model">
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={byModel}>
              <XAxis dataKey="timestamp" tickFormatter={formatTime} tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v.toFixed(4)}`} />
              <Tooltip {...tooltipStyle} labelFormatter={formatTime} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {modelKeys.map((key, i) => (
                <Area
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stackId="1"
                  stroke={Object.values(COLORS)[i % 10]}
                  fill={Object.values(COLORS)[i % 10]}
                  fillOpacity={0.5}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Top 10 tools horizontal bar */}
        <ChartCard title="Top 10 Tools by Cost (7d)">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={topTools} layout="vertical">
              <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v.toFixed(2)}`} />
              <YAxis type="category" dataKey="tool" tick={{ fontSize: 10 }} width={150} />
              <Tooltip {...tooltipStyle} formatter={(v: number) => `$${v.toFixed(4)}`} />
              <Bar dataKey="cost" fill={COLORS.blue} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}

// ── Section: Infrastructure ────────────────────────────

function InfrastructureSection({ data }: { data: any }) {
  const cpuSeries = data?.cpu?.series || [];
  const memPct = data?.memory?.used_pct || 0;
  const memTotal = data?.memory?.total_bytes || 0;
  const memAvailable = data?.memory?.available_bytes || 0;
  const diskSeries = data?.disk_io?.series || [];
  const networkSeries = data?.network?.series || [];
  const pgConn = data?.pg?.connections?.series || [];
  const pgTx = data?.pg?.transactions?.series || [];
  const pgCacheHit = data?.pg?.cache_hit_ratio || 0;
  const redisMem = data?.redis?.memory?.series || [];
  const redisClients = data?.redis?.clients?.series || [];
  const redisCommands = data?.redis?.commands_rate?.series || [];

  return (
    <div className="space-y-4">
      {/* Gauge row: CPU + Memory + PG Cache */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <GaugeBar
          label="CPU Usage"
          pct={cpuSeries.length > 0 ? (cpuSeries[cpuSeries.length - 1].user + cpuSeries[cpuSeries.length - 1].system) * 100 : 0}
          detail={cpuSeries.length > 0 ? `user: ${(cpuSeries[cpuSeries.length - 1].user * 100).toFixed(1)}%, sys: ${(cpuSeries[cpuSeries.length - 1].system * 100).toFixed(1)}%` : 'No data'}
        />
        <GaugeBar
          label="Memory"
          pct={memPct}
          detail={`${formatBytes(memTotal - memAvailable)} / ${formatBytes(memTotal)}`}
        />
        <GaugeBar
          label="PG Cache Hit"
          pct={pgCacheHit * 100}
          detail={`${(pgCacheHit * 100).toFixed(2)}% hit ratio`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* CPU time series */}
        <ChartCard title="CPU Usage">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={cpuSeries}>
              <XAxis dataKey="timestamp" tickFormatter={formatTime} tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} />
              <Tooltip {...tooltipStyle} labelFormatter={formatTime} formatter={(v: number) => `${(v * 100).toFixed(1)}%`} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="user" stackId="1" stroke={COLORS.blue} fill={COLORS.blue} fillOpacity={0.5} name="User" />
              <Area type="monotone" dataKey="system" stackId="1" stroke={COLORS.amber} fill={COLORS.amber} fillOpacity={0.5} name="System" />
              <Area type="monotone" dataKey="iowait" stackId="1" stroke={COLORS.red} fill={COLORS.red} fillOpacity={0.5} name="IO Wait" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* PG connections */}
        <ChartCard title="PostgreSQL Connections">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={pgConn}>
              <XAxis dataKey="timestamp" tickFormatter={formatTime} tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip {...tooltipStyle} labelFormatter={formatTime} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="active" stackId="1" stroke={COLORS.blue} fill={COLORS.blue} fillOpacity={0.5} name="Active" />
              <Area type="monotone" dataKey="idle" stackId="1" stroke={COLORS.emerald} fill={COLORS.emerald} fillOpacity={0.5} name="Idle" />
              <Area type="monotone" dataKey="idle_in_tx" stackId="1" stroke={COLORS.amber} fill={COLORS.amber} fillOpacity={0.5} name="Idle in TX" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* PG transactions */}
        <ChartCard title="PostgreSQL Transactions (rate/s)">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={pgTx}>
              <XAxis dataKey="timestamp" tickFormatter={formatTime} tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip {...tooltipStyle} labelFormatter={formatTime} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="commits" stroke={COLORS.emerald} dot={false} strokeWidth={1.5} name="Commits" />
              <Line type="monotone" dataKey="rollbacks" stroke={COLORS.red} dot={false} strokeWidth={1.5} name="Rollbacks" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Redis memory */}
        <ChartCard title="Redis Memory">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={redisMem}>
              <XAxis dataKey="timestamp" tickFormatter={formatTime} tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatBytes(v)} />
              <Tooltip {...tooltipStyle} labelFormatter={formatTime} formatter={(v: number) => formatBytes(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="used" stroke={COLORS.blue} fill={COLORS.blue} fillOpacity={0.3} name="Used" />
              <Area type="monotone" dataKey="max" stroke={COLORS.slate} fill="none" strokeDasharray="5 5" name="Max" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Redis commands + clients */}
        <ChartCard title="Redis Commands Rate (/s)">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={redisCommands}>
              <XAxis dataKey="timestamp" tickFormatter={formatTime} tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip {...tooltipStyle} labelFormatter={formatTime} />
              <Line type="monotone" dataKey="value" stroke={COLORS.indigo} dot={false} strokeWidth={1.5} name="Commands/s" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Disk I/O */}
        <ChartCard title="Disk I/O (bytes/s)">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={diskSeries}>
              <XAxis dataKey="timestamp" tickFormatter={formatTime} tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatBytes(v)} />
              <Tooltip {...tooltipStyle} labelFormatter={formatTime} formatter={(v: number) => formatBytes(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="read_bytes" stroke={COLORS.blue} dot={false} strokeWidth={1.5} name="Read" />
              <Line type="monotone" dataKey="write_bytes" stroke={COLORS.orange} dot={false} strokeWidth={1.5} name="Write" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Network */}
        <ChartCard title="Network (bytes/s)">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={networkSeries}>
              <XAxis dataKey="timestamp" tickFormatter={formatTime} tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatBytes(v)} />
              <Tooltip {...tooltipStyle} labelFormatter={formatTime} formatter={(v: number) => formatBytes(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="rx_bytes" stroke={COLORS.emerald} dot={false} strokeWidth={1.5} name="Receive" />
              <Line type="monotone" dataKey="tx_bytes" stroke={COLORS.purple} dot={false} strokeWidth={1.5} name="Transmit" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Redis clients + evicted */}
        <ChartCard title="Redis Clients & Evictions">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={redisClients}>
              <XAxis dataKey="timestamp" tickFormatter={formatTime} tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip {...tooltipStyle} labelFormatter={formatTime} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="value" stroke={COLORS.cyan} dot={false} strokeWidth={1.5} name="Clients" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
