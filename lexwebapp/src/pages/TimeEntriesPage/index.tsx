/**
 * Time Entries Page
 * List and manage time entries with filters and actions
 */

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Clock,
  Search,
  Filter,
  Calendar,
  DollarSign,
  CheckCircle,
  XCircle,
  AlertCircle,
  FileText,
  Plus,
  Edit3,
  Trash2,
  Send,
  Play,
} from 'lucide-react';
import { useTimeEntries, useDeleteTimeEntry, useSubmitTimeEntry } from '../../hooks/queries';
import { useTimerStore } from '../../stores';
import { Modal } from '../../components/ui/Modal';
import { Spinner } from '../../components/ui/Spinner';
import { CreateTimeEntryModal } from '../../components/time/CreateTimeEntryModal';
import { TimeEntry } from '../../types/models';

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  submitted: 'bg-blue-100 text-blue-700',
  approved: 'bg-green-100 text-green-700',
  invoiced: 'bg-purple-100 text-purple-700',
  rejected: 'bg-red-100 text-red-700',
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  draft: <Edit3 size={14} />,
  submitted: <Send size={14} />,
  approved: <CheckCircle size={14} />,
  invoiced: <FileText size={14} />,
  rejected: <XCircle size={14} />,
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
  invoiced: 'Invoiced',
  rejected: 'Rejected',
};

export function TimeEntriesPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [billableFilter, setBillableFilter] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<TimeEntry | null>(null);

  const { startTimer } = useTimerStore();

  // Build filters
  const filters = {
    status: statusFilter !== 'all' ? statusFilter : undefined,
    billable: billableFilter === 'billable' ? true : billableFilter === 'non-billable' ? false : undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
  };

  const { data, isLoading, error, refetch } = useTimeEntries(filters);
  const deleteEntry = useDeleteTimeEntry();
  const submitEntry = useSubmitTimeEntry();

  const entries = data?.entries || [];
  const total = data?.total || 0;

  const formatDuration = (minutes: number): string => {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours > 0) {
      return `${hours}h ${mins}m`;
    }
    return `${mins}m`;
  };

  const calculateAmount = (entry: TimeEntry): number => {
    const hours = entry.duration_minutes / 60;
    return hours * entry.hourly_rate_usd;
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this time entry?')) return;

    try {
      await deleteEntry.mutateAsync(id);
    } catch (err) {
      console.error('Failed to delete entry:', err);
    }
  };

  const handleSubmit = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await submitEntry.mutateAsync(id);
    } catch (err) {
      console.error('Failed to submit entry:', err);
    }
  };

  const handleStartTimer = async (matterId: string, description: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await startTimer(matterId, description);
    } catch (err) {
      console.error('Failed to start timer:', err);
    }
  };

  // Stats
  const stats = {
    total,
    draft: entries.filter((e) => e.status === 'draft').length,
    submitted: entries.filter((e) => e.status === 'submitted').length,
    approved: entries.filter((e) => e.status === 'approved').length,
    totalHours: entries.reduce((sum, e) => sum + e.duration_minutes, 0) / 60,
    totalAmount: entries.reduce((sum, e) => sum + calculateAmount(e), 0),
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Time Entries</h1>
              <p className="mt-1 text-sm text-gray-600">
                Track and manage your billable time
              </p>
            </div>
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
            >
              <Plus size={20} />
              New Entry
            </button>
          </div>

          {/* Stats Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
            <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-lg p-4">
              <div className="flex items-center gap-2 text-blue-700 mb-1">
                <Clock size={16} />
                <span className="text-sm font-medium">Total Hours</span>
              </div>
              <p className="text-2xl font-bold text-blue-900">
                {stats.totalHours.toFixed(1)}h
              </p>
            </div>

            <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-lg p-4">
              <div className="flex items-center gap-2 text-green-700 mb-1">
                <DollarSign size={16} />
                <span className="text-sm font-medium">Total Value</span>
              </div>
              <p className="text-2xl font-bold text-green-900">
                ${stats.totalAmount.toFixed(2)}
              </p>
            </div>

            <div className="bg-gradient-to-br from-amber-50 to-amber-100 rounded-lg p-4">
              <div className="flex items-center gap-2 text-amber-700 mb-1">
                <Edit3 size={16} />
                <span className="text-sm font-medium">Draft</span>
              </div>
              <p className="text-2xl font-bold text-amber-900">{stats.draft}</p>
            </div>

            <div className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-lg p-4">
              <div className="flex items-center gap-2 text-purple-700 mb-1">
                <CheckCircle size={16} />
                <span className="text-sm font-medium">Approved</span>
              </div>
              <p className="text-2xl font-bold text-purple-900">{stats.approved}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            {/* Status Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Status
              </label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              >
                <option value="all">All Status</option>
                <option value="draft">Draft</option>
                <option value="submitted">Submitted</option>
                <option value="approved">Approved</option>
                <option value="invoiced">Invoiced</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>

            {/* Billable Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Type
              </label>
              <select
                value={billableFilter}
                onChange={(e) => setBillableFilter(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              >
                <option value="all">All</option>
                <option value="billable">Billable Only</option>
                <option value="non-billable">Non-Billable</option>
              </select>
            </div>

            {/* Date From */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                From Date
              </label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>

            {/* Date To */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                To Date
              </label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>

            {/* Clear Filters */}
            <div className="flex items-end">
              <button
                onClick={() => {
                  setStatusFilter('all');
                  setBillableFilter('all');
                  setDateFrom('');
                  setDateTo('');
                }}
                className="w-full px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Clear Filters
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Entries List */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-8">
        {isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner size="lg" />
          </div>
        ) : error ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-2 text-red-700">
            <AlertCircle size={20} />
            <span>{(error as any).message || 'Failed to load time entries'}</span>
          </div>
        ) : entries.length === 0 ? (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
            <Clock size={48} className="mx-auto text-gray-400 mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              No time entries found
            </h3>
            <p className="text-gray-600 mb-4">
              Start tracking your time or adjust your filters
            </p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
            >
              <Plus size={20} />
              Create Time Entry
            </button>
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Date
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Matter
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Description
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Duration
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Rate
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Amount
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {entries.map((entry) => (
                    <motion.tr
                      key={entry.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="hover:bg-gray-50 transition-colors"
                    >
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {new Date(entry.entry_date).toLocaleDateString()}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900">
                        <div className="font-medium">{entry.matter_name || 'Unknown'}</div>
                        {entry.user_name && (
                          <div className="text-xs text-gray-500">{entry.user_name}</div>
                        )}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600 max-w-xs truncate">
                        {entry.description}
                        {!entry.billable && (
                          <span className="ml-2 text-xs text-gray-500">(non-billable)</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        {formatDuration(entry.duration_minutes)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        ${entry.hourly_rate_usd}/hr
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-gray-900">
                        ${calculateAmount(entry).toFixed(2)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            STATUS_COLORS[entry.status]
                          }`}
                        >
                          {STATUS_ICONS[entry.status]}
                          {STATUS_LABELS[entry.status]}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex items-center justify-end gap-2">
                          {entry.status === 'draft' && (
                            <>
                              <button
                                onClick={(e) => handleStartTimer(entry.matter_id, entry.description, e)}
                                className="p-1 text-indigo-600 hover:text-indigo-900 hover:bg-indigo-50 rounded"
                                title="Continue as timer"
                              >
                                <Play size={16} />
                              </button>
                              <button
                                onClick={(e) => handleSubmit(entry.id, e)}
                                className="p-1 text-blue-600 hover:text-blue-900 hover:bg-blue-50 rounded"
                                title="Submit for approval"
                              >
                                <Send size={16} />
                              </button>
                              <button
                                onClick={(e) => handleDelete(entry.id, e)}
                                className="p-1 text-red-600 hover:text-red-900 hover:bg-red-50 rounded"
                                title="Delete"
                              >
                                <Trash2 size={16} />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Create Entry Modal */}
      {showCreateModal && (
        <CreateTimeEntryModal
          isOpen={showCreateModal}
          onClose={() => setShowCreateModal(false)}
        />
      )}
    </div>
  );
}
