/**
 * Admin Containers Page
 * Per-container CPU, memory, and network metrics from cAdvisor
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Cpu,
  HardDrive,
  Activity,
  Wifi,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { api } from '../utils/api-client';

// ── Types ──────────────────────────────────────────────

type TimeRange = '1h' | '6h' | '24h';

interface ContainerSnapshot {
  name: string;
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  networkRxBytesPerSec: number;
  networkTxBytesPerSec: number;
}

interface ContainerMetrics {
  containers: ContainerSnapshot[];
  cpuHistory: Record<string, { timestamp: number; value: number }[]>;
  memoryHistory: Record<string, { timestamp: number; value: number }[]>;
  range: string;
}

// ── Formatters ─────────────────────────────────────────

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

function formatBytesPerSec(bytes: number): string {
  if (bytes < 1024) return `${bytes} B/s`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB/s`;
}

// ── Colors ─────────────────────────────────────────────

const COLORS = [
  '#60a5fa', '#34d399', '#fbbf24', '#f87171', '#a78bfa',
  '#818cf8', '#22d3ee', '#f472b6', '#94a3b8', '#fb923c',
  '#4ade80', '#e879f9', '#38bdf8', '#facc15', '#fb7185',
];

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
        <span className="text-base font-medium text-claude-text">{title}</span>
      </div>
      {open ? <ChevronUp size={16} className="text-claude-subtext" /> : <ChevronDown size={16} className="text-claude-subtext" />}
    </button>
  );
}

// ── Container Card ─────────────────────────────────────

function ContainerCard({ c }: { c: ContainerSnapshot }) {
  const memBarColor = c.memoryPercent > 80 ? 'bg-red-400' : c.memoryPercent > 60 ? 'bg-amber-400' : 'bg-emerald-400';
  const cpuBarColor = c.cpuPercent > 80 ? 'bg-red-400' : c.cpuPercent > 50 ? 'bg-amber-400' : 'bg-blue-400';

  return (
    <div className="bg-white rounded-xl border border-claude-border p-4 shadow-sm">
      <div className="text-sm font-medium text-claude-text mb-3 truncate" title={c.name}>{c.name}</div>

      {/* CPU */}
      <div className="mb-3">
        <div className="flex justify-between items-center mb-1">
          <span className="text-xs text-claude-subtext">CPU</span>
          <span className="text-xs font-semibold text-claude-text">{formatPct(c.cpuPercent)}</span>
        </div>
        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div className={`h-full ${cpuBarColor} rounded-full transition-all`} style={{ width: `${Math.min(c.cpuPercent, 100)}%` }} />
        </div>
      </div>

      {/* Memory */}
      <div className="mb-3">
        <div className="flex justify-between items-center mb-1">
          <span className="text-xs text-claude-subtext">Memory</span>
          <span className="text-xs font-semibold text-claude-text">
            {c.memoryLimitBytes > 0 ? `${formatBytes(c.memoryBytes)} / ${formatBytes(c.memoryLimitBytes)}` : formatBytes(c.memoryBytes)}
          </span>
        </div>
        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div className={`h-full ${memBarColor} rounded-full transition-all`} style={{ width: `${Math.min(c.memoryPercent, 100)}%` }} />
        </div>
      </div>

      {/* Network */}
      <div className="flex justify-between text-xs text-claude-subtext">
        <span>RX: {formatBytesPerSec(c.networkRxBytesPerSec)}</span>
        <span>TX: {formatBytesPerSec(c.networkTxBytesPerSec)}</span>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────

export function AdminContainersPage() {
  const [data, setData] = useState<ContainerMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<TimeRange>('1h');
  const [autoRefresh, setAutoRefresh] = useState(true);

  const [overviewOpen, setOverviewOpen] = useState(true);
  const [cpuOpen, setCpuOpen] = useState(true);
  const [memoryOpen, setMemoryOpen] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await api.admin.getContainerMetrics(range);
      setData(res.data);
      setError(null);
    } catch (e: any) {
      setError(e.message || 'Failed to load container metrics');
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchData]);

  // Prepare stacked chart data
  const containerNames = data ? Object.keys(data.cpuHistory) : [];

  const cpuChartData = (() => {
    if (!data || containerNames.length === 0) return [];
    const firstSeries = data.cpuHistory[containerNames[0]] || [];
    return firstSeries.map((point, i) => {
      const entry: any = { timestamp: point.timestamp };
      for (const name of containerNames) {
        entry[name] = data.cpuHistory[name]?.[i]?.value || 0;
      }
      return entry;
    });
  })();

  const memChartData = (() => {
    if (!data || containerNames.length === 0) return [];
    const memNames = Object.keys(data.memoryHistory);
    if (memNames.length === 0) return [];
    const firstSeries = data.memoryHistory[memNames[0]] || [];
    return firstSeries.map((point, i) => {
      const entry: any = { timestamp: point.timestamp };
      for (const name of memNames) {
        entry[name] = (data.memoryHistory[name]?.[i]?.value || 0) / (1024 * 1024); // MB
      }
      return entry;
    });
  })();

  const memNames = data ? Object.keys(data.memoryHistory) : [];

  return (
    <div className="flex-1 overflow-y-auto bg-claude-bg">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h2 className="text-xl font-semibold text-claude-text">Контейнери</h2>
          <div className="flex items-center gap-2">
            {/* Time range */}
            {(['1h', '6h', '24h'] as TimeRange[]).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3 py-1.5 text-xs rounded-lg transition ${
                  range === r
                    ? 'bg-claude-text text-white'
                    : 'bg-white border border-claude-border text-claude-subtext hover:text-claude-text'
                }`}
              >
                {r}
              </button>
            ))}
            {/* Auto-refresh toggle */}
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition ${
                autoRefresh
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                  : 'bg-white border-claude-border text-claude-subtext'
              }`}
            >
              <RefreshCw size={12} className={autoRefresh ? 'animate-spin' : ''} />
              {autoRefresh ? 'Auto' : 'Paused'}
            </button>
            {/* Manual refresh */}
            <button
              onClick={() => { setLoading(true); fetchData(); }}
              className="p-1.5 rounded-lg border border-claude-border text-claude-subtext hover:text-claude-text bg-white transition"
            >
              <RefreshCw size={14} />
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && !data && (
          <div className="flex items-center justify-center py-20">
            <RefreshCw size={24} className="animate-spin text-claude-subtext" />
          </div>
        )}

        {data && (
          <>
            {/* Section 1: Overview Cards */}
            <SectionHeader title="Огляд контейнерів" icon={Activity} open={overviewOpen} onToggle={() => setOverviewOpen(!overviewOpen)} />
            {overviewOpen && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {data.containers
                  .sort((a, b) => b.cpuPercent - a.cpuPercent)
                  .map((c) => (
                    <ContainerCard key={c.name} c={c} />
                  ))}
                {data.containers.length === 0 && (
                  <div className="col-span-full text-center text-claude-subtext py-8">
                    No container metrics available. Make sure cAdvisor is running.
                  </div>
                )}
              </div>
            )}

            {/* Section 2: CPU Chart */}
            <SectionHeader title="CPU (%) по контейнерах" icon={Cpu} open={cpuOpen} onToggle={() => setCpuOpen(!cpuOpen)} />
            {cpuOpen && cpuChartData.length > 0 && (
              <ChartCard title="CPU Usage per Container">
                <ResponsiveContainer width="100%" height={350}>
                  <AreaChart data={cpuChartData}>
                    <XAxis dataKey="timestamp" tickFormatter={formatTime} tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={(v: number) => `${v.toFixed(0)}%`} tick={{ fontSize: 11 }} />
                    <Tooltip
                      {...tooltipStyle}
                      labelFormatter={formatTime}
                      formatter={(value: number, name: string) => [`${value.toFixed(2)}%`, name]}
                    />
                    <Legend wrapperStyle={{ fontSize: '11px' }} />
                    {containerNames.map((name, i) => (
                      <Area
                        key={name}
                        type="monotone"
                        dataKey={name}
                        stackId="cpu"
                        stroke={COLORS[i % COLORS.length]}
                        fill={COLORS[i % COLORS.length]}
                        fillOpacity={0.4}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>
            )}

            {/* Section 3: Memory Chart */}
            <SectionHeader title="Memory (MB) по контейнерах" icon={HardDrive} open={memoryOpen} onToggle={() => setMemoryOpen(!memoryOpen)} />
            {memoryOpen && memChartData.length > 0 && (
              <ChartCard title="Memory Usage per Container">
                <ResponsiveContainer width="100%" height={350}>
                  <AreaChart data={memChartData}>
                    <XAxis dataKey="timestamp" tickFormatter={formatTime} tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={(v: number) => `${v.toFixed(0)} MB`} tick={{ fontSize: 11 }} />
                    <Tooltip
                      {...tooltipStyle}
                      labelFormatter={formatTime}
                      formatter={(value: number, name: string) => [`${value.toFixed(1)} MB`, name]}
                    />
                    <Legend wrapperStyle={{ fontSize: '11px' }} />
                    {memNames.map((name, i) => (
                      <Area
                        key={name}
                        type="monotone"
                        dataKey={name}
                        stackId="mem"
                        stroke={COLORS[i % COLORS.length]}
                        fill={COLORS[i % COLORS.length]}
                        fillOpacity={0.4}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>
            )}
          </>
        )}
      </div>
    </div>
  );
}
