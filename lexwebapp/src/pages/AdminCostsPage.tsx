/**
 * Admin Costs Page
 * API costs: tool usage analytics, transactions, refunds, cohort analysis
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  RefreshCw,
  XCircle,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  BarChart3,
  Users,
} from 'lucide-react';
import { api } from '../utils/api-client';
import toast from 'react-hot-toast';

interface ToolUsage {
  tool_name: string;
  request_count: number;
  total_revenue_usd: number;
  avg_cost_usd: number;
}

interface Transaction {
  id: string;
  user_id: string;
  user_email?: string;
  type: string;
  status: string;
  amount_usd: number;
  description?: string;
  created_at: string;
}

interface Cohort {
  month: string;
  users: number;
  active_users: number;
  total_revenue_usd: number;
  retention_rate: number;
}

interface Pagination {
  limit: number;
  offset: number;
  total: number;
}

const PAGE_SIZE = 20;

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'N/A';
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

export function AdminCostsPage() {
  const [usageDays, setUsageDays] = useState(30);
  const [toolUsage, setToolUsage] = useState<ToolUsage[]>([]);
  const [usageLoading, setUsageLoading] = useState(true);

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [txPagination, setTxPagination] = useState<Pagination>({ limit: PAGE_SIZE, offset: 0, total: 0 });
  const [txLoading, setTxLoading] = useState(true);
  const [txTypeFilter, setTxTypeFilter] = useState('');
  const [txStatusFilter, setTxStatusFilter] = useState('');

  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [cohortsLoading, setCohortsLoading] = useState(true);

  const [error, setError] = useState<string | null>(null);

  const fetchUsage = useCallback(async () => {
    setUsageLoading(true);
    try {
      const res = await api.admin.getUsageAnalytics(usageDays);
      setToolUsage(res.data?.usage || []);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setUsageLoading(false);
    }
  }, [usageDays]);

  const fetchTransactions = useCallback(async (offset = 0) => {
    setTxLoading(true);
    try {
      const params: any = { limit: PAGE_SIZE, offset };
      if (txTypeFilter) params.type = txTypeFilter;
      if (txStatusFilter) params.status = txStatusFilter;
      const res = await api.admin.getTransactions(params);
      setTransactions(res.data?.transactions || []);
      setTxPagination(res.data?.pagination || { limit: PAGE_SIZE, offset, total: 0 });
    } catch (err: any) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setTxLoading(false);
    }
  }, [txTypeFilter, txStatusFilter]);

  const fetchCohorts = async () => {
    setCohortsLoading(true);
    try {
      const res = await api.admin.getCohorts();
      setCohorts(res.data?.cohorts || []);
    } catch {
      // non-critical
    } finally {
      setCohortsLoading(false);
    }
  };

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  useEffect(() => {
    fetchTransactions(0);
  }, [fetchTransactions]);

  useEffect(() => {
    fetchCohorts();
  }, []);

  const handleRefund = async (txId: string) => {
    const reason = prompt('Refund reason:');
    if (!reason) return;
    try {
      await api.admin.refundTransaction(txId, reason);
      toast.success('Transaction refunded');
      fetchTransactions(txPagination.offset);
    } catch {
      toast.error('Failed to refund');
    }
  };

  const txTotalPages = Math.ceil(txPagination.total / PAGE_SIZE);
  const txCurrentPage = Math.floor(txPagination.offset / PAGE_SIZE) + 1;

  const totalRevenue = toolUsage.reduce((s, t) => s + t.total_revenue_usd, 0);
  const totalRequests = toolUsage.reduce((s, t) => s + t.request_count, 0);

  if (error && toolUsage.length === 0 && transactions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center">
          <XCircle size={32} className="text-red-500" />
          <p className="text-red-600">{error}</p>
          <button
            onClick={() => {
              setError(null);
              fetchUsage();
              fetchTransactions(0);
            }}
            className="px-4 py-2 bg-claude-text text-white rounded-lg text-sm"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-claude-text font-sans">API Costs & Analytics</h1>
          <p className="text-sm text-claude-subtext mt-1">
            Total: ${totalRevenue.toFixed(2)} revenue from {totalRequests.toLocaleString()} requests
          </p>
        </div>
      </div>

      {/* Tool Usage Section */}
      <section className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <BarChart3 size={18} className="text-claude-subtext" />
            <h2 className="text-lg font-semibold text-claude-text font-sans">Tool Usage</h2>
          </div>
          <select
            value={usageDays}
            onChange={(e) => setUsageDays(Number(e.target.value))}
            className="px-3 py-1.5 border border-claude-border rounded-lg text-sm bg-white"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>

        <div className="bg-white rounded-xl border border-claude-border shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-claude-border bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-claude-subtext">Tool</th>
                  <th className="text-right px-4 py-3 font-medium text-claude-subtext">Requests</th>
                  <th className="text-right px-4 py-3 font-medium text-claude-subtext">Revenue</th>
                  <th className="text-right px-4 py-3 font-medium text-claude-subtext">Avg Cost</th>
                  <th className="px-4 py-3 font-medium text-claude-subtext">Share</th>
                </tr>
              </thead>
              <tbody>
                {usageLoading ? (
                  <tr>
                    <td colSpan={5} className="text-center py-8 text-claude-subtext">
                      <RefreshCw size={20} className="animate-spin inline-block mr-2" />
                      Loading...
                    </td>
                  </tr>
                ) : toolUsage.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center py-8 text-claude-subtext">
                      No usage data
                    </td>
                  </tr>
                ) : (
                  toolUsage.map((t) => {
                    const pct = totalRequests > 0 ? (t.request_count / totalRequests) * 100 : 0;
                    return (
                      <tr key={t.tool_name} className="border-b border-claude-border/50 hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-claude-text font-mono text-xs">
                          {t.tool_name}
                        </td>
                        <td className="px-4 py-3 text-right">{t.request_count.toLocaleString()}</td>
                        <td className="px-4 py-3 text-right font-mono">${t.total_revenue_usd.toFixed(2)}</td>
                        <td className="px-4 py-3 text-right font-mono">${t.avg_cost_usd.toFixed(4)}</td>
                        <td className="px-4 py-3 w-32">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-blue-500 rounded-full"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-xs text-claude-subtext w-10 text-right">
                              {pct.toFixed(0)}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Transactions Section */}
      <section className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <DollarSign size={18} className="text-claude-subtext" />
            <h2 className="text-lg font-semibold text-claude-text font-sans">Transactions</h2>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={txTypeFilter}
              onChange={(e) => setTxTypeFilter(e.target.value)}
              className="px-3 py-1.5 border border-claude-border rounded-lg text-sm bg-white"
            >
              <option value="">All Types</option>
              <option value="charge">Charge</option>
              <option value="topup">Top-up</option>
              <option value="refund">Refund</option>
              <option value="adjustment">Adjustment</option>
            </select>
            <select
              value={txStatusFilter}
              onChange={(e) => setTxStatusFilter(e.target.value)}
              className="px-3 py-1.5 border border-claude-border rounded-lg text-sm bg-white"
            >
              <option value="">All Statuses</option>
              <option value="completed">Completed</option>
              <option value="pending">Pending</option>
              <option value="refunded">Refunded</option>
              <option value="failed">Failed</option>
            </select>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-claude-border shadow-sm overflow-hidden mb-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-claude-border bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-claude-subtext">Date</th>
                  <th className="text-left px-4 py-3 font-medium text-claude-subtext">User</th>
                  <th className="text-left px-4 py-3 font-medium text-claude-subtext">Type</th>
                  <th className="text-left px-4 py-3 font-medium text-claude-subtext">Status</th>
                  <th className="text-right px-4 py-3 font-medium text-claude-subtext">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-claude-subtext">Actions</th>
                </tr>
              </thead>
              <tbody>
                {txLoading ? (
                  <tr>
                    <td colSpan={6} className="text-center py-8 text-claude-subtext">
                      <RefreshCw size={20} className="animate-spin inline-block mr-2" />
                      Loading...
                    </td>
                  </tr>
                ) : transactions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-8 text-claude-subtext">
                      No transactions found
                    </td>
                  </tr>
                ) : (
                  transactions.map((tx) => (
                    <tr key={tx.id} className="border-b border-claude-border/50 hover:bg-gray-50">
                      <td className="px-4 py-3 text-xs text-claude-subtext">{formatDate(tx.created_at)}</td>
                      <td className="px-4 py-3 text-xs">{tx.user_email || tx.user_id?.slice(0, 8)}</td>
                      <td className="px-4 py-3">
                        <span className="capitalize text-xs">{tx.type}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                            tx.status === 'completed'
                              ? 'bg-green-50 text-green-700'
                              : tx.status === 'refunded'
                              ? 'bg-amber-50 text-amber-700'
                              : tx.status === 'failed'
                              ? 'bg-red-50 text-red-700'
                              : 'bg-gray-50 text-gray-700'
                          }`}
                        >
                          {tx.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono">${Number(tx.amount_usd || 0).toFixed(4)}</td>
                      <td className="px-4 py-3">
                        {tx.status === 'completed' && tx.type === 'charge' && (
                          <button
                            onClick={() => handleRefund(tx.id)}
                            className="px-2 py-1 text-xs border border-red-200 text-red-600 rounded hover:bg-red-50 transition-colors"
                          >
                            Refund
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Transactions Pagination */}
        {txTotalPages > 1 && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-claude-subtext">
              Page {txCurrentPage} of {txTotalPages}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => fetchTransactions(txPagination.offset - PAGE_SIZE)}
                disabled={txPagination.offset === 0}
                className="p-2 border border-claude-border rounded-lg hover:bg-gray-50 disabled:opacity-30 transition-colors"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                onClick={() => fetchTransactions(txPagination.offset + PAGE_SIZE)}
                disabled={txPagination.offset + PAGE_SIZE >= txPagination.total}
                className="p-2 border border-claude-border rounded-lg hover:bg-gray-50 disabled:opacity-30 transition-colors"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Cohort Analysis */}
      <section className="mb-8">
        <div className="flex items-center gap-2 mb-4">
          <Users size={18} className="text-claude-subtext" />
          <h2 className="text-lg font-semibold text-claude-text font-sans">Cohort Analysis</h2>
        </div>

        <div className="bg-white rounded-xl border border-claude-border shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-claude-border bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-claude-subtext">Month</th>
                  <th className="text-right px-4 py-3 font-medium text-claude-subtext">Signups</th>
                  <th className="text-right px-4 py-3 font-medium text-claude-subtext">Active</th>
                  <th className="text-right px-4 py-3 font-medium text-claude-subtext">Revenue</th>
                  <th className="px-4 py-3 font-medium text-claude-subtext">Retention</th>
                </tr>
              </thead>
              <tbody>
                {cohortsLoading ? (
                  <tr>
                    <td colSpan={5} className="text-center py-8 text-claude-subtext">
                      <RefreshCw size={20} className="animate-spin inline-block mr-2" />
                      Loading...
                    </td>
                  </tr>
                ) : cohorts.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center py-8 text-claude-subtext">
                      No cohort data
                    </td>
                  </tr>
                ) : (
                  cohorts.map((c) => (
                    <tr key={c.month} className="border-b border-claude-border/50 hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium">
                        {new Date(c.month + '-01').toLocaleDateString('en-US', {
                          month: 'short',
                          year: 'numeric',
                        })}
                      </td>
                      <td className="px-4 py-3 text-right">{c.users}</td>
                      <td className="px-4 py-3 text-right">{c.active_users}</td>
                      <td className="px-4 py-3 text-right font-mono">${c.total_revenue_usd.toFixed(2)}</td>
                      <td className="px-4 py-3 w-36">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-emerald-500 rounded-full"
                              style={{ width: `${c.retention_rate}%` }}
                            />
                          </div>
                          <span className="text-xs text-claude-subtext w-10 text-right">
                            {c.retention_rate.toFixed(0)}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
