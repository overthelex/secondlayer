/**
 * Admin DB Compare Page
 * Compares local vs stage table row counts for OpenReyestr, RADA, and court registry (main backend).
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, Database, RefreshCw } from 'lucide-react';
import { api } from '../utils/api-client';

interface ServiceStats {
  tables: Record<string, { rows: number; source?: string; updateFrequency?: string; lastUpdate?: string | null }>;
  dbSizeMb?: number;
  timestamp: string;
}

interface EnvData {
  openreyestr: ServiceStats | null;
  rada: ServiceStats | null;
  main: Record<string, number> | null;
  timestamp: string;
}

interface CompareResult {
  local: EnvData;
  stage: EnvData | null;
  timestamp: string;
}

type DiffStatus = 'equal' | 'approx' | 'stage_bigger' | 'missing_local' | 'missing_stage' | 'both_empty';

function getDiffStatus(local: number, stage: number | undefined): DiffStatus {
  if (stage === undefined) return 'missing_stage';
  if (local === 0 && stage === 0) return 'both_empty';
  if (local === 0 && stage > 0) return 'missing_local';
  if (stage === 0 && local > 0) return 'missing_stage';
  if (local === stage) return 'equal';
  const ratio = Math.abs(local - stage) / Math.max(local, stage);
  if (ratio < 0.01) return 'approx'; // < 1% difference
  if (stage > local) return 'stage_bigger';
  return 'approx';
}

function getDiffLabel(local: number, stage: number | undefined): string {
  if (stage === undefined) return '—';
  if (local === 0 && stage === 0) return '—';
  if (local === 0 && stage > 0) return '❗ нет локально';
  if (stage === 0 && local > 0) return '❗ нет на stage';
  if (local === stage) return '=';
  const ratio = Math.abs(local - stage) / Math.max(local, stage);
  if (ratio < 0.01) return '≈';
  if (stage > local * 1.8) return 'stage вдвое больше';
  if (stage > local) return 'stage новее';
  if (local > stage) return 'local новее';
  return '≈';
}

function getDiffColor(status: DiffStatus): string {
  switch (status) {
    case 'equal': return 'text-green-400';
    case 'approx': return 'text-yellow-400/80';
    case 'stage_bigger': return 'text-yellow-400';
    case 'missing_local': return 'text-red-400';
    case 'missing_stage': return 'text-orange-400';
    case 'both_empty': return 'text-claude-subtext/40';
  }
}

function getDiffBg(status: DiffStatus): string {
  switch (status) {
    case 'missing_local': return 'bg-red-500/5';
    case 'missing_stage': return 'bg-orange-500/5';
    case 'stage_bigger': return 'bg-yellow-500/5';
    default: return '';
  }
}

function fmt(n: number | undefined): string {
  if (n === undefined || n < 0) return '—';
  if (n === 0) return '0';
  return n.toLocaleString('uk-UA');
}

interface TableRow {
  key: string;
  label: string;
  local: number;
  stage: number | undefined;
}

function CompareTable({ title, rows, loading }: { title: string; rows: TableRow[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="mb-8">
        <h3 className="text-sm font-semibold text-claude-subtext uppercase tracking-wider mb-3">{title}</h3>
        <div className="animate-pulse rounded-lg border border-white/10 bg-white/5 h-40" />
      </div>
    );
  }

  const nonEmpty = rows.filter(r => !(r.local === 0 && (r.stage === undefined || r.stage === 0)));
  const empty = rows.filter(r => r.local === 0 && (r.stage === undefined || r.stage === 0));

  return (
    <div className="mb-8">
      <h3 className="text-sm font-semibold text-claude-subtext uppercase tracking-wider mb-3">{title}</h3>
      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-white/5">
              <th className="px-4 py-2 text-left font-medium text-claude-subtext">Таблиця</th>
              <th className="px-4 py-2 text-right font-medium text-claude-subtext w-32">Local</th>
              <th className="px-4 py-2 text-right font-medium text-claude-subtext w-32">Stage</th>
              <th className="px-4 py-2 text-left font-medium text-claude-subtext w-48">Різниця</th>
            </tr>
          </thead>
          <tbody>
            {nonEmpty.map((row, i) => {
              const status = getDiffStatus(row.local, row.stage);
              return (
                <tr key={row.key} className={`border-b border-white/5 ${getDiffBg(status)} ${i % 2 === 0 ? '' : 'bg-white/[0.02]'}`}>
                  <td className="px-4 py-2 font-mono text-xs text-claude-text/80">{row.label}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs tabular-nums">{fmt(row.local)}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs tabular-nums text-claude-subtext">
                    {row.stage === undefined ? <span className="text-claude-subtext/30">—</span> : fmt(row.stage)}
                  </td>
                  <td className={`px-4 py-2 text-xs font-medium ${getDiffColor(status)}`}>
                    {getDiffLabel(row.local, row.stage)}
                  </td>
                </tr>
              );
            })}
            {empty.length > 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-1.5 text-xs text-claude-subtext/30 italic">
                  Порожні: {empty.map(r => r.label).join(', ')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const MAIN_TABLE_LABELS: Record<string, string> = {
  documents: 'documents (судові рішення)',
  document_sections: 'document_sections',
  legislation: 'legislation',
  legislation_articles: 'legislation_articles',
  legislation_chunks: 'legislation_chunks',
  users: 'users',
  conversations: 'conversations',
  upload_sessions: 'upload_sessions',
  zo_dictionaries: 'zo_dictionaries',
};

export function AdminDBComparePage() {
  const [data, setData] = useState<CompareResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.admin.getDBCompare();
      setData(resp.data as CompareResult);
      setLastFetched(new Date().toLocaleTimeString('uk-UA'));
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Помилка завантаження');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function buildOpenreyestrRows(stats: ServiceStats | null | undefined, stageStats: ServiceStats | null | undefined): TableRow[] {
    const allKeys = new Set([
      ...Object.keys(stats?.tables || {}),
      ...Object.keys(stageStats?.tables || {}),
    ]);
    return Array.from(allKeys)
      .map(key => ({
        key,
        label: key,
        local: stats?.tables[key]?.rows ?? 0,
        stage: stageStats?.tables[key]?.rows,
      }))
      .sort((a, b) => Math.max(b.local, b.stage ?? 0) - Math.max(a.local, a.stage ?? 0));
  }

  function buildRadaRows(stats: ServiceStats | null | undefined, stageStats: ServiceStats | null | undefined): TableRow[] {
    const allKeys = new Set([
      ...Object.keys(stats?.tables || {}),
      ...Object.keys(stageStats?.tables || {}),
    ]);
    return Array.from(allKeys)
      .map(key => ({
        key,
        label: key,
        local: stats?.tables[key]?.rows ?? 0,
        stage: stageStats?.tables[key]?.rows,
      }))
      .sort((a, b) => Math.max(b.local, b.stage ?? 0) - Math.max(a.local, a.stage ?? 0));
  }

  function buildMainRows(local: Record<string, number> | null | undefined, stage: Record<string, number> | null | undefined): TableRow[] {
    const allKeys = new Set([
      ...Object.keys(local || {}),
      ...Object.keys(stage || {}),
    ]);
    return Array.from(allKeys)
      .map(key => ({
        key,
        label: MAIN_TABLE_LABELS[key] || key,
        local: local?.[key] ?? 0,
        stage: stage?.[key],
      }))
      .sort((a, b) => Math.max(b.local, b.stage ?? 0) - Math.max(a.local, a.stage ?? 0));
  }

  const stageAvailable = data?.stage !== null && data?.stage !== undefined;
  const openreyestrRows = buildOpenreyestrRows(data?.local?.openreyestr, data?.stage?.openreyestr);
  const radaRows = buildRadaRows(data?.local?.rada, data?.stage?.rada);
  const mainRows = buildMainRows(data?.local?.main, data?.stage?.main);

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Database className="w-5 h-5 text-claude-accent" />
            <div>
              <h1 className="text-lg font-semibold text-claude-text">Порівняння баз даних</h1>
              <p className="text-xs text-claude-subtext mt-0.5">Local Docker vs Stage — кількість записів у таблицях</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {lastFetched && (
              <span className="text-xs text-claude-subtext/60">Оновлено: {lastFetched}</span>
            )}
            <button
              onClick={fetchData}
              disabled={loading}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 transition-colors text-sm text-claude-text disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Оновити
            </button>
          </div>
        </div>

        {/* Stage status banner */}
        {!loading && data && !stageAvailable && (
          <div className="flex items-center gap-2 px-4 py-2.5 mb-6 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-yellow-300 text-sm">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            Stage недоступний або не відповідає. Показано тільки локальні дані.
          </div>
        )}
        {!loading && data && stageAvailable && (
          <div className="flex items-center gap-2 px-4 py-2.5 mb-6 rounded-lg bg-green-500/10 border border-green-500/20 text-green-300 text-sm">
            <CheckCircle className="w-4 h-4 shrink-0" />
            Stage підключено. Порівняння актуальне.
          </div>
        )}

        {/* Legend */}
        <div className="flex items-center gap-5 mb-6 text-xs text-claude-subtext/70">
          <span className="flex items-center gap-1.5"><span className="text-green-400 font-bold">=</span> рівно</span>
          <span className="flex items-center gap-1.5"><span className="text-yellow-400/80 font-bold">≈</span> &lt;1% різниця</span>
          <span className="flex items-center gap-1.5"><span className="text-yellow-400 font-bold">↑</span> stage більше</span>
          <span className="flex items-center gap-1.5"><span className="text-red-400 font-bold">❗</span> нема локально</span>
          <span className="flex items-center gap-1.5"><span className="text-orange-400 font-bold">❗</span> нема на stage</span>
        </div>

        {error && (
          <div className="mb-6 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* OpenReyestr */}
        <CompareTable
          title="OpenReyestr — НАІС реєстри (БД openreyestr)"
          rows={openreyestrRows}
          loading={loading}
        />

        {/* RADA */}
        <CompareTable
          title="RADA — Верховна Рада (схема rada в secondlayer)"
          rows={radaRows}
          loading={loading}
        />

        {/* Court registry / Main backend */}
        <CompareTable
          title="reyestr.court.gov.ua — Судовий реєстр (БД secondlayer)"
          rows={mainRows}
          loading={loading}
        />

        {/* Timestamps */}
        {data && (
          <div className="mt-4 text-xs text-claude-subtext/40 space-y-0.5">
            <div>Local: {data.local.timestamp}</div>
            {stageAvailable && <div>Stage: {data.stage!.timestamp}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
