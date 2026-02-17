/**
 * Admin Users Page
 * User management with search, filters, tier/balance/limits actions
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  RefreshCw,
  Search,
  ChevronLeft,
  ChevronRight,
  XCircle,
  Users,
  X,
} from 'lucide-react';
import { api } from '../utils/api-client';
import toast from 'react-hot-toast';

interface UserRow {
  id: string;
  email: string;
  name?: string;
  created_at: string;
  balance_usd: number;
  pricing_tier: string;
  total_requests: number;
  total_spent_usd?: number;
  last_request_at: string | null;
}

interface UserDetail {
  user: any;
  transactions: any[];
  stats: {
    total_requests: number;
    total_spent: number;
    avg_cost: number;
    last_request: string | null;
  };
}

interface Pagination {
  limit: number;
  offset: number;
  total: number;
}

const TIERS = ['free', 'startup', 'business', 'enterprise', 'internal'];
const PAGE_SIZE = 20;

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'N/A';
  return d.toLocaleDateString('uk-UA', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AdminUsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ limit: PAGE_SIZE, offset: 0, total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');

  // Detail panel
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Action states
  const [tierAction, setTierAction] = useState<{ userId: string; tier: string } | null>(null);
  const [balanceAction, setBalanceAction] = useState<{
    userId: string;
    amount: string;
    reason: string;
  } | null>(null);
  const [limitsAction, setLimitsAction] = useState<{
    userId: string;
    daily: string;
    monthly: string;
  } | null>(null);

  const fetchUsers = useCallback(async (offset = 0) => {
    setLoading(true);
    setError(null);
    try {
      const params: any = { limit: PAGE_SIZE, offset };
      if (search) params.search = search;
      if (tierFilter) params.tier = tierFilter;
      const res = await api.admin.getUsers(params);
      setUsers(res.data.users || []);
      setPagination(res.data.pagination || { limit: PAGE_SIZE, offset, total: 0 });
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [search, tierFilter]);

  useEffect(() => {
    fetchUsers(0);
  }, [fetchUsers]);

  const handleSearch = () => {
    setSearch(searchInput);
  };

  const loadDetail = async (userId: string, forceReload = false) => {
    if (selectedUserId === userId && !forceReload) {
      setSelectedUserId(null);
      setDetail(null);
      return;
    }
    setSelectedUserId(userId);
    setDetailLoading(true);
    try {
      const res = await api.admin.getUser(userId);
      setDetail(res.data);
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleTierChange = async () => {
    if (!tierAction) return;
    try {
      await api.admin.updateUserTier(tierAction.userId, tierAction.tier);
      toast.success('Tier updated');
      setTierAction(null);
      fetchUsers(pagination.offset);
      if (selectedUserId === tierAction.userId) loadDetail(tierAction.userId, true);
    } catch {
      toast.error('Failed to update tier');
    }
  };

  const handleAdjustBalance = async () => {
    if (!balanceAction) return;
    const amount = parseFloat(balanceAction.amount);
    if (isNaN(amount) || !balanceAction.reason.trim()) {
      toast.error('Enter valid amount and reason');
      return;
    }
    try {
      await api.admin.adjustBalance(balanceAction.userId, amount, balanceAction.reason);
      toast.success('Balance adjusted');
      setBalanceAction(null);
      fetchUsers(pagination.offset);
      if (selectedUserId === balanceAction.userId) loadDetail(balanceAction.userId, true);
    } catch {
      toast.error('Failed to adjust balance');
    }
  };

  const handleUpdateLimits = async () => {
    if (!limitsAction) return;
    const limits: any = {};
    if (limitsAction.daily) limits.dailyLimitUsd = parseFloat(limitsAction.daily);
    if (limitsAction.monthly) limits.monthlyLimitUsd = parseFloat(limitsAction.monthly);
    try {
      await api.admin.updateLimits(limitsAction.userId, limits);
      toast.success('Limits updated');
      const userId = limitsAction.userId;
      setLimitsAction(null);
      fetchUsers(pagination.offset);
      if (selectedUserId === userId) loadDetail(userId, true);
    } catch {
      toast.error('Failed to update limits');
    }
  };

  const totalPages = Math.ceil(pagination.total / PAGE_SIZE);
  const currentPage = Math.floor(pagination.offset / PAGE_SIZE) + 1;

  if (error && users.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center">
          <XCircle size={32} className="text-red-500" />
          <p className="text-red-600">{error}</p>
          <button onClick={() => fetchUsers(0)} className="px-4 py-2 bg-claude-text text-white rounded-lg text-sm">
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-claude-text font-sans">User Management</h1>
          <p className="text-sm text-claude-subtext mt-1">{pagination.total} total users</p>
        </div>
        <button
          onClick={() => fetchUsers(pagination.offset)}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-claude-border rounded-lg text-sm text-claude-text hover:bg-claude-bg transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="flex items-center gap-2 flex-1 min-w-[200px] max-w-md">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-claude-subtext" />
            <input
              type="text"
              placeholder="Search by email or name..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="w-full pl-9 pr-3 py-2 border border-claude-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
          </div>
          <button onClick={handleSearch} className="px-3 py-2 bg-claude-text text-white rounded-lg text-sm">
            Search
          </button>
        </div>
        <select
          value={tierFilter}
          onChange={(e) => setTierFilter(e.target.value)}
          className="px-3 py-2 border border-claude-border rounded-lg text-sm bg-white focus:outline-none"
        >
          <option value="">All Tiers</option>
          {TIERS.map((t) => (
            <option key={t} value={t}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-claude-border shadow-sm overflow-hidden mb-4">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-claude-border bg-gray-50">
                <th className="text-left px-4 py-3 font-medium text-claude-subtext">Email</th>
                <th className="text-left px-4 py-3 font-medium text-claude-subtext">Tier</th>
                <th className="text-right px-4 py-3 font-medium text-claude-subtext">Balance</th>
                <th className="text-right px-4 py-3 font-medium text-claude-subtext">Requests</th>
                <th className="text-left px-4 py-3 font-medium text-claude-subtext">Last Active</th>
                <th className="text-left px-4 py-3 font-medium text-claude-subtext">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-claude-subtext">
                    <RefreshCw size={20} className="animate-spin inline-block mr-2" />
                    Loading...
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-claude-subtext">
                    No users found
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <React.Fragment key={u.id}>
                    <tr
                      className={`border-b border-claude-border/50 hover:bg-gray-50 cursor-pointer transition-colors ${
                        selectedUserId === u.id ? 'bg-blue-50' : ''
                      }`}
                      onClick={() => loadDetail(u.id)}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-claude-text">{u.email}</div>
                        {u.name && <div className="text-xs text-claude-subtext">{u.name}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 capitalize">
                          {u.pricing_tier}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        ${Number(u.balance_usd || 0).toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {(u.total_requests || 0).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-claude-subtext text-xs">
                        {formatDate(u.last_request_at)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() =>
                              setTierAction({ userId: u.id, tier: u.pricing_tier })
                            }
                            className="px-2 py-1 text-xs border border-claude-border rounded hover:bg-gray-100 transition-colors"
                          >
                            Tier
                          </button>
                          <button
                            onClick={() =>
                              setBalanceAction({ userId: u.id, amount: '', reason: '' })
                            }
                            className="px-2 py-1 text-xs border border-claude-border rounded hover:bg-gray-100 transition-colors"
                          >
                            Balance
                          </button>
                          <button
                            onClick={() =>
                              setLimitsAction({ userId: u.id, daily: '', monthly: '' })
                            }
                            className="px-2 py-1 text-xs border border-claude-border rounded hover:bg-gray-100 transition-colors"
                          >
                            Limits
                          </button>
                        </div>
                      </td>
                    </tr>

                    {/* Expanded detail row */}
                    {selectedUserId === u.id && (
                      <tr>
                        <td colSpan={6} className="bg-blue-50/50 px-4 py-4">
                          {detailLoading ? (
                            <div className="text-center py-4 text-claude-subtext">
                              <RefreshCw size={16} className="animate-spin inline-block mr-2" />
                              Loading details...
                            </div>
                          ) : detail ? (
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                              <div>
                                <div className="text-xs text-claude-subtext mb-1">Total Spent</div>
                                <div className="font-medium">${Number(detail.stats.total_spent || 0).toFixed(2)}</div>
                              </div>
                              <div>
                                <div className="text-xs text-claude-subtext mb-1">Avg Cost/Request</div>
                                <div className="font-medium">${Number(detail.stats.avg_cost || 0).toFixed(4)}</div>
                              </div>
                              <div>
                                <div className="text-xs text-claude-subtext mb-1">Total Requests</div>
                                <div className="font-medium">{(detail.stats.total_requests || 0).toLocaleString()}</div>
                              </div>
                              <div>
                                <div className="text-xs text-claude-subtext mb-1">Last Request</div>
                                <div className="font-medium text-xs">{formatDate(detail.stats.last_request)}</div>
                              </div>
                              {detail.transactions.length > 0 && (
                                <div className="col-span-full">
                                  <div className="text-xs text-claude-subtext mb-2">Recent Transactions</div>
                                  <div className="space-y-1">
                                    {detail.transactions.slice(0, 5).map((tx: any, i: number) => (
                                      <div key={i} className="flex items-center justify-between text-xs bg-white rounded px-3 py-1.5 border border-claude-border/50">
                                        <span className="text-claude-subtext">{tx.type}</span>
                                        <span className="font-mono">${Number(tx.amount_usd || 0).toFixed(4)}</span>
                                        <span className="text-claude-subtext">{formatDate(tx.created_at)}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          ) : (
                            <p className="text-claude-subtext text-sm">Could not load details</p>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-claude-subtext">
            Page {currentPage} of {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => fetchUsers(pagination.offset - PAGE_SIZE)}
              disabled={pagination.offset === 0}
              className="p-2 border border-claude-border rounded-lg hover:bg-gray-50 disabled:opacity-30 transition-colors"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => fetchUsers(pagination.offset + PAGE_SIZE)}
              disabled={pagination.offset + PAGE_SIZE >= pagination.total}
              className="p-2 border border-claude-border rounded-lg hover:bg-gray-50 disabled:opacity-30 transition-colors"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Tier Change Modal */}
      {tierAction && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setTierAction(null)}>
          <div className="bg-white rounded-xl border border-claude-border shadow-xl p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-claude-text">Change Pricing Tier</h3>
              <button onClick={() => setTierAction(null)} className="p-1 hover:bg-gray-100 rounded">
                <X size={16} />
              </button>
            </div>
            <select
              value={tierAction.tier}
              onChange={(e) => setTierAction({ ...tierAction, tier: e.target.value })}
              className="w-full px-3 py-2 border border-claude-border rounded-lg text-sm mb-4"
            >
              {TIERS.map((t) => (
                <option key={t} value={t}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
            <button onClick={handleTierChange} className="w-full px-4 py-2 bg-claude-text text-white rounded-lg text-sm">
              Update Tier
            </button>
          </div>
        </div>
      )}

      {/* Balance Adjust Modal */}
      {balanceAction && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setBalanceAction(null)}>
          <div className="bg-white rounded-xl border border-claude-border shadow-xl p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-claude-text">Adjust Balance</h3>
              <button onClick={() => setBalanceAction(null)} className="p-1 hover:bg-gray-100 rounded">
                <X size={16} />
              </button>
            </div>
            <input
              type="number"
              step="0.01"
              placeholder="Amount (negative to deduct)"
              value={balanceAction.amount}
              onChange={(e) => setBalanceAction({ ...balanceAction, amount: e.target.value })}
              className="w-full px-3 py-2 border border-claude-border rounded-lg text-sm mb-3"
            />
            <input
              type="text"
              placeholder="Reason"
              value={balanceAction.reason}
              onChange={(e) => setBalanceAction({ ...balanceAction, reason: e.target.value })}
              className="w-full px-3 py-2 border border-claude-border rounded-lg text-sm mb-4"
            />
            <button onClick={handleAdjustBalance} className="w-full px-4 py-2 bg-claude-text text-white rounded-lg text-sm">
              Adjust Balance
            </button>
          </div>
        </div>
      )}

      {/* Limits Modal */}
      {limitsAction && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setLimitsAction(null)}>
          <div className="bg-white rounded-xl border border-claude-border shadow-xl p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-claude-text">Update Limits</h3>
              <button onClick={() => setLimitsAction(null)} className="p-1 hover:bg-gray-100 rounded">
                <X size={16} />
              </button>
            </div>
            <label className="block text-xs text-claude-subtext mb-1">Daily Limit (USD)</label>
            <input
              type="number"
              step="0.01"
              placeholder="Leave empty to keep current"
              value={limitsAction.daily}
              onChange={(e) => setLimitsAction({ ...limitsAction, daily: e.target.value })}
              className="w-full px-3 py-2 border border-claude-border rounded-lg text-sm mb-3"
            />
            <label className="block text-xs text-claude-subtext mb-1">Monthly Limit (USD)</label>
            <input
              type="number"
              step="0.01"
              placeholder="Leave empty to keep current"
              value={limitsAction.monthly}
              onChange={(e) => setLimitsAction({ ...limitsAction, monthly: e.target.value })}
              className="w-full px-3 py-2 border border-claude-border rounded-lg text-sm mb-4"
            />
            <button onClick={handleUpdateLimits} className="w-full px-4 py-2 bg-claude-text text-white rounded-lg text-sm">
              Update Limits
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
