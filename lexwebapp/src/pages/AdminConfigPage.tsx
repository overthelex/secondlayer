/**
 * Admin Config Page
 * View and override system configuration at runtime
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  RefreshCw,
  Search,
  Lock,
  Edit3,
  RotateCcw,
  Save,
  X,
  Settings,
} from 'lucide-react';
import { api } from '../utils/api-client';
import toast from 'react-hot-toast';

interface ConfigEntry {
  key: string;
  category: string;
  description: string;
  is_secret: boolean;
  value_type: 'string' | 'number' | 'boolean' | 'select';
  default_value: string;
  value: string;
  source: 'database' | 'env' | 'default';
  options?: string[];
  updated_at?: string;
  updated_by?: string;
}

interface CategoryGroup {
  label: string;
  entries: ConfigEntry[];
}

const SOURCE_BADGE: Record<string, { label: string; className: string }> = {
  database: { label: 'DB', className: 'bg-blue-100 text-blue-700' },
  env: { label: 'ENV', className: 'bg-green-100 text-green-700' },
  default: { label: 'Default', className: 'bg-gray-100 text-gray-600' },
};

export function AdminConfigPage() {
  const [categories, setCategories] = useState<Record<string, CategoryGroup>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchConfig = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.admin.getConfig();
      setCategories(res.data.categories);
    } catch {
      toast.error('Failed to load configuration');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const handleSave = async (key: string) => {
    try {
      setSaving(true);
      await api.admin.updateConfig(key, editValue);
      toast.success(`Updated ${key}`);
      setEditingKey(null);
      await fetchConfig();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async (key: string) => {
    try {
      await api.admin.resetConfig(key);
      toast.success(`Reset ${key} to default`);
      await fetchConfig();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to reset');
    }
  };

  const startEditing = (entry: ConfigEntry) => {
    setEditingKey(entry.key);
    setEditValue(entry.value);
  };

  const filteredCategories = Object.entries(categories).reduce<Record<string, CategoryGroup>>(
    (acc, [catKey, group]) => {
      if (!search) {
        acc[catKey] = group;
        return acc;
      }
      const q = search.toLowerCase();
      const filtered = group.entries.filter(
        (e) =>
          e.key.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q)
      );
      if (filtered.length > 0) {
        acc[catKey] = { ...group, entries: filtered };
      }
      return acc;
    },
    {}
  );

  const totalEntries = Object.values(categories).reduce((sum, g) => sum + g.entries.length, 0);
  const dbOverrides = Object.values(categories)
    .flatMap((g) => g.entries)
    .filter((e) => e.source === 'database').length;

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-claude-bg">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-claude-text flex items-center gap-2">
            <Settings size={24} />
            Конфігурація системи
          </h1>
          <p className="text-sm text-claude-subtext mt-1">
            {totalEntries} параметрів &middot; {dbOverrides} DB overrides
          </p>
        </div>
        <button
          onClick={fetchConfig}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-claude-border rounded-lg hover:bg-claude-bg transition-colors text-sm font-medium"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Оновити
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-6 max-w-md">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-claude-subtext" />
        <input
          type="text"
          placeholder="Пошук за назвою або описом..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 bg-white border border-claude-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent"
        />
      </div>

      {loading && Object.keys(categories).length === 0 ? (
        <div className="flex items-center justify-center py-20 text-claude-subtext">
          <RefreshCw size={20} className="animate-spin mr-2" />
          Завантаження...
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(filteredCategories).map(([catKey, group]) => (
            <div
              key={catKey}
              className="bg-white rounded-xl border border-claude-border shadow-sm p-6"
            >
              <h2 className="text-lg font-semibold text-claude-text mb-4">
                {group.label}
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-claude-subtext border-b border-claude-border">
                      <th className="pb-2 pr-4 font-medium">Key</th>
                      <th className="pb-2 pr-4 font-medium">Value</th>
                      <th className="pb-2 pr-4 font-medium w-20">Source</th>
                      <th className="pb-2 pr-4 font-medium">Default</th>
                      <th className="pb-2 font-medium w-24">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.entries.map((entry) => (
                      <tr
                        key={entry.key}
                        className="border-b border-claude-border/50 last:border-b-0"
                      >
                        {/* Key + Description */}
                        <td className="py-3 pr-4">
                          <div className="font-mono text-xs font-medium text-claude-text">
                            {entry.key}
                          </div>
                          <div className="text-xs text-claude-subtext mt-0.5">
                            {entry.description}
                          </div>
                        </td>

                        {/* Value */}
                        <td className="py-3 pr-4">
                          {editingKey === entry.key ? (
                            <div className="flex items-center gap-2">
                              {entry.value_type === 'boolean' ? (
                                <select
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  className="px-2 py-1 border border-claude-border rounded text-xs focus:outline-none focus:ring-1 focus:ring-claude-accent"
                                >
                                  <option value="true">true</option>
                                  <option value="false">false</option>
                                </select>
                              ) : entry.value_type === 'select' && entry.options ? (
                                <select
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  className="px-2 py-1 border border-claude-border rounded text-xs focus:outline-none focus:ring-1 focus:ring-claude-accent"
                                >
                                  {entry.options.map((opt) => (
                                    <option key={opt} value={opt}>
                                      {opt}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  type={entry.value_type === 'number' ? 'number' : 'text'}
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  className="px-2 py-1 border border-claude-border rounded text-xs w-48 focus:outline-none focus:ring-1 focus:ring-claude-accent font-mono"
                                />
                              )}
                              <button
                                onClick={() => handleSave(entry.key)}
                                disabled={saving}
                                className="p-1 text-green-600 hover:bg-green-50 rounded"
                                title="Save"
                              >
                                <Save size={14} />
                              </button>
                              <button
                                onClick={() => setEditingKey(null)}
                                className="p-1 text-claude-subtext hover:bg-claude-bg rounded"
                                title="Cancel"
                              >
                                <X size={14} />
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              {entry.is_secret && (
                                <Lock size={12} className="text-claude-subtext flex-shrink-0" />
                              )}
                              <span className="font-mono text-xs text-claude-text truncate max-w-[200px]">
                                {entry.value || '(empty)'}
                              </span>
                            </div>
                          )}
                        </td>

                        {/* Source */}
                        <td className="py-3 pr-4">
                          <span
                            className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${
                              SOURCE_BADGE[entry.source]?.className || ''
                            }`}
                          >
                            {SOURCE_BADGE[entry.source]?.label || entry.source}
                          </span>
                        </td>

                        {/* Default */}
                        <td className="py-3 pr-4">
                          <span className="font-mono text-xs text-claude-subtext truncate max-w-[150px] inline-block">
                            {entry.is_secret ? '********' : entry.default_value || '(empty)'}
                          </span>
                        </td>

                        {/* Actions */}
                        <td className="py-3">
                          {entry.is_secret ? (
                            <span className="text-[10px] text-claude-subtext">Read-only</span>
                          ) : editingKey === entry.key ? null : (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => startEditing(entry)}
                                className="p-1.5 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded transition-colors"
                                title="Edit"
                              >
                                <Edit3 size={13} />
                              </button>
                              {entry.source === 'database' && (
                                <button
                                  onClick={() => handleReset(entry.key)}
                                  className="p-1.5 text-orange-500 hover:text-orange-600 hover:bg-orange-50 rounded transition-colors"
                                  title="Reset to default"
                                >
                                  <RotateCcw size={13} />
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
