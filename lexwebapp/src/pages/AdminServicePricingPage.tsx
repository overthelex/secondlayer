import React, { useEffect, useState } from 'react';
import { Tag, RefreshCw, Save, AlertCircle, CheckCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../utils/api-client';

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

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

export function AdminServicePricingPage() {
  const [pricing, setPricing] = useState<PricingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Record<string, { price_usd: string; notes: string; is_active: boolean }>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [errorIds, setErrorIds] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.admin.getServicePricing();
      setPricing(res.data.pricing || []);
      const initial: typeof editValues = {};
      for (const p of res.data.pricing || []) {
        initial[p.id] = {
          price_usd: String(p.price_usd),
          notes: p.notes || '',
          is_active: p.is_active,
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
      await api.admin.updateServicePricing(entry.id, {
        price_usd: priceNum,
        notes: vals.notes || undefined,
        is_active: vals.is_active,
      });
      setSavedIds(prev => new Set([...prev, entry.id]));
      setPricing(prev => prev.map(p =>
        p.id === entry.id
          ? { ...p, price_usd: priceNum, notes: vals.notes || null, is_active: vals.is_active, updated_at: new Date().toISOString() }
          : p
      ));
      setTimeout(() => setSavedIds(prev => { const n = new Set(prev); n.delete(entry.id); return n; }), 2500);
    } catch (e: any) {
      setErrorIds(prev => ({ ...prev, [entry.id]: e?.response?.data?.error || e.message || 'Помилка збереження' }));
    } finally {
      setSaving(prev => ({ ...prev, [entry.id]: false }));
    }
  };

  const toggleCollapse = (provider: string) => {
    setCollapsed(prev => {
      const n = new Set(prev);
      n.has(provider) ? n.delete(provider) : n.add(provider);
      return n;
    });
  };

  const grouped: Record<string, PricingEntry[]> = {};
  for (const p of pricing) {
    if (!grouped[p.provider]) grouped[p.provider] = [];
    grouped[p.provider].push(p);
  }

  const providers = PROVIDER_ORDER.filter(p => grouped[p]);

  return (
    <div className="h-full overflow-y-auto">
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-claude-accent/10 rounded-lg">
            <Tag className="w-6 h-6 text-claude-accent" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-claude-text font-sans">Собівартість зовнішніх сервісів</h1>
            <p className="text-sm text-claude-subtext mt-0.5">Управління вартістю API-сервісів для обліку витрат</p>
          </div>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-claude-border rounded-lg text-sm text-claude-text hover:bg-claude-bg transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Оновити
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-sm text-red-700">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {loading && !pricing.length ? (
        <div className="flex items-center justify-center py-16 text-claude-subtext">
          <RefreshCw className="w-5 h-5 animate-spin mr-2" />
          Завантаження…
        </div>
      ) : (
        <div className="space-y-4">
          {providers.map(provider => {
            const entries = grouped[provider] || [];
            const isCollapsed = collapsed.has(provider);
            return (
              <div key={provider} className="bg-white rounded-xl border border-claude-border shadow-sm overflow-hidden">
                {/* Provider header */}
                <button
                  onClick={() => toggleCollapse(provider)}
                  className="w-full flex items-center justify-between px-5 py-3 bg-claude-bg hover:bg-claude-sidebar transition-colors text-left"
                >
                  <span className="font-medium text-claude-text font-sans">{PROVIDER_LABELS[provider] || provider}</span>
                  <div className="flex items-center gap-2 text-claude-subtext text-xs">
                    <span>{entries.length} {entries.length === 1 ? 'позиція' : 'позиції'}</span>
                    {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </div>
                </button>

                {!isCollapsed && (
                  <div className="divide-y divide-claude-border">
                    {/* Table header */}
                    <div className="grid grid-cols-[1fr_120px_180px_100px_80px_100px] gap-3 px-5 py-2 bg-white text-xs font-medium text-claude-subtext uppercase tracking-wide">
                      <span>Модель / Послуга</span>
                      <span>Одиниця</span>
                      <span>Ціна (USD)</span>
                      <span>Активна</span>
                      <span>Оновлено</span>
                      <span></span>
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
                        <div
                          key={entry.id}
                          className={`grid grid-cols-[1fr_120px_180px_100px_80px_100px] gap-3 px-5 py-3 items-center text-sm hover:bg-claude-bg transition-colors ${!entry.is_active ? 'opacity-50' : ''}`}
                        >
                          {/* Name */}
                          <div>
                            <div className="font-medium text-claude-text">{entry.display_name}</div>
                            {entry.notes && (
                              <div className="text-xs text-claude-subtext mt-0.5">{entry.notes}</div>
                            )}
                          </div>

                          {/* Unit type */}
                          <div className="text-xs text-claude-subtext">
                            {UNIT_LABELS[entry.unit_type] || entry.unit_type}
                            <div className="text-claude-subtext/70">{entry.currency}</div>
                          </div>

                          {/* Price input */}
                          <div>
                            <div className="flex items-center gap-1">
                              <span className="text-claude-subtext text-xs">$</span>
                              <input
                                type="number"
                                min="0"
                                step="0.00000001"
                                value={vals?.price_usd ?? entry.price_usd}
                                onChange={e => setEditValues(prev => ({
                                  ...prev,
                                  [entry.id]: { ...prev[entry.id], price_usd: e.target.value },
                                }))}
                                className="w-full border border-claude-border rounded-md px-2 py-1 text-sm text-claude-text bg-white focus:outline-none focus:ring-2 focus:ring-claude-accent/40 focus:border-claude-accent/60"
                              />
                            </div>
                            {entryError && (
                              <div className="text-xs text-red-500 mt-1">{entryError}</div>
                            )}
                          </div>

                          {/* Active toggle */}
                          <div className="flex justify-center">
                            <button
                              onClick={() => setEditValues(prev => ({
                                ...prev,
                                [entry.id]: { ...prev[entry.id], is_active: !prev[entry.id]?.is_active },
                              }))}
                              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${vals?.is_active ? 'bg-claude-accent' : 'bg-claude-border'}`}
                            >
                              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${vals?.is_active ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
                            </button>
                          </div>

                          {/* Updated at */}
                          <div className="text-xs text-claude-subtext whitespace-nowrap">
                            {formatDate(entry.updated_at)}
                          </div>

                          {/* Save button */}
                          <div className="flex justify-end">
                            {isSaved ? (
                              <span className="flex items-center gap-1 text-xs text-emerald-600">
                                <CheckCircle className="w-3.5 h-3.5" /> Збережено
                              </span>
                            ) : (
                              <button
                                onClick={() => handleSave(entry)}
                                disabled={isSaving || !isDirty}
                                className="flex items-center gap-1 px-2.5 py-1 text-xs bg-claude-text text-white rounded-md hover:bg-black/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                              >
                                {isSaving ? (
                                  <RefreshCw className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Save className="w-3 h-3" />
                                )}
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
        </div>
      )}

      <p className="mt-6 text-xs text-claude-subtext">
        Ціни зберігаються в таблиці <code className="font-mono bg-claude-bg px-1 rounded">service_pricing</code> та використовуються для обліку собівартості запитів.
        Значення вказуються в USD (крім ZakonOnline — в UAH).
      </p>
    </div>
    </div>
  );
}
