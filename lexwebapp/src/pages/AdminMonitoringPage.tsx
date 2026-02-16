/**
 * Admin Monitoring Page
 * Dashboard showing volume, source, and update frequency of all data sources
 */

import React, { useEffect, useState } from 'react';
import {
  Activity,
  Database,
  RefreshCw,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Server,
  HardDrive,
  ExternalLink,
  Clock,
  Layers,
} from 'lucide-react';
import { api } from '../utils/api-client';

interface TableInfo {
  id: string;
  name: string;
  rows: number;
  source: string;
  sourceUrl: string;
  updateFrequency: string;
  lastUpdate: string | null;
}

interface ServiceStats {
  service: string;
  tables: Record<string, TableInfo>;
  dbSizeMb: number;
  registryMeta?: any[];
  recentImports?: any[];
  timestamp: string;
}

interface DataSourcesResponse {
  backend: {
    tables: TableInfo[];
    dbSizeMb: number;
  };
  rada: ServiceStats | null;
  openreyestr: ServiceStats | null;
  timestamp: string;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return '0';
  return n.toLocaleString('uk-UA');
}

function ServiceStatusBadge({ available }: { available: boolean }) {
  return available ? (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium text-green-600 bg-green-50">
      <CheckCircle size={12} />
      Онлайн
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium text-red-600 bg-red-50">
      <XCircle size={12} />
      Недоступний
    </span>
  );
}

function DataTable({ tables, title }: { tables: TableInfo[]; title?: string }) {
  const totalRows = tables.reduce((s, t) => s + t.rows, 0);

  return (
    <div className="bg-white rounded-xl border border-claude-border shadow-sm overflow-hidden">
      {title && (
        <div className="px-4 py-3 border-b border-claude-border/50 bg-gray-50/50 flex items-center justify-between">
          <span className="text-sm font-medium text-claude-text">{title}</span>
          <span className="text-xs text-claude-subtext">{formatNumber(totalRows)} записів</span>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-claude-border bg-gray-50">
              <th className="text-left px-4 py-2.5 font-medium text-claude-subtext text-xs">Таблиця</th>
              <th className="text-right px-4 py-2.5 font-medium text-claude-subtext text-xs">Записів</th>
              <th className="text-left px-4 py-2.5 font-medium text-claude-subtext text-xs">Джерело</th>
              <th className="text-left px-4 py-2.5 font-medium text-claude-subtext text-xs">Частота оновлення</th>
              <th className="text-left px-4 py-2.5 font-medium text-claude-subtext text-xs">Останнє оновлення</th>
            </tr>
          </thead>
          <tbody>
            {tables.map((t) => (
              <tr key={t.id} className="border-b border-claude-border/30 hover:bg-gray-50/50">
                <td className="px-4 py-2.5">
                  <div className="font-medium text-claude-text text-xs">{t.name}</div>
                  <div className="text-[10px] text-claude-subtext font-mono">{t.id}</div>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span className={`font-mono text-xs font-medium ${t.rows > 0 ? 'text-claude-text' : 'text-claude-subtext'}`}>
                    {formatNumber(t.rows)}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-claude-text">{t.source}</span>
                    {t.sourceUrl && (
                      <a
                        href={t.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-500 hover:text-blue-700"
                      >
                        <ExternalLink size={10} />
                      </a>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <Clock size={11} className="text-claude-subtext flex-shrink-0" />
                    <span className="text-xs text-claude-subtext">{t.updateFrequency}</span>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-xs text-claude-subtext">{formatDate(t.lastUpdate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AdminMonitoringPage() {
  const [data, setData] = useState<DataSourcesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.admin.getDataSources();
      setData(response.data);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to fetch data sources');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (loading && !data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <RefreshCw size={32} className="text-claude-subtext animate-spin" />
          <p className="text-claude-subtext">Завантаження даних...</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center">
          <XCircle size={32} className="text-red-500" />
          <p className="text-red-600">{error}</p>
          <button onClick={fetchData} className="px-4 py-2 bg-claude-text text-white rounded-lg text-sm">
            Повторити
          </button>
        </div>
      </div>
    );
  }

  // Convert rada/openreyestr table records to TableInfo[]
  const radaTables: TableInfo[] = data?.rada?.tables
    ? Object.entries(data.rada.tables).map(([id, t]: [string, any]) => ({
        id,
        name: t.source?.split('—')[1]?.trim() || id,
        rows: t.rows || 0,
        source: t.source || '',
        sourceUrl: t.sourceUrl || '',
        updateFrequency: t.updateFrequency || '',
        lastUpdate: t.lastUpdate || null,
      }))
    : [];

  const openreyestrTables: TableInfo[] = data?.openreyestr?.tables
    ? Object.entries(data.openreyestr.tables).map(([id, t]: [string, any]) => ({
        id,
        name: t.source?.split('—')[1]?.trim() || id,
        rows: t.rows || 0,
        source: t.source || '',
        sourceUrl: t.sourceUrl || '',
        updateFrequency: t.updateFrequency || '',
        lastUpdate: t.lastUpdate || null,
      }))
    : [];

  const backendTotalRows = data?.backend?.tables?.reduce((s, t) => s + t.rows, 0) || 0;
  const radaTotalRows = radaTables.reduce((s, t) => s + t.rows, 0);
  const openreyestrTotalRows = openreyestrTables.reduce((s, t) => s + t.rows, 0);
  const totalRows = backendTotalRows + radaTotalRows + openreyestrTotalRows;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-claude-text font-sans">Моніторинг джерел даних</h1>
          <p className="text-sm text-claude-subtext mt-1">
            Оновлено: {data?.timestamp ? formatDate(data.timestamp) : '—'}
          </p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-claude-border rounded-lg text-sm text-claude-text hover:bg-claude-bg transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Оновити
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <SummaryCard
          icon={Layers}
          label="Всього записів"
          value={formatNumber(totalRows)}
          sub={`${(data?.backend?.tables?.length || 0) + radaTables.length + openreyestrTables.length} таблиць`}
        />
        <SummaryCard
          icon={HardDrive}
          label="Backend DB"
          value={`${data?.backend?.dbSizeMb || 0} MB`}
          sub={`${formatNumber(backendTotalRows)} записів`}
          status="online"
        />
        <SummaryCard
          icon={Server}
          label="RADA DB"
          value={data?.rada ? `${data.rada.dbSizeMb || 0} MB` : '—'}
          sub={data?.rada ? `${formatNumber(radaTotalRows)} записів` : 'Недоступний'}
          status={data?.rada ? 'online' : 'offline'}
        />
        <SummaryCard
          icon={Database}
          label="OpenReyestr DB"
          value={data?.openreyestr ? `${data.openreyestr.dbSizeMb || 0} MB` : '—'}
          sub={data?.openreyestr ? `${formatNumber(openreyestrTotalRows)} записів` : 'Недоступний'}
          status={data?.openreyestr ? 'online' : 'offline'}
        />
      </div>

      {/* Backend Sources */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Activity size={18} className="text-claude-subtext" />
            <h2 className="text-lg font-semibold text-claude-text font-sans">Backend (mcp_backend)</h2>
            <ServiceStatusBadge available={true} />
          </div>
          <span className="text-xs text-claude-subtext bg-claude-bg px-2 py-1 rounded-full">
            PostgreSQL :5432 · {data?.backend?.dbSizeMb || 0} MB
          </span>
        </div>
        {data?.backend?.tables && data.backend.tables.length > 0 && (
          <DataTable tables={data.backend.tables} />
        )}
      </section>

      {/* RADA Sources */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Server size={18} className="text-claude-subtext" />
            <h2 className="text-lg font-semibold text-claude-text font-sans">RADA Server (mcp_rada)</h2>
            <ServiceStatusBadge available={!!data?.rada} />
          </div>
          {data?.rada && (
            <span className="text-xs text-claude-subtext bg-claude-bg px-2 py-1 rounded-full">
              PostgreSQL :5433 · {data.rada.dbSizeMb} MB
            </span>
          )}
        </div>
        {radaTables.length > 0 ? (
          <DataTable tables={radaTables} />
        ) : (
          <div className="bg-white rounded-xl border border-claude-border p-8 text-center">
            <AlertTriangle size={24} className="mx-auto mb-2 text-yellow-500" />
            <p className="text-sm text-claude-subtext">RADA сервер недоступний або не повертає статистику</p>
          </div>
        )}
      </section>

      {/* OpenReyestr Sources */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Database size={18} className="text-claude-subtext" />
            <h2 className="text-lg font-semibold text-claude-text font-sans">OpenReyestr Server (mcp_openreyestr)</h2>
            <ServiceStatusBadge available={!!data?.openreyestr} />
          </div>
          {data?.openreyestr && (
            <span className="text-xs text-claude-subtext bg-claude-bg px-2 py-1 rounded-full">
              PostgreSQL :5435 · {data.openreyestr.dbSizeMb} MB
            </span>
          )}
        </div>
        {openreyestrTables.length > 0 ? (
          <DataTable tables={openreyestrTables} />
        ) : (
          <div className="bg-white rounded-xl border border-claude-border p-8 text-center">
            <AlertTriangle size={24} className="mx-auto mb-2 text-yellow-500" />
            <p className="text-sm text-claude-subtext">OpenReyestr сервер недоступний або не повертає статистику</p>
          </div>
        )}
      </section>

      {/* Recent Imports (OpenReyestr) */}
      {data?.openreyestr?.recentImports && data.openreyestr.recentImports.length > 0 && (
        <section className="mb-8">
          <div className="flex items-center gap-2 mb-4">
            <Clock size={18} className="text-claude-subtext" />
            <h2 className="text-lg font-semibold text-claude-text font-sans">Останні імпорти (OpenReyestr)</h2>
          </div>
          <div className="bg-white rounded-xl border border-claude-border shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-claude-border bg-gray-50">
                    <th className="text-left px-4 py-2.5 font-medium text-claude-subtext text-xs">Реєстр</th>
                    <th className="text-left px-4 py-2.5 font-medium text-claude-subtext text-xs">Статус</th>
                    <th className="text-right px-4 py-2.5 font-medium text-claude-subtext text-xs">Імпортовано</th>
                    <th className="text-right px-4 py-2.5 font-medium text-claude-subtext text-xs">Помилок</th>
                    <th className="text-left px-4 py-2.5 font-medium text-claude-subtext text-xs">Завершено</th>
                  </tr>
                </thead>
                <tbody>
                  {data.openreyestr.recentImports.map((imp: any, i: number) => (
                    <tr key={i} className="border-b border-claude-border/30 hover:bg-gray-50/50">
                      <td className="px-4 py-2.5 text-xs font-medium text-claude-text">{imp.registry_name}</td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${
                          imp.status === 'completed' ? 'bg-green-50 text-green-700' :
                          imp.status === 'failed' ? 'bg-red-50 text-red-700' :
                          'bg-yellow-50 text-yellow-700'
                        }`}>
                          {imp.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs font-mono">{formatNumber(imp.records_imported)}</td>
                      <td className="px-4 py-2.5 text-right text-xs font-mono">
                        <span className={imp.records_failed > 0 ? 'text-red-600' : ''}>{formatNumber(imp.records_failed)}</span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-claude-subtext">{formatDate(imp.import_completed_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  sub,
  status,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub: string;
  status?: 'online' | 'offline';
}) {
  return (
    <div className="bg-white rounded-xl border border-claude-border p-4 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <div className="p-2 bg-claude-bg rounded-lg">
          <Icon size={16} className="text-claude-text" />
        </div>
        {status && (
          <div className={`w-2 h-2 rounded-full ${status === 'online' ? 'bg-green-500' : 'bg-red-400'}`} />
        )}
      </div>
      <div className="text-xl font-semibold text-claude-text font-mono">{value}</div>
      <div className="text-xs text-claude-subtext mt-0.5">{label}</div>
      <div className="text-[10px] text-claude-subtext/70 mt-1">{sub}</div>
    </div>
  );
}
