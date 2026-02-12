/**
 * Time Entries Page
 * List and manage time entries with filters and actions
 */

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Clock,
  Search,
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
  draft: 'Чернетка',
  submitted: 'Надіслано',
  approved: 'Затверджено',
  invoiced: 'Рахунок',
  rejected: 'Відхилено',
};

export function TimeEntriesPage() {
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [billableFilter, setBillableFilter] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);

  const { startTimer } = useTimerStore();

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
    if (hours > 0) return `${hours}г ${mins}хв`;
    return `${mins}хв`;
  };

  const calculateAmount = (entry: TimeEntry): number => {
    const hours = entry.duration_minutes / 60;
    return hours * entry.hourly_rate_usd;
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Видалити цей запис часу?')) return;
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

  const stats = {
    total,
    draft: entries.filter((e) => e.status === 'draft').length,
    approved: entries.filter((e) => e.status === 'approved').length,
    totalHours: entries.reduce((sum, e) => sum + e.duration_minutes, 0) / 60,
    totalAmount: entries.reduce((sum, e) => sum + calculateAmount(e), 0),
  };

  return (
    <div className="flex-1 h-full overflow-y-auto bg-claude-bg p-4 md:p-8 lg:p-12 pb-32">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="space-y-4"
        >
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl md:text-4xl font-serif text-claude-text font-medium tracking-tight mb-2">
                Облік часу
              </h1>
              <p className="text-claude-subtext font-sans text-sm">
                Відстеження та управління робочим часом
              </p>
            </div>

            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-claude-accent text-white rounded-xl font-medium text-sm font-sans hover:bg-[#C66345] transition-colors shadow-sm active:scale-[0.98]"
            >
              <Plus size={18} />
              Новий запис
            </button>
          </div>

          {/* Stats */}
          <div className="flex flex-wrap gap-3 text-sm font-sans">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-lg border border-claude-border shadow-sm">
              <Clock size={14} className="text-claude-subtext" />
              <span className="text-claude-subtext">Годин:</span>
              <span className="font-serif font-medium text-claude-text">{stats.totalHours.toFixed(1)}</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-lg border border-claude-border shadow-sm">
              <DollarSign size={14} className="text-claude-subtext" />
              <span className="text-claude-subtext">Сума:</span>
              <span className="font-serif font-medium text-claude-text">${stats.totalAmount.toFixed(2)}</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-lg border border-claude-border shadow-sm">
              <Edit3 size={14} className="text-claude-subtext" />
              <span className="text-claude-subtext">Чернетки:</span>
              <span className="font-serif font-medium text-claude-text">{stats.draft}</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-lg border border-claude-border shadow-sm">
              <CheckCircle size={14} className="text-claude-subtext" />
              <span className="text-claude-subtext">Затверджено:</span>
              <span className="font-serif font-medium text-claude-text">{stats.approved}</span>
            </div>
          </div>

          {/* Filters */}
          <div className="flex flex-col md:flex-row gap-3">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-2.5 bg-white border border-claude-border rounded-xl text-claude-text text-sm font-sans focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all"
            >
              <option value="all">Всі статуси</option>
              <option value="draft">Чернетка</option>
              <option value="submitted">Надіслано</option>
              <option value="approved">Затверджено</option>
              <option value="invoiced">Рахунок</option>
              <option value="rejected">Відхилено</option>
            </select>

            <select
              value={billableFilter}
              onChange={(e) => setBillableFilter(e.target.value)}
              className="px-3 py-2.5 bg-white border border-claude-border rounded-xl text-claude-text text-sm font-sans focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all"
            >
              <option value="all">Всі типи</option>
              <option value="billable">Оплачуваний</option>
              <option value="non-billable">Неоплачуваний</option>
            </select>

            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              placeholder="Від"
              className="px-3 py-2.5 bg-white border border-claude-border rounded-xl text-claude-text text-sm font-sans focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all"
            />

            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              placeholder="До"
              className="px-3 py-2.5 bg-white border border-claude-border rounded-xl text-claude-text text-sm font-sans focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all"
            />

            {(statusFilter !== 'all' || billableFilter !== 'all' || dateFrom || dateTo) && (
              <button
                onClick={() => { setStatusFilter('all'); setBillableFilter('all'); setDateFrom(''); setDateTo(''); }}
                className="px-4 py-2.5 bg-white border border-claude-border text-claude-subtext rounded-xl text-sm font-sans font-medium hover:bg-claude-bg transition-colors"
              >
                Скинути
              </button>
            )}
          </div>
        </motion.div>

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-16">
            <Spinner size="lg" />
          </div>
        )}

        {/* Error */}
        {error && !isLoading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700"
          >
            <AlertCircle size={20} />
            <span className="font-sans text-sm">Не вдалося завантажити записи часу</span>
            <button onClick={() => refetch()} className="ml-auto text-sm font-medium underline hover:no-underline">
              Спробувати знову
            </button>
          </motion.div>
        )}

        {/* Entries List — card-based layout */}
        {!isLoading && !error && (
          <div className="space-y-3">
            {entries.map((entry, index) => {
              const statusColor = STATUS_COLORS[entry.status] || STATUS_COLORS.draft;
              return (
                <motion.div
                  key={entry.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: index * 0.03 + 0.2 }}
                  className="group bg-white rounded-2xl p-5 border border-claude-border shadow-sm hover:shadow-md hover:border-claude-subtext/30 transition-all"
                >
                  <div className="flex items-start gap-4">
                    {/* Icon */}
                    <div className="w-10 h-10 rounded-lg bg-claude-bg flex items-center justify-center text-claude-subtext flex-shrink-0">
                      <Clock size={18} />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-4 mb-2">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-mono text-claude-subtext">
                              {new Date(entry.entry_date).toLocaleDateString('uk-UA')}
                            </span>
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${statusColor}`}>
                              {STATUS_ICONS[entry.status]}
                              {STATUS_LABELS[entry.status]}
                            </span>
                            {!entry.billable && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
                                неоплачуваний
                              </span>
                            )}
                          </div>
                          <h3 className="text-lg font-serif font-medium text-claude-text">
                            {entry.matter_name || 'Без справи'}
                          </h3>
                        </div>
                      </div>

                      {/* Description */}
                      <p className="text-sm text-claude-subtext font-sans mb-3 line-clamp-2">
                        {entry.description}
                      </p>

                      {/* Details row */}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div className="flex items-center gap-2 text-sm text-claude-subtext font-sans">
                          <Clock size={14} className="flex-shrink-0" />
                          <span className="font-medium text-claude-text">{formatDuration(entry.duration_minutes)}</span>
                        </div>
                        <div className="flex items-center gap-2 text-sm text-claude-subtext font-sans">
                          <DollarSign size={14} className="flex-shrink-0" />
                          <span>${entry.hourly_rate_usd}/год</span>
                        </div>
                        <div className="flex items-center gap-2 text-sm font-sans">
                          <span className="text-claude-subtext">Сума:</span>
                          <span className="font-serif font-medium text-claude-text">${calculateAmount(entry).toFixed(2)}</span>
                        </div>
                        {entry.user_name && (
                          <div className="flex items-center gap-2 text-sm text-claude-subtext font-sans truncate">
                            {entry.user_name}
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      {entry.status === 'draft' && (
                        <div className="flex items-center gap-2 mt-4 pt-4 border-t border-claude-border/50">
                          <div className="flex items-center gap-1 ml-auto">
                            <button
                              onClick={(e) => handleStartTimer(entry.matter_id, entry.description, e)}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium font-sans text-claude-accent hover:bg-claude-accent/10 rounded-lg transition-colors"
                              title="Продовжити як таймер"
                            >
                              <Play size={14} />
                              Таймер
                            </button>
                            <button
                              onClick={(e) => handleSubmit(entry.id, e)}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium font-sans text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                              title="Надіслати на затвердження"
                            >
                              <Send size={14} />
                              Надіслати
                            </button>
                            <button
                              onClick={(e) => handleDelete(entry.id, e)}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium font-sans text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                              title="Видалити"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !error && entries.length === 0 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-12">
            <div className="w-16 h-16 bg-claude-bg rounded-full flex items-center justify-center mx-auto mb-4 text-claude-subtext">
              <Clock size={24} />
            </div>
            <h3 className="text-lg font-serif text-claude-text mb-2">Записів часу не знайдено</h3>
            <p className="text-claude-subtext font-sans max-w-md mx-auto text-sm">
              {total === 0 ? 'Створіть перший запис для обліку робочого часу' : 'Спробуйте змінити фільтри'}
            </p>
            {total === 0 && (
              <button
                onClick={() => setShowCreateModal(true)}
                className="mt-4 inline-flex items-center gap-2 px-4 py-2.5 bg-claude-accent text-white rounded-xl font-medium text-sm font-sans hover:bg-[#C66345] transition-colors"
              >
                <Plus size={18} />
                Новий запис
              </button>
            )}
          </motion.div>
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
