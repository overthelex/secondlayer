import React, { useEffect, useState } from 'react';
import { Tag, RefreshCw, Save, AlertCircle, CheckCircle, ChevronDown, ChevronRight, Percent } from 'lucide-react';
import { api } from '../utils/api-client';

// ─── External service pricing ───────────────────────────────────────────────

interface PricingEntry {
  id: string;
  provider: string;
  model: string;
  display_name: string;
  unit_type: string;
  price_usd: number;
  currency: string;
  sort_order: number;
  notes: string | null;
  is_active: boolean;
  updated_at: string;
  updated_by: string | null;
}

// ─── Tool pricing ────────────────────────────────────────────────────────────

interface ToolPricingEntry {
  id: string;
  tool_name: string;
  service: string;
  display_name: string;
  base_cost_usd: number;
  markup_percent: number;
  is_active: boolean;
  notes: string | null;
  updated_at: string;
  updated_by: string | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PROVIDER_LABELS: Record<string, string> = {
  anthropic:   'Anthropic (Claude)',
  openai:      'OpenAI',
  voyageai:    'VoyageAI',
  zakononline: 'ZakonOnline API',
};
const PROVIDER_ORDER = ['anthropic', 'openai', 'voyageai', 'zakononline'];

const UNIT_LABELS: Record<string, string> = {
  per_1m_input_tokens:  'за 1M вхідних токенів',
  per_1m_output_tokens: 'за 1M вихідних токенів',
  per_1m_tokens:        'за 1M токенів',
  per_call:             'за виклик',
};

const SERVICE_LABELS: Record<string, string> = {
  backend:      'mcp_backend (юридичний аналіз)',
  rada:         'mcp_rada (парламент)',
  openreyestr:  'mcp_openreyestr (реєстр)',
};
const SERVICE_ORDER = ['backend', 'rada', 'openreyestr'];

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function fmtUsd(v: number) {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

// ─── External providers tab ──────────────────────────────────────────────────

function ExternalProvidersTab() {
  const [pricing, setPricing] = useState<PricingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Record<string, { price_usd: string; notes: string; is_active: boolean }>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [errorIds, setErrorIds] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.admin.getServicePricing();
      setPricing(res.data.pricing || []);
      const initial: typeof editValues = {};
      for (const p of res.data.pricing || []) {
        initial[p.id] = { price_usd: String(p.price_usd), notes: p.notes || '', is_active: p.is_active };
      }
      setEditValues(initial);
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message || 'Помилка завантаження');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const handleSave = async (entry: PricingEntry) => {
    const vals = editValues[entry.id];
    if (!vals) return;
    const priceNum = parseFloat(vals.price_usd);
    if (isNaN(priceNum) || priceNum < 0) {
      setErrorIds(prev => ({ ...prev, [entry.id]: 'Некоректна ціна' }));
      return;
    }
    setSaving(prev => ({ ...prev, [entry.id]: true }));
    setErrorIds(prev => { const n = { ...prev }; delete n[entry.id]; return n; });
    try {
      await api.admin.updateServicePricing(entry.id, { price_usd: priceNum, notes: vals.notes || undefined, is_active: vals.is_active });
      setSavedIds(prev => new Set([...prev, entry.id]));
      setPricing(prev => prev.map(p => p.id === entry.id ? { ...p, price_usd: priceNum, notes: vals.notes || null, is_active: vals.is_active, updated_at: new Date().toISOString() } : p));
      setTimeout(() => setSavedIds(prev => { const n = new Set(prev); n.delete(entry.id); return n; }), 2500);
    } catch (e: any) {
      setErrorIds(prev => ({ ...prev, [entry.id]: e?.response?.data?.error || e.message || 'Помилка збереження' }));
    } finally {
      setSaving(prev => ({ ...prev, [entry.id]: false }));
    }
  };

  const toggleCollapse = (provider: string) => {
    setCollapsed(prev => { const n = new Set(prev); n.has(provider) ? n.delete(provider) : n.add(provider); return n; });
  };

  const grouped: Record<string, PricingEntry[]> = {};
  for (const p of pricing) {
    if (!grouped[p.provider]) grouped[p.provider] = [];
    grouped[p.provider].push(p);
  }
  const providers = PROVIDER_ORDER.filter(p => grouped[p]);

  if (loading && !pricing.length) {
    return <div className="flex items-center justify-center py-16 text-claude-subtext"><RefreshCw className="w-5 h-5 animate-spin mr-2" />Завантаження…</div>;
  }
  if (error) {
    return <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-sm text-red-700"><AlertCircle className="w-4 h-4 flex-shrink-0" />{error}</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={load} disabled={loading} className="flex items-center gap-2 px-3 py-1.5 bg-white border border-claude-border rounded-lg text-sm text-claude-text hover:bg-claude-bg transition-colors disabled:opacity-50">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />Оновити
        </button>
      </div>
      {providers.map(provider => {
        const entries = grouped[provider] || [];
        const isCollapsed = collapsed.has(provider);
        return (
          <div key={provider} className="bg-white rounded-xl border border-claude-border shadow-sm overflow-hidden">
            <button onClick={() => toggleCollapse(provider)} className="w-full flex items-center justify-between px-5 py-3 bg-claude-bg hover:bg-claude-sidebar transition-colors text-left">
              <span className="font-medium text-claude-text font-sans">{PROVIDER_LABELS[provider] || provider}</span>
              <div className="flex items-center gap-2 text-claude-subtext text-xs">
                <span>{entries.length} {entries.length === 1 ? 'позиція' : 'позиції'}</span>
                {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </div>
            </button>
            {!isCollapsed && (
              <div className="divide-y divide-claude-border">
                <div className="grid grid-cols-[1fr_120px_180px_100px_80px_100px] gap-3 px-5 py-2 bg-white text-xs font-medium text-claude-subtext uppercase tracking-wide">
                  <span>Модель / Послуга</span><span>Одиниця</span><span>Ціна (USD)</span><span>Активна</span><span>Оновлено</span><span></span>
                </div>
                {entries.map(entry => {
                  const vals = editValues[entry.id];
                  const isSaving = saving[entry.id];
                  const isSaved = savedIds.has(entry.id);
                  const entryError = errorIds[entry.id];
                  const isDirty = vals && (
                    String(parseFloat(vals.price_usd) || 0) !== String(entry.price_usd) ||
                    (vals.notes || '') !== (entry.notes || '') ||
                    vals.is_active !== entry.is_active
                  );
                  return (
                    <div key={entry.id} className={`grid grid-cols-[1fr_120px_180px_100px_80px_100px] gap-3 px-5 py-3 items-center text-sm hover:bg-claude-bg transition-colors ${!entry.is_active ? 'opacity-50' : ''}`}>
                      <div>
                        <div className="font-medium text-claude-text">{entry.display_name}</div>
                        {entry.notes && <div className="text-xs text-claude-subtext mt-0.5">{entry.notes}</div>}
                      </div>
                      <div className="text-xs text-claude-subtext">
                        {UNIT_LABELS[entry.unit_type] || entry.unit_type}
                        <div className="text-claude-subtext/70">{entry.currency}</div>
                      </div>
                      <div>
                        <div className="flex items-center gap-1">
                          <span className="text-claude-subtext text-xs">$</span>
                          <input type="number" min="0" step="0.00000001" value={vals?.price_usd ?? entry.price_usd}
                            onChange={e => setEditValues(prev => ({ ...prev, [entry.id]: { ...prev[entry.id], price_usd: e.target.value } }))}
                            className="w-full border border-claude-border rounded-md px-2 py-1 text-sm text-claude-text bg-white focus:outline-none focus:ring-2 focus:ring-claude-accent/40 focus:border-claude-accent/60"
                          />
                        </div>
                        {entryError && <div className="text-xs text-red-500 mt-1">{entryError}</div>}
                      </div>
                      <div className="flex justify-center">
                        <button onClick={() => setEditValues(prev => ({ ...prev, [entry.id]: { ...prev[entry.id], is_active: !prev[entry.id]?.is_active } }))}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${vals?.is_active ? 'bg-claude-accent' : 'bg-claude-border'}`}>
                          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${vals?.is_active ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
                        </button>
                      </div>
                      <div className="text-xs text-claude-subtext whitespace-nowrap">{formatDate(entry.updated_at)}</div>
                      <div className="flex justify-end">
                        {isSaved ? (
                          <span className="flex items-center gap-1 text-xs text-emerald-600"><CheckCircle className="w-3.5 h-3.5" /> Збережено</span>
                        ) : (
                          <button onClick={() => handleSave(entry)} disabled={isSaving || !isDirty}
                            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-claude-text text-white rounded-md hover:bg-black/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                            {isSaving ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                            Зберегти
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      <p className="text-xs text-claude-subtext">
        Ціни зберігаються в таблиці <code className="font-mono bg-claude-bg px-1 rounded">service_pricing</code> та використовуються для обліку собівартості запитів.
        Значення вказуються в USD (крім ZakonOnline — в UAH).
      </p>
    </div>
  );
}

// ─── Tool pricing tab ────────────────────────────────────────────────────────

function ToolPricingTab() {
  const [tools, setTools] = useState<ToolPricingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Record<string, { base_cost_usd: string; markup_percent: string; notes: string; is_active: boolean }>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [savedNames, setSavedNames] = useState<Set<string>>(new Set());
  const [errorNames, setErrorNames] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Bulk markup
  const [bulkMarkup, setBulkMarkup] = useState('');
  const [bulkService, setBulkService] = useState('');
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.admin.getToolPricing();
      const rows: ToolPricingEntry[] = res.data.tools || [];
      setTools(rows);
      const initial: typeof editValues = {};
      for (const t of rows) {
        initial[t.tool_name] = {
          base_cost_usd: String(t.base_cost_usd),
          markup_percent: String(t.markup_percent),
          notes: t.notes || '',
          is_active: t.is_active,
        };
      }
      setEditValues(initial);
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message || 'Помилка завантаження');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const handleSave = async (tool: ToolPricingEntry) => {
    const vals = editValues[tool.tool_name];
    if (!vals) return;
    const costNum = parseFloat(vals.base_cost_usd);
    const markupNum = parseFloat(vals.markup_percent);
    if (isNaN(costNum) || costNum < 0) {
      setErrorNames(prev => ({ ...prev, [tool.tool_name]: 'Некоректна собівартість' }));
      return;
    }
    if (isNaN(markupNum) || markupNum < -100) {
      setErrorNames(prev => ({ ...prev, [tool.tool_name]: 'Надбавка ≥ -100%' }));
      return;
    }
    setSaving(prev => ({ ...prev, [tool.tool_name]: true }));
    setErrorNames(prev => { const n = { ...prev }; delete n[tool.tool_name]; return n; });
    try {
      await api.admin.updateToolPricing(tool.tool_name, {
        base_cost_usd: costNum,
        markup_percent: markupNum,
        notes: vals.notes || undefined,
        is_active: vals.is_active,
      });
      setSavedNames(prev => new Set([...prev, tool.tool_name]));
      setTools(prev => prev.map(t => t.tool_name === tool.tool_name
        ? { ...t, base_cost_usd: costNum, markup_percent: markupNum, notes: vals.notes || null, is_active: vals.is_active, updated_at: new Date().toISOString() }
        : t
      ));
      setTimeout(() => setSavedNames(prev => { const n = new Set(prev); n.delete(tool.tool_name); return n; }), 2500);
    } catch (e: any) {
      setErrorNames(prev => ({ ...prev, [tool.tool_name]: e?.response?.data?.error || e.message || 'Помилка збереження' }));
    } finally {
      setSaving(prev => ({ ...prev, [tool.tool_name]: false }));
    }
  };

  const handleBulkMarkup = async () => {
    const pct = parseFloat(bulkMarkup);
    if (isNaN(pct) || pct < -100) { setBulkMsg({ ok: false, text: 'Некоректне значення надбавки' }); return; }
    setBulkSaving(true); setBulkMsg(null);
    try {
      const res = await api.admin.bulkToolMarkup({ markup_percent: pct, service: bulkService || undefined });
      setBulkMsg({ ok: true, text: `Оновлено ${res.data.updated} інструментів` });
      await load();
    } catch (e: any) {
      setBulkMsg({ ok: false, text: e?.response?.data?.error || e.message || 'Помилка' });
    } finally {
      setBulkSaving(false);
    }
  };

  const toggleCollapse = (svc: string) => {
    setCollapsed(prev => { const n = new Set(prev); n.has(svc) ? n.delete(svc) : n.add(svc); return n; });
  };

  const grouped: Record<string, ToolPricingEntry[]> = {};
  for (const t of tools) {
    if (!grouped[t.service]) grouped[t.service] = [];
    grouped[t.service].push(t);
  }
  const services = SERVICE_ORDER.filter(s => grouped[s]);

  if (loading && !tools.length) {
    return <div className="flex items-center justify-center py-16 text-claude-subtext"><RefreshCw className="w-5 h-5 animate-spin mr-2" />Завантаження…</div>;
  }
  if (error) {
    return <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-sm text-red-700"><AlertCircle className="w-4 h-4 flex-shrink-0" />{error}</div>;
  }

  return (
    <div className="space-y-4">
      {/* Bulk markup panel */}
      <div className="bg-white rounded-xl border border-claude-border shadow-sm p-4">
        <div className="flex items-center gap-2 mb-3">
          <Percent className="w-4 h-4 text-claude-accent" />
          <span className="font-medium text-sm text-claude-text">Масова зміна надбавки</span>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1">
            <input
              type="number" step="0.01" placeholder="Надбавка, %"
              value={bulkMarkup}
              onChange={e => setBulkMarkup(e.target.value)}
              className="w-36 border border-claude-border rounded-md px-2 py-1.5 text-sm text-claude-text bg-white focus:outline-none focus:ring-2 focus:ring-claude-accent/40"
            />
            <span className="text-claude-subtext text-sm">%</span>
          </div>
          <select
            value={bulkService}
            onChange={e => setBulkService(e.target.value)}
            className="border border-claude-border rounded-md px-2 py-1.5 text-sm text-claude-text bg-white focus:outline-none focus:ring-2 focus:ring-claude-accent/40"
          >
            <option value="">Всі сервіси</option>
            {SERVICE_ORDER.map(s => <option key={s} value={s}>{SERVICE_LABELS[s] || s}</option>)}
          </select>
          <button
            onClick={handleBulkMarkup}
            disabled={bulkSaving || bulkMarkup === ''}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-claude-text text-white rounded-md hover:bg-black/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {bulkSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Percent className="w-3.5 h-3.5" />}
            Застосувати
          </button>
          {bulkMsg && (
            <span className={`text-sm flex items-center gap-1 ${bulkMsg.ok ? 'text-emerald-600' : 'text-red-600'}`}>
              {bulkMsg.ok ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
              {bulkMsg.text}
            </span>
          )}
          <button onClick={load} disabled={loading} className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-white border border-claude-border rounded-lg text-sm text-claude-text hover:bg-claude-bg transition-colors disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />Оновити
          </button>
        </div>
        <p className="mt-2 text-xs text-claude-subtext">
          Надбавка додається до собівартості при виставленні рахунку клієнту. Від'ємне значення — знижка.
        </p>
      </div>

      {/* Tool groups */}
      {services.map(svc => {
        const entries = grouped[svc] || [];
        const isCollapsed = collapsed.has(svc);
        const totalTools = entries.length;
        const avgCost = entries.reduce((s, t) => s + t.base_cost_usd, 0) / (totalTools || 1);
        return (
          <div key={svc} className="bg-white rounded-xl border border-claude-border shadow-sm overflow-hidden">
            <button onClick={() => toggleCollapse(svc)} className="w-full flex items-center justify-between px-5 py-3 bg-claude-bg hover:bg-claude-sidebar transition-colors text-left">
              <span className="font-medium text-claude-text font-sans">{SERVICE_LABELS[svc] || svc}</span>
              <div className="flex items-center gap-3 text-claude-subtext text-xs">
                <span>{totalTools} інструм.</span>
                <span>Середня: ${fmtUsd(avgCost)}</span>
                {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </div>
            </button>

            {!isCollapsed && (
              <div className="divide-y divide-claude-border">
                {/* Table header */}
                <div className="grid grid-cols-[1fr_160px_140px_90px_80px_90px] gap-2 px-5 py-2 bg-white text-xs font-medium text-claude-subtext uppercase tracking-wide">
                  <span>Інструмент</span>
                  <span>Собівартість (USD)</span>
                  <span>Надбавка (%)</span>
                  <span>Клієнтська ціна</span>
                  <span>Активний</span>
                  <span></span>
                </div>

                {entries.map(tool => {
                  const vals = editValues[tool.tool_name];
                  const isSaving = saving[tool.tool_name];
                  const isSaved = savedNames.has(tool.tool_name);
                  const toolError = errorNames[tool.tool_name];
                  const costNum = parseFloat(vals?.base_cost_usd ?? String(tool.base_cost_usd)) || 0;
                  const markupNum = parseFloat(vals?.markup_percent ?? String(tool.markup_percent)) || 0;
                  const clientPrice = costNum * (1 + markupNum / 100);
                  const isDirty = vals && (
                    String(parseFloat(vals.base_cost_usd) || 0) !== String(tool.base_cost_usd) ||
                    String(parseFloat(vals.markup_percent) || 0) !== String(tool.markup_percent) ||
                    (vals.notes || '') !== (tool.notes || '') ||
                    vals.is_active !== tool.is_active
                  );

                  return (
                    <div key={tool.tool_name}
                      className={`grid grid-cols-[1fr_160px_140px_90px_80px_90px] gap-2 px-5 py-3 items-center text-sm hover:bg-claude-bg transition-colors ${!tool.is_active ? 'opacity-50' : ''}`}
                    >
                      {/* Name */}
                      <div>
                        <div className="font-medium text-claude-text">{tool.display_name}</div>
                        <div className="text-xs text-claude-subtext font-mono mt-0.5">{tool.tool_name}</div>
                        {tool.notes && <div className="text-xs text-claude-subtext/70 mt-0.5 italic">{tool.notes}</div>}
                        {toolError && <div className="text-xs text-red-500 mt-1">{toolError}</div>}
                      </div>

                      {/* Base cost */}
                      <div>
                        <div className="flex items-center gap-1">
                          <span className="text-claude-subtext text-xs">$</span>
                          <input
                            type="number" min="0" step="0.000001"
                            value={vals?.base_cost_usd ?? tool.base_cost_usd}
                            onChange={e => setEditValues(prev => ({ ...prev, [tool.tool_name]: { ...prev[tool.tool_name], base_cost_usd: e.target.value } }))}
                            className="w-full border border-claude-border rounded-md px-2 py-1 text-sm text-claude-text bg-white focus:outline-none focus:ring-2 focus:ring-claude-accent/40 focus:border-claude-accent/60"
                          />
                        </div>
                      </div>

                      {/* Markup % */}
                      <div>
                        <div className="flex items-center gap-1">
                          <input
                            type="number" step="0.01"
                            value={vals?.markup_percent ?? tool.markup_percent}
                            onChange={e => setEditValues(prev => ({ ...prev, [tool.tool_name]: { ...prev[tool.tool_name], markup_percent: e.target.value } }))}
                            className="w-full border border-claude-border rounded-md px-2 py-1 text-sm text-claude-text bg-white focus:outline-none focus:ring-2 focus:ring-claude-accent/40 focus:border-claude-accent/60"
                          />
                          <span className="text-claude-subtext text-xs">%</span>
                        </div>
                      </div>

                      {/* Client price (computed) */}
                      <div className="text-sm font-medium text-claude-text text-right tabular-nums">
                        ${fmtUsd(clientPrice)}
                      </div>

                      {/* Active toggle */}
                      <div className="flex justify-center">
                        <button
                          onClick={() => setEditValues(prev => ({ ...prev, [tool.tool_name]: { ...prev[tool.tool_name], is_active: !prev[tool.tool_name]?.is_active } }))}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${vals?.is_active ? 'bg-claude-accent' : 'bg-claude-border'}`}
                        >
                          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${vals?.is_active ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
                        </button>
                      </div>

                      {/* Save button */}
                      <div className="flex justify-end">
                        {isSaved ? (
                          <span className="flex items-center gap-1 text-xs text-emerald-600"><CheckCircle className="w-3.5 h-3.5" /> Збережено</span>
                        ) : (
                          <button
                            onClick={() => handleSave(tool)}
                            disabled={isSaving || !isDirty}
                            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-claude-text text-white rounded-md hover:bg-black/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          >
                            {isSaving ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                            Зберегти
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <p className="text-xs text-claude-subtext">
        Дані зберігаються в таблиці <code className="font-mono bg-claude-bg px-1 rounded">tool_pricing</code>.
        «Клієнтська ціна» розраховується як: собівартість × (1 + надбавка / 100).
      </p>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

type Tab = 'external' | 'tools';

export function AdminServicePricingPage() {
  const [activeTab, setActiveTab] = useState<Tab>('tools');

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-claude-accent/10 rounded-lg">
            <Tag className="w-6 h-6 text-claude-accent" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-claude-text font-sans">Собівартість сервісів</h1>
            <p className="text-sm text-claude-subtext mt-0.5">Управління вартістю API-сервісів та MCP-інструментів</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 bg-claude-bg rounded-lg p-1 w-fit">
          <button
            onClick={() => setActiveTab('tools')}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === 'tools' ? 'bg-white text-claude-text shadow-sm' : 'text-claude-subtext hover:text-claude-text'}`}
          >
            MCP Інструменти
          </button>
          <button
            onClick={() => setActiveTab('external')}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === 'external' ? 'bg-white text-claude-text shadow-sm' : 'text-claude-subtext hover:text-claude-text'}`}
          >
            Зовнішні сервіси
          </button>
        </div>

        {activeTab === 'tools'    && <ToolPricingTab />}
        {activeTab === 'external' && <ExternalProvidersTab />}
      </div>
    </div>
  );
}
