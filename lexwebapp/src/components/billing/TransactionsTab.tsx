/**
 * Transactions Tab
 * Displays transaction history with filtering and pagination
 */

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Search,
  Filter,
  Download,
  RefreshCw,
  ArrowUpCircle,
  ArrowDownCircle,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { format } from 'date-fns';
import { api } from '../../utils/api-client';
import showToast from '../../utils/toast';

interface Transaction {
  id: string;
  created_at: string;
  type: 'charge' | 'topup' | 'refund' | 'adjustment';
  amount_usd: number;
  amount_uah: number;
  balance_after_usd: number;
  description: string;
  payment_provider?: string;
  payment_id?: string;
}

type FilterType = 'all' | 'charge' | 'topup' | 'refund' | 'adjustment';

export function TransactionsTab() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<FilterType>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(0);
  const [limit] = useState(50);

  const fetchTransactions = async () => {
    setIsLoading(true);
    try {
      const response = await api.billing.getHistory({
        limit,
        offset: page * limit,
        type: filter === 'all' ? undefined : filter,
      });
      setTransactions(response.data.transactions || []);
    } catch (error) {
      console.error('Failed to fetch transactions:', error);
      showToast.error('Не вдалося завантажити історію транзакцій');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTransactions();
  }, [page, filter]);

  const filteredTransactions = transactions.filter((t) =>
    t.description.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const exportToCSV = () => {
    const headers = ['Дата', 'Тип', 'Опис', 'Сума USD', 'Сума UAH', 'Баланс після', 'Провайдер'];
    const rows = filteredTransactions.map((t) => [
      format(new Date(t.created_at), 'yyyy-MM-dd HH:mm:ss'),
      t.type,
      t.description,
      Number(t.amount_usd || 0).toFixed(2),
      Number(t.amount_uah || 0).toFixed(2),
      Number(t.balance_after_usd || 0).toFixed(2),
      t.payment_provider || 'N/A',
    ]);

    const csv = [headers, ...rows].map((row) => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `transactions_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    link.click();
    URL.revokeObjectURL(url);

    showToast.success('Транзакції експортовано у CSV');
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'topup':
        return 'text-green-600 bg-green-50';
      case 'charge':
        return 'text-red-600 bg-red-50';
      case 'refund':
        return 'text-blue-600 bg-blue-50';
      case 'adjustment':
        return 'text-yellow-600 bg-yellow-50';
      default:
        return 'text-gray-600 bg-gray-50';
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'topup':
      case 'refund':
        return <ArrowDownCircle size={18} className="text-green-600" />;
      case 'charge':
        return <ArrowUpCircle size={18} className="text-red-600" />;
      default:
        return <ArrowUpCircle size={18} className="text-gray-600" />;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Controls */}
      <div className="bg-white border border-claude-border rounded-xl p-4">
        <div className="flex flex-col md:flex-row gap-4">
          {/* Search */}
          <div className="flex-1 relative">
            <Search
              size={18}
              className="absolute left-3 top-1/2 transform -translate-y-1/2 text-claude-subtext"
            />
            <input
              type="text"
              placeholder="Пошук транзакцій..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 border border-claude-border rounded-lg focus:outline-none focus:ring-2 focus:ring-claude-accent/20"
            />
          </div>

          {/* Filter */}
          <div className="relative">
            <Filter
              size={18}
              className="absolute left-3 top-1/2 transform -translate-y-1/2 text-claude-subtext"
            />
            <select
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value as FilterType);
                setPage(0);
              }}
              className="pl-10 pr-8 py-2.5 border border-claude-border rounded-lg focus:outline-none focus:ring-2 focus:ring-claude-accent/20 bg-white appearance-none cursor-pointer">
              <option value="all">Усі типи</option>
              <option value="charge">Списання</option>
              <option value="topup">Поповнення</option>
              <option value="refund">Повернення</option>
              <option value="adjustment">Коригування</option>
            </select>
          </div>

          {/* Export */}
          <button
            onClick={exportToCSV}
            className="flex items-center gap-2 px-4 py-2.5 bg-claude-accent text-white rounded-lg hover:bg-opacity-90 transition-colors whitespace-nowrap">
            <Download size={18} />
            Експорт CSV
          </button>

          {/* Refresh */}
          <button
            onClick={fetchTransactions}
            disabled={isLoading}
            className="p-2.5 border border-claude-border rounded-lg hover:bg-claude-bg transition-colors">
            <RefreshCw size={18} className={`text-claude-text ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Transactions Table */}
      <div className="bg-white border border-claude-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-claude-bg border-b border-claude-border">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider">
                  Дата і час
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider">
                  Тип
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider">
                  Опис
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-claude-subtext uppercase tracking-wider">
                  Сума
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-claude-subtext uppercase tracking-wider">
                  Баланс після
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider">
                  Провайдер
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-claude-border">
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center">
                    <RefreshCw size={32} className="text-claude-accent animate-spin mx-auto mb-2" />
                    <p className="text-claude-subtext">Завантаження транзакцій...</p>
                  </td>
                </tr>
              ) : filteredTransactions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center">
                    <p className="text-claude-subtext">Транзакцій не знайдено</p>
                  </td>
                </tr>
              ) : (
                filteredTransactions.map((transaction, index) => (
                  <motion.tr
                    key={transaction.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.03 }}
                    className="hover:bg-claude-bg transition-colors">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-claude-text">
                        {format(new Date(transaction.created_at), 'MMM dd, yyyy')}
                      </div>
                      <div className="text-xs text-claude-subtext">
                        {format(new Date(transaction.created_at), 'HH:mm:ss')}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        {getTypeIcon(transaction.type)}
                        <span
                          className={`px-2.5 py-1 rounded-full text-xs font-medium capitalize ${getTypeColor(
                            transaction.type
                          )}`}>
                          {transaction.type}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm text-claude-text max-w-md truncate">
                        {transaction.description}
                      </div>
                      {transaction.payment_id && (
                        <div className="text-xs text-claude-subtext mt-1">
                          ID: {transaction.payment_id.substring(0, 20)}...
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <div
                        className={`text-sm font-medium ${
                          transaction.type === 'charge' ? 'text-red-600' : 'text-green-600'
                        }`}>
                        {transaction.type === 'charge' ? '-' : '+'}$
                        {Math.abs(Number(transaction.amount_usd) || 0).toFixed(2)}
                      </div>
                      {Number(transaction.amount_uah) > 0 && (
                        <div className="text-xs text-claude-subtext">
                          ₴{Math.abs(Number(transaction.amount_uah) || 0).toFixed(2)}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <div className="text-sm text-claude-text font-medium">
                        ${(Number(transaction.balance_after_usd) || 0).toFixed(2)}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {transaction.payment_provider ? (
                        <span className="px-2.5 py-1 bg-claude-bg text-claude-text rounded text-xs font-medium capitalize">
                          {transaction.payment_provider}
                        </span>
                      ) : (
                        <span className="text-xs text-claude-subtext">—</span>
                      )}
                    </td>
                  </motion.tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {!isLoading && filteredTransactions.length > 0 && (
          <div className="px-6 py-4 border-t border-claude-border flex items-center justify-between">
            <p className="text-sm text-claude-subtext">
              Показано {page * limit + 1} — {Math.min((page + 1) * limit, filteredTransactions.length)} з{' '}
              {filteredTransactions.length} транзакцій
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(Math.max(0, page - 1))}
                disabled={page === 0}
                className="p-2 border border-claude-border rounded-lg hover:bg-claude-bg transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                <ChevronLeft size={18} />
              </button>
              <button
                onClick={() => setPage(page + 1)}
                disabled={(page + 1) * limit >= filteredTransactions.length}
                className="p-2 border border-claude-border rounded-lg hover:bg-claude-bg transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                <ChevronRight size={18} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
