/**
 * Admin ZO Stats Page
 * Document count statistics from ZakonOnline by year and proceeding type.
 */

import React, { useState, useCallback } from 'react';
import {
  RefreshCw,
  BarChart3,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Info,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  CartesianGrid,
} from 'recharts';
import { api } from '../utils/api-client';
import toast from 'react-hot-toast';

// ── Types ──────────────────────────────────────────────

interface JusticeKindMeta {
  id: number;
  label: string;
}

interface JudgmentFormMeta {
  id: number;
  name: string;
}

interface MatrixRow {
  year: number;
  total: number;
  byKind: Record<number, number>;
  byForm?: Record<number, number>;
}

interface ZOStatsResponse {
  matrix: MatrixRow[];
  years: number[];
  justiceKinds: JusticeKindMeta[];
  judgmentForms: JudgmentFormMeta[];
  params: { yearFrom: number; yearTo: number; justiceKinds: number[] };
}

// ── Constants ──────────────────────────────────────────

const KIND_COLORS: Record<number, string> = {
  1: '#3b82f6', // blue  – цивільне
  2: '#ef4444', // red   – кримінальне
  3: '#f59e0b', // amber – господарське
  4: '#10b981', // green – адміністративне
};

const ALL_KINDS = [
  { id: 1, label: 'Цивільне' },
  { id: 2, label: 'Кримінальне' },
  { id: 3, label: 'Господарське' },
  { id: 4, label: 'Адміністративне' },
];

const CURRENT_YEAR = new Date().getFullYear();

// ── Helpers ────────────────────────────────────────────

function formatNum(n: number): string {
  if (n < 0) return '—';
  return n.toLocaleString('uk-UA');
}

function pct(part: number, total: number): string {
  if (total <= 0 || part < 0) return '';
  return ` (${((part / total) * 100).toFixed(1)}%)`;
}

// ── Component ──────────────────────────────────────────

export function AdminZOStatsPage() {
  const [yearFrom, setYearFrom] = useState(2020);
  const [yearTo, setYearTo]     = useState(2025);
  const [selectedKinds, setSelectedKinds] = useState<number[]>([1, 2, 3, 4]);
  const [loading, setLoading]   = useState(false);
  const [data, setData]         = useState<ZOStatsResponse | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [showChart, setShowChart] = useState(true);

  // ── Fetch ────────────────────────────────────────────

  const fetchStats = useCallback(async () => {
    if (selectedKinds.length === 0) {
      toast.error('Оберіть хоча б один вид судочинства');
      return;
    }
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const params = new URLSearchParams({
        yearFrom: String(yearFrom),
        yearTo:   String(yearTo),
        justiceKind: selectedKinds.join(','),
      });
      const resp = await api.get<ZOStatsResponse>(`/api/admin/zo-stats?${params}`);
      setData(resp.data);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Помилка запиту';
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [yearFrom, yearTo, selectedKinds]);

  // ── Derived ──────────────────────────────────────────

  const chartData = data?.matrix.map(row => {
    const entry: Record<string, any> = { year: row.year };
    for (const k of data.justiceKinds) {
      entry[k.label] = row.byKind[k.id] ?? 0;
    }
    return entry;
  }) ?? [];

  const grandTotal = data?.matrix.reduce((s, r) => s + (r.total >= 0 ? r.total : 0), 0) ?? 0;

  // ── Toggle kind selection ─────────────────────────────

  function toggleKind(id: number) {
    setSelectedKinds(prev =>
      prev.includes(id) ? prev.filter(k => k !== id) : [...prev, id]
    );
  }

  // ── Render ───────────────────────────────────────────

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BarChart3 className="w-6 h-6 text-blue-500" />
          <div>
            <h1 className="text-xl font-semibold text-white">Статистика судових рішень</h1>
            <p className="text-sm text-gray-400">Кількість документів за роками через ZakonOnline API</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-gray-800 rounded-xl p-5 space-y-4 border border-gray-700">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Параметри запиту</h2>

        <div className="flex flex-wrap gap-4 items-end">
          {/* Year From */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">Рік від</label>
            <input
              type="number"
              min={2000}
              max={CURRENT_YEAR}
              value={yearFrom}
              onChange={e => setYearFrom(Number(e.target.value))}
              className="w-28 px-3 py-2 rounded-lg bg-gray-700 border border-gray-600 text-white text-sm focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Year To */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">Рік до</label>
            <input
              type="number"
              min={yearFrom}
              max={CURRENT_YEAR}
              value={yearTo}
              onChange={e => setYearTo(Number(e.target.value))}
              className="w-28 px-3 py-2 rounded-lg bg-gray-700 border border-gray-600 text-white text-sm focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Justice kinds */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">Вид судочинства</label>
            <div className="flex flex-wrap gap-2">
              {ALL_KINDS.map(k => (
                <button
                  key={k.id}
                  onClick={() => toggleKind(k.id)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-all ${
                    selectedKinds.includes(k.id)
                      ? 'border-transparent text-white'
                      : 'border-gray-600 text-gray-400 bg-transparent hover:border-gray-500'
                  }`}
                  style={selectedKinds.includes(k.id) ? { backgroundColor: KIND_COLORS[k.id] } : {}}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>

          {/* Recalculate button */}
          <button
            onClick={fetchStats}
            disabled={loading}
            className="flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Обчислення…' : 'Перерахувати'}
          </button>
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-yellow-400">
            <Info className="w-4 h-4 shrink-0" />
            Запити до API виконуються послідовно з затримкою (~{Math.ceil((yearTo - yearFrom + 1) * (selectedKinds.length + 1) * 0.25)} с очікується)…
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-3 bg-red-900/30 border border-red-700 rounded-xl p-4 text-red-300">
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      {/* Results */}
      {data && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            <div className="bg-gray-800 rounded-xl p-4 border border-gray-700 col-span-1">
              <p className="text-xs text-gray-400 mb-1">Всього за період</p>
              <p className="text-2xl font-bold text-white">{formatNum(grandTotal)}</p>
              <p className="text-xs text-gray-500 mt-1">{data.params.yearFrom}–{data.params.yearTo}</p>
            </div>
            {data.justiceKinds.map(k => {
              const kindTotal = data.matrix.reduce((s, r) => s + (r.byKind[k.id] ?? 0), 0);
              return (
                <div key={k.id} className="bg-gray-800 rounded-xl p-4 border border-gray-700">
                  <p className="text-xs text-gray-400 mb-1">{k.label}</p>
                  <p className="text-2xl font-bold text-white">{formatNum(kindTotal)}</p>
                  <p className="text-xs mt-1" style={{ color: KIND_COLORS[k.id] }}>
                    {pct(kindTotal, grandTotal)}
                  </p>
                </div>
              );
            })}
          </div>

          {/* Chart toggle */}
          <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
            <button
              onClick={() => setShowChart(v => !v)}
              className="w-full flex items-center justify-between px-5 py-3 text-sm font-semibold text-gray-300 hover:bg-gray-750 transition-colors"
            >
              <span>Графік по роках</span>
              {showChart ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
            {showChart && (
              <div className="px-2 pb-4">
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="year" stroke="#9ca3af" tick={{ fontSize: 12 }} />
                    <YAxis stroke="#9ca3af" tick={{ fontSize: 12 }} tickFormatter={v => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v)} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: 8 }}
                      labelStyle={{ color: '#e5e7eb', fontWeight: 600 }}
                      formatter={(value: any, name: string) => [formatNum(Number(value)), name]}
                    />
                    <Legend wrapperStyle={{ color: '#9ca3af', fontSize: 12 }} />
                    {data.justiceKinds.map(k => (
                      <Bar key={k.id} dataKey={k.label} fill={KIND_COLORS[k.id]} radius={[3, 3, 0, 0]} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* Table */}
          <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700">
                  <th className="text-left px-5 py-3 text-gray-400 font-semibold">Рік</th>
                  <th className="text-right px-5 py-3 text-gray-400 font-semibold">Всього</th>
                  {data.justiceKinds.map(k => (
                    <th key={k.id} className="text-right px-5 py-3 font-semibold" style={{ color: KIND_COLORS[k.id] }}>
                      {k.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.matrix.map((row, i) => (
                  <React.Fragment key={row.year}>
                    <tr className={`border-b border-gray-700/50 hover:bg-gray-750 transition-colors ${i % 2 === 0 ? 'bg-gray-800' : 'bg-gray-800/60'}`}>
                      <td className="px-5 py-3 font-bold text-white">{row.year}</td>
                      <td className="px-5 py-3 text-right font-semibold text-white">{formatNum(row.total)}</td>
                      {data.justiceKinds.map(k => (
                        <td key={k.id} className="px-5 py-3 text-right text-gray-200">
                          {formatNum(row.byKind[k.id] ?? -1)}
                          <span className="text-gray-500 text-xs ml-1">{pct(row.byKind[k.id], row.total)}</span>
                        </td>
                      ))}
                    </tr>

                    {/* Judgment form breakdown (single kind mode) */}
                    {row.byForm && data.judgmentForms.length > 0 && (
                      <tr className="border-b border-gray-700/30">
                        <td colSpan={2 + data.justiceKinds.length} className="px-5 py-0">
                          <div className="flex flex-wrap gap-x-6 gap-y-1 py-2 text-xs text-gray-400">
                            {data.judgmentForms.map(f => (
                              <span key={f.id}>
                                <span className="text-gray-300">{f.name}:</span>{' '}
                                {formatNum(row.byForm![f.id] ?? -1)}
                                {pct(row.byForm![f.id], row.byKind[data.justiceKinds[0]?.id])}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
              {/* Totals row */}
              <tfoot>
                <tr className="border-t border-gray-600 bg-gray-700/40">
                  <td className="px-5 py-3 font-bold text-gray-300">Разом</td>
                  <td className="px-5 py-3 text-right font-bold text-white">{formatNum(grandTotal)}</td>
                  {data.justiceKinds.map(k => {
                    const kindTotal = data.matrix.reduce((s, r) => s + (r.byKind[k.id] ?? 0), 0);
                    return (
                      <td key={k.id} className="px-5 py-3 text-right font-bold text-gray-200">
                        {formatNum(kindTotal)}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            </table>
          </div>

          <p className="text-xs text-gray-500 text-center">
            Дані отримані з ZakonOnline API • Лише судові рішення (court_decisions) • Фільтрація по adjudication_date
          </p>
        </>
      )}

      {!data && !loading && !error && (
        <div className="flex flex-col items-center justify-center py-20 text-gray-500 gap-3">
          <BarChart3 className="w-12 h-12" />
          <p className="text-sm">Оберіть параметри та натисніть «Перерахувати»</p>
        </div>
      )}
    </div>
  );
}
