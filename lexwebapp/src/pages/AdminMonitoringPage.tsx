/**
 * Admin Monitoring Page
 * Dashboard showing volume, source, and update frequency of all data sources
 * Loads each section independently for progressive rendering
 */

import React, { useEffect, useState, useCallback } from 'react';
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
  Scale,
  FileText,
  ChevronDown,
  ChevronUp,
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
  lastBatchCount?: number;
}

interface CourtDocInfo {
  id: string;
  title: string;
  date: string | null;
  court: string | null;
  case_number: string | null;
  loaded_at: string;
}

interface CourtCategory {
  code: string;
  name: string;
  total: number;
  recent: number;
  earliest_date: string | null;
  latest_date: string | null;
  last_loaded_at: string | null;
  documents: CourtDocInfo[];
}

interface CourtDocsData {
  total_court_docs: number;
  recent_court_docs: number;
  days: number;
  categories: CourtCategory[];
}

interface SectionState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

interface BackendData {
  tables: TableInfo[];
  dbSizeMb: number;
}

interface ServiceData {
  service: string;
  tables: Record<string, { rows: number; source: string; sourceUrl: string; updateFrequency: string; lastUpdate: string | null; lastBatchCount?: number }>;
  dbSizeMb: number;
  recentImports?: any[];
  error?: string;
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

function SectionLoader() {
  return (
    <div className="bg-white rounded-xl border border-claude-border p-8 flex items-center justify-center">
      <RefreshCw size={18} className="text-claude-subtext animate-spin mr-2" />
      <span className="text-sm text-claude-subtext">Завантаження...</span>
    </div>
  );
}

function SectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="bg-white rounded-xl border border-claude-border p-6 text-center">
      <XCircle size={20} className="mx-auto mb-2 text-red-400" />
      <p className="text-sm text-red-600 mb-3">{message}</p>
      <button onClick={onRetry} className="text-xs px-3 py-1.5 border border-claude-border rounded-lg hover:bg-gray-50 transition-colors">
        Повторити
      </button>
    </div>
  );
}

function DataTable({ tables }: { tables: TableInfo[] }) {
  return (
    <div className="bg-white rounded-xl border border-claude-border shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-claude-border bg-gray-50">
              <th className="text-left px-4 py-2.5 font-medium text-claude-subtext text-xs">Таблиця</th>
              <th className="text-right px-4 py-2.5 font-medium text-claude-subtext text-xs">Записів</th>
              <th className="text-left px-4 py-2.5 font-medium text-claude-subtext text-xs">Джерело</th>
              <th className="text-left px-4 py-2.5 font-medium text-claude-subtext text-xs">Частота оновлення</th>
              <th className="text-left px-4 py-2.5 font-medium text-claude-subtext text-xs">Останнє оновлення</th>
              <th className="text-right px-4 py-2.5 font-medium text-claude-subtext text-xs">Завантажено</th>
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
                      <a href={t.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700">
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
                <td className="px-4 py-2.5 text-right">
                  {t.lastBatchCount != null && t.lastBatchCount > 0 ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 text-blue-700 font-mono">
                      +{formatNumber(t.lastBatchCount)}
                    </span>
                  ) : (
                    <span className="text-xs text-claude-subtext">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function toTableInfoArray(tables: Record<string, any>): TableInfo[] {
  return Object.entries(tables).map(([id, t]) => ({
    id,
    name: t.source?.split('—')[1]?.trim() || id,
    rows: t.rows || 0,
    source: t.source || '',
    sourceUrl: t.sourceUrl || '',
    updateFrequency: t.updateFrequency || '',
    lastUpdate: t.lastUpdate || null,
    lastBatchCount: t.lastBatchCount || 0,
  }));
}

function SummaryCard({
  icon: Icon, label, value, sub, status, loading: isLoading,
}: {
  icon: React.ElementType; label: string; value: string; sub: string;
  status?: 'online' | 'offline' | 'loading'; loading?: boolean;
}) {
  return (
    <div className="bg-white rounded-xl border border-claude-border p-4 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <div className="p-2 bg-claude-bg rounded-lg">
          <Icon size={16} className="text-claude-text" />
        </div>
        {status === 'loading' || isLoading ? (
          <RefreshCw size={10} className="text-claude-subtext animate-spin" />
        ) : status ? (
          <div className={`w-2 h-2 rounded-full ${status === 'online' ? 'bg-green-500' : 'bg-red-400'}`} />
        ) : null}
      </div>
      <div className="text-xl font-semibold text-claude-text font-mono">
        {isLoading ? <span className="text-claude-subtext text-base">...</span> : value}
      </div>
      <div className="text-xs text-claude-subtext mt-0.5">{label}</div>
      <div className="text-[10px] text-claude-subtext/70 mt-1">{sub}</div>
    </div>
  );
}

function CourtDocsCategoryRow({ cat }: { cat: CourtCategory }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr
        className="border-b border-claude-border/30 hover:bg-gray-50/50 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            {expanded ? <ChevronUp size={12} className="text-claude-subtext" /> : <ChevronDown size={12} className="text-claude-subtext" />}
            <span className="font-medium text-xs text-claude-text">{cat.name}</span>
          </div>
          <div className="text-[10px] text-claude-subtext font-mono ml-5">code: {cat.code}</div>
        </td>
        <td className="px-4 py-2.5 text-right">
          <span className="font-mono text-xs font-medium text-claude-text">{formatNumber(cat.total)}</span>
        </td>
        <td className="px-4 py-2.5 text-right">
          {cat.recent > 0 ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-50 text-green-700 font-mono">
              +{formatNumber(cat.recent)}
            </span>
          ) : (
            <span className="text-xs text-claude-subtext">0</span>
          )}
        </td>
        <td className="px-4 py-2.5 text-xs text-claude-subtext">{formatDate(cat.last_loaded_at)}</td>
        <td className="px-4 py-2.5 text-xs text-claude-subtext">{formatDate(cat.latest_date)}</td>
      </tr>
      {expanded && cat.documents.length > 0 && cat.documents.map((doc) => (
        <tr key={doc.id} className="bg-gray-50/70 border-b border-claude-border/20">
          <td className="px-4 py-2 pl-10" colSpan={2}>
            <div className="text-xs text-claude-text truncate max-w-md" title={doc.title}>{doc.title}</div>
            <div className="text-[10px] text-claude-subtext">
              {doc.court && <span>{doc.court}</span>}
              {doc.case_number && <span className="ml-2 font-mono">{doc.case_number}</span>}
            </div>
          </td>
          <td className="px-4 py-2 text-xs text-claude-subtext">{formatDate(doc.date)}</td>
          <td className="px-4 py-2 text-xs text-claude-subtext" colSpan={2}>{formatDate(doc.loaded_at)}</td>
        </tr>
      ))}
      {expanded && cat.documents.length === 0 && (
        <tr className="bg-gray-50/70 border-b border-claude-border/20">
          <td className="px-4 py-2 pl-10 text-xs text-claude-subtext italic" colSpan={5}>
            Немає нових документів за обраний період
          </td>
        </tr>
      )}
    </>
  );
}

function CourtDocsSection({
  state,
  onRetry,
}: {
  state: SectionState<CourtDocsData>;
  onRetry: () => void;
}) {
  if (state.loading) return <SectionLoader />;
  if (state.error) return <SectionError message={state.error} onRetry={onRetry} />;
  if (!state.data) return null;

  const { data } = state;

  return (
    <div>
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
        <div className="bg-white rounded-lg border border-claude-border p-3">
          <div className="text-lg font-semibold text-claude-text font-mono">{formatNumber(data.total_court_docs)}</div>
          <div className="text-[10px] text-claude-subtext">Всього судових рішень</div>
        </div>
        <div className="bg-white rounded-lg border border-claude-border p-3">
          <div className="text-lg font-semibold text-green-700 font-mono">+{formatNumber(data.recent_court_docs)}</div>
          <div className="text-[10px] text-claude-subtext">За останні {data.days} днів</div>
        </div>
        <div className="bg-white rounded-lg border border-claude-border p-3">
          <div className="text-lg font-semibold text-claude-text font-mono">{data.categories.length}</div>
          <div className="text-[10px] text-claude-subtext">Видів права</div>
        </div>
      </div>

      {/* Categories table */}
      {data.categories.length > 0 ? (
        <div className="bg-white rounded-xl border border-claude-border shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-claude-border bg-gray-50">
                  <th className="text-left px-4 py-2.5 font-medium text-claude-subtext text-xs">Вид права</th>
                  <th className="text-right px-4 py-2.5 font-medium text-claude-subtext text-xs">Всього</th>
                  <th className="text-right px-4 py-2.5 font-medium text-claude-subtext text-xs">Нових</th>
                  <th className="text-left px-4 py-2.5 font-medium text-claude-subtext text-xs">Завантажено</th>
                  <th className="text-left px-4 py-2.5 font-medium text-claude-subtext text-xs">Дата рішення</th>
                </tr>
              </thead>
              <tbody>
                {data.categories.map((cat) => (
                  <CourtDocsCategoryRow key={cat.code} cat={cat} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-claude-border p-8 text-center">
          <FileText size={24} className="mx-auto mb-2 text-claude-subtext" />
          <p className="text-sm text-claude-subtext">Судові документи ще не завантажені</p>
        </div>
      )}
    </div>
  );
}

export function AdminMonitoringPage() {
  const [backend, setBackend] = useState<SectionState<BackendData>>({ data: null, loading: true, error: null });
  const [rada, setRada] = useState<SectionState<ServiceData>>({ data: null, loading: true, error: null });
  const [openreyestr, setOpenreyestr] = useState<SectionState<ServiceData>>({ data: null, loading: true, error: null });
  const [courtDocs, setCourtDocs] = useState<SectionState<CourtDocsData>>({ data: null, loading: true, error: null });
  const [courtDocsDays, setCourtDocsDays] = useState(30);

  const fetchBackend = useCallback(async () => {
    setBackend(prev => ({ ...prev, loading: true, error: null }));
    try {
      const res = await api.admin.getDataSources('backend');
      setBackend({ data: res.data, loading: false, error: null });
    } catch (err: any) {
      setBackend(prev => ({ ...prev, loading: false, error: err.response?.data?.error || err.message }));
    }
  }, []);

  const fetchRada = useCallback(async () => {
    setRada(prev => ({ ...prev, loading: true, error: null }));
    try {
      const res = await api.admin.getDataSources('rada');
      const d = res.data;
      if (d.error && Object.keys(d.tables || {}).length === 0) {
        setRada({ data: null, loading: false, error: d.error });
      } else {
        setRada({ data: d, loading: false, error: null });
      }
    } catch (err: any) {
      setRada(prev => ({ ...prev, loading: false, error: err.response?.data?.error || err.message }));
    }
  }, []);

  const fetchOpenreyestr = useCallback(async () => {
    setOpenreyestr(prev => ({ ...prev, loading: true, error: null }));
    try {
      const res = await api.admin.getDataSources('openreyestr');
      const d = res.data;
      if (d.error && Object.keys(d.tables || {}).length === 0) {
        setOpenreyestr({ data: null, loading: false, error: d.error });
      } else {
        setOpenreyestr({ data: d, loading: false, error: null });
      }
    } catch (err: any) {
      setOpenreyestr(prev => ({ ...prev, loading: false, error: err.response?.data?.error || err.message }));
    }
  }, []);

  const fetchCourtDocs = useCallback(async (days?: number) => {
    const d = days ?? courtDocsDays;
    setCourtDocs(prev => ({ ...prev, loading: true, error: null }));
    try {
      const res = await api.admin.getRecentCourtDocs(d, 5);
      setCourtDocs({ data: res.data, loading: false, error: null });
    } catch (err: any) {
      setCourtDocs(prev => ({ ...prev, loading: false, error: err.response?.data?.error || err.message }));
    }
  }, [courtDocsDays]);

  const fetchAll = useCallback(() => {
    fetchBackend();
    fetchRada();
    fetchOpenreyestr();
    fetchCourtDocs();
  }, [fetchBackend, fetchRada, fetchOpenreyestr, fetchCourtDocs]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const anyLoading = backend.loading || rada.loading || openreyestr.loading;

  const backendRows = backend.data?.tables?.reduce((s, t) => s + t.rows, 0) || 0;
  const radaTables = rada.data ? toTableInfoArray(rada.data.tables) : [];
  const radaRows = radaTables.reduce((s, t) => s + t.rows, 0);
  const orTables = openreyestr.data ? toTableInfoArray(openreyestr.data.tables) : [];
  const orRows = orTables.reduce((s, t) => s + t.rows, 0);
  const totalRows = backendRows + radaRows + orRows;
  const totalTables = (backend.data?.tables?.length || 0) + radaTables.length + orTables.length;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-claude-text font-sans">Моніторинг джерел даних</h1>
        </div>
        <button
          onClick={fetchAll}
          disabled={anyLoading}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-claude-border rounded-lg text-sm text-claude-text hover:bg-claude-bg transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={anyLoading ? 'animate-spin' : ''} />
          Оновити
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <SummaryCard
          icon={Layers}
          label="Всього записів"
          value={formatNumber(totalRows)}
          sub={`${totalTables} таблиць`}
          loading={anyLoading && totalRows === 0}
        />
        <SummaryCard
          icon={HardDrive}
          label="Backend DB"
          value={`${backend.data?.dbSizeMb || 0} MB`}
          sub={`${formatNumber(backendRows)} записів`}
          status={backend.loading ? 'loading' : 'online'}
        />
        <SummaryCard
          icon={Server}
          label="RADA DB"
          value={rada.data ? `${rada.data.dbSizeMb || 0} MB` : '—'}
          sub={rada.loading ? 'Завантаження...' : rada.data ? `${formatNumber(radaRows)} записів` : 'Недоступний'}
          status={rada.loading ? 'loading' : rada.data ? 'online' : 'offline'}
        />
        <SummaryCard
          icon={Database}
          label="OpenReyestr DB"
          value={openreyestr.data ? `${openreyestr.data.dbSizeMb || 0} MB` : '—'}
          sub={openreyestr.loading ? 'Завантаження...' : openreyestr.data ? `${formatNumber(orRows)} записів` : 'Недоступний'}
          status={openreyestr.loading ? 'loading' : openreyestr.data ? 'online' : 'offline'}
        />
      </div>

      {/* Backend Sources */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Activity size={18} className="text-claude-subtext" />
            <h2 className="text-lg font-semibold text-claude-text font-sans">Backend (mcp_backend)</h2>
            {!backend.loading && <ServiceStatusBadge available={!backend.error} />}
          </div>
          {backend.data && (
            <span className="text-xs text-claude-subtext bg-claude-bg px-2 py-1 rounded-full">
              PostgreSQL :5432 · {backend.data.dbSizeMb} MB
            </span>
          )}
        </div>
        {backend.loading ? (
          <SectionLoader />
        ) : backend.error ? (
          <SectionError message={backend.error} onRetry={fetchBackend} />
        ) : backend.data ? (
          <DataTable tables={backend.data.tables} />
        ) : null}
      </section>

      {/* Court Documents by Practice Area */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Scale size={18} className="text-claude-subtext" />
            <h2 className="text-lg font-semibold text-claude-text font-sans">Судові рішення за видами права</h2>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={courtDocsDays}
              onChange={(e) => {
                const d = Number(e.target.value);
                setCourtDocsDays(d);
                fetchCourtDocs(d);
              }}
              className="text-xs border border-claude-border rounded-lg px-2 py-1.5 bg-white text-claude-text"
            >
              <option value={7}>7 днів</option>
              <option value={30}>30 днів</option>
              <option value={90}>90 днів</option>
              <option value={365}>1 рік</option>
            </select>
          </div>
        </div>
        <CourtDocsSection state={courtDocs} onRetry={() => fetchCourtDocs()} />
      </section>

      {/* RADA Sources */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Server size={18} className="text-claude-subtext" />
            <h2 className="text-lg font-semibold text-claude-text font-sans">RADA Server (mcp_rada)</h2>
            {!rada.loading && <ServiceStatusBadge available={!!rada.data} />}
          </div>
          {rada.data && (
            <span className="text-xs text-claude-subtext bg-claude-bg px-2 py-1 rounded-full">
              PostgreSQL :5433 · {rada.data.dbSizeMb} MB
            </span>
          )}
        </div>
        {rada.loading ? (
          <SectionLoader />
        ) : rada.error ? (
          <SectionError message={rada.error} onRetry={fetchRada} />
        ) : radaTables.length > 0 ? (
          <DataTable tables={radaTables} />
        ) : (
          <div className="bg-white rounded-xl border border-claude-border p-8 text-center">
            <AlertTriangle size={24} className="mx-auto mb-2 text-yellow-500" />
            <p className="text-sm text-claude-subtext">RADA сервер не повертає статистику</p>
          </div>
        )}
      </section>

      {/* OpenReyestr Sources */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Database size={18} className="text-claude-subtext" />
            <h2 className="text-lg font-semibold text-claude-text font-sans">OpenReyestr Server (mcp_openreyestr)</h2>
            {!openreyestr.loading && <ServiceStatusBadge available={!!openreyestr.data} />}
          </div>
          {openreyestr.data && (
            <span className="text-xs text-claude-subtext bg-claude-bg px-2 py-1 rounded-full">
              PostgreSQL :5435 · {openreyestr.data.dbSizeMb} MB
            </span>
          )}
        </div>
        {openreyestr.loading ? (
          <SectionLoader />
        ) : openreyestr.error ? (
          <SectionError message={openreyestr.error} onRetry={fetchOpenreyestr} />
        ) : orTables.length > 0 ? (
          <DataTable tables={orTables} />
        ) : (
          <div className="bg-white rounded-xl border border-claude-border p-8 text-center">
            <AlertTriangle size={24} className="mx-auto mb-2 text-yellow-500" />
            <p className="text-sm text-claude-subtext">OpenReyestr сервер не повертає статистику</p>
          </div>
        )}
      </section>

      {/* Recent Imports (OpenReyestr) */}
      {openreyestr.data?.recentImports && openreyestr.data.recentImports.length > 0 && (
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
                  {openreyestr.data.recentImports.map((imp: any, i: number) => (
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
