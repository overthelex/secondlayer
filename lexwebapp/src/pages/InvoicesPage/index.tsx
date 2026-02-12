/**
 * Invoices Page
 * List and manage invoices with filters and actions
 */

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  FileText,
  Search,
  DollarSign,
  Download,
  Send,
  CheckCircle,
  Clock,
  XCircle,
  AlertCircle,
  Plus,
  Eye,
  Loader2,
} from 'lucide-react';
import { useInvoices, useDownloadInvoicePDF, useSendInvoice } from '../../hooks/queries';
import { GenerateInvoiceModal } from '../../components/invoices/GenerateInvoiceModal';
import { InvoiceDetailModal } from '../../components/invoices/InvoiceDetailModal';
import { Invoice } from '../../types/models';

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-claude-sidebar text-claude-subtext border border-claude-border',
  sent: 'bg-blue-50 text-blue-700 border border-blue-200',
  paid: 'bg-green-50 text-green-700 border border-green-200',
  overdue: 'bg-red-50 text-red-700 border border-red-200',
  cancelled: 'bg-claude-sidebar text-claude-subtext/60 border border-claude-border',
  void: 'bg-claude-sidebar text-claude-subtext/60 border border-claude-border',
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  draft: <FileText size={14} />,
  sent: <Send size={14} />,
  paid: <CheckCircle size={14} />,
  overdue: <Clock size={14} />,
  cancelled: <XCircle size={14} />,
  void: <XCircle size={14} />,
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'Чернетка',
  sent: 'Надіслано',
  paid: 'Оплачено',
  overdue: 'Прострочено',
  cancelled: 'Скасовано',
  void: 'Анульовано',
};

export function InvoicesPage() {
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);

  const filters = {
    status: statusFilter !== 'all' ? statusFilter : undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
  };

  const { data, isLoading, error } = useInvoices(filters);
  const downloadPDF = useDownloadInvoicePDF();
  const sendInvoice = useSendInvoice();

  const invoices = data?.invoices || [];
  const total = data?.total || 0;

  const handleDownloadPDF = async (invoice: Invoice, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await downloadPDF.mutateAsync({
        id: invoice.id,
        invoiceNumber: invoice.invoice_number,
      });
    } catch (err) {
      console.error('Failed to download PDF:', err);
    }
  };

  const handleSend = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Надіслати цей рахунок клієнту?')) return;
    try {
      await sendInvoice.mutateAsync(id);
    } catch (err) {
      console.error('Failed to send invoice:', err);
    }
  };

  const handleViewDetails = (invoice: Invoice) => {
    setSelectedInvoice(invoice);
  };

  const stats = {
    total,
    draft: invoices.filter((i) => i.status === 'draft').length,
    sent: invoices.filter((i) => i.status === 'sent').length,
    paid: invoices.filter((i) => i.status === 'paid').length,
    totalAmount: invoices.reduce((sum, i) => sum + Number(i.total_usd || 0), 0),
    paidAmount: invoices
      .filter((i) => i.status === 'paid')
      .reduce((sum, i) => sum + Number(i.total_usd || 0), 0),
    outstanding: invoices
      .filter((i) => ['sent', 'overdue'].includes(i.status))
      .reduce((sum, i) => sum + (Number(i.total_usd || 0) - Number(i.amount_paid_usd || 0)), 0),
  };

  return (
    <div className="flex-1 h-full overflow-y-auto bg-claude-bg p-4 md:p-8 lg:p-12 pb-32">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="space-y-6"
        >
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl md:text-4xl font-serif text-claude-text font-medium tracking-tight mb-2">
                Рахунки
              </h1>
              <p className="text-claude-subtext font-sans text-sm">
                Створення та управління рахунками клієнтів
              </p>
            </div>
            <button
              onClick={() => setShowGenerateModal(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-claude-accent text-white rounded-xl hover:bg-claude-accent/90 transition-colors font-sans text-sm shadow-sm"
            >
              <Plus size={18} />
              Створити рахунок
            </button>
          </div>

          {/* Stats Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-white rounded-xl border border-claude-border p-4">
              <div className="flex items-center gap-2 text-claude-subtext mb-2">
                <FileText size={16} />
                <span className="text-xs font-sans font-medium uppercase tracking-wide">Усього</span>
              </div>
              <p className="text-2xl font-serif font-medium text-claude-text">{stats.total}</p>
            </div>

            <div className="bg-white rounded-xl border border-claude-border p-4">
              <div className="flex items-center gap-2 text-claude-subtext mb-2">
                <DollarSign size={16} />
                <span className="text-xs font-sans font-medium uppercase tracking-wide">Виставлено</span>
              </div>
              <p className="text-2xl font-serif font-medium text-claude-text">
                ${stats.totalAmount.toFixed(2)}
              </p>
            </div>

            <div className="bg-white rounded-xl border border-claude-border p-4">
              <div className="flex items-center gap-2 text-green-600 mb-2">
                <CheckCircle size={16} />
                <span className="text-xs font-sans font-medium uppercase tracking-wide">Оплачено</span>
              </div>
              <p className="text-2xl font-serif font-medium text-green-700">
                ${stats.paidAmount.toFixed(2)}
              </p>
            </div>

            <div className="bg-white rounded-xl border border-claude-border p-4">
              <div className="flex items-center gap-2 text-amber-600 mb-2">
                <Clock size={16} />
                <span className="text-xs font-sans font-medium uppercase tracking-wide">Очікується</span>
              </div>
              <p className="text-2xl font-serif font-medium text-amber-700">
                ${stats.outstanding.toFixed(2)}
              </p>
            </div>
          </div>

          {/* Filters */}
          <div className="bg-white rounded-xl border border-claude-border p-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs font-sans font-medium text-claude-subtext mb-1.5 uppercase tracking-wide">
                  Статус
                </label>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="w-full px-3 py-2 bg-claude-bg border border-claude-border rounded-lg text-claude-text text-sm font-sans focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent"
                >
                  <option value="all">Усі статуси</option>
                  <option value="draft">Чернетка</option>
                  <option value="sent">Надіслано</option>
                  <option value="paid">Оплачено</option>
                  <option value="overdue">Прострочено</option>
                  <option value="cancelled">Скасовано</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-sans font-medium text-claude-subtext mb-1.5 uppercase tracking-wide">
                  Дата від
                </label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="w-full px-3 py-2 bg-claude-bg border border-claude-border rounded-lg text-claude-text text-sm font-sans focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent"
                />
              </div>

              <div>
                <label className="block text-xs font-sans font-medium text-claude-subtext mb-1.5 uppercase tracking-wide">
                  Дата до
                </label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="w-full px-3 py-2 bg-claude-bg border border-claude-border rounded-lg text-claude-text text-sm font-sans focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent"
                />
              </div>

              <div className="flex items-end">
                <button
                  onClick={() => {
                    setStatusFilter('all');
                    setDateFrom('');
                    setDateTo('');
                  }}
                  className="w-full px-4 py-2 text-claude-subtext bg-claude-bg border border-claude-border rounded-lg hover:text-claude-text hover:bg-claude-sidebar transition-colors text-sm font-sans"
                >
                  Скинути
                </button>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 text-claude-accent animate-spin" />
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-2 text-red-700 text-sm font-sans">
            <AlertCircle size={18} />
            <span>{(error as any).message || 'Не вдалося завантажити рахунки'}</span>
          </div>
        )}

        {/* Empty State */}
        {!isLoading && !error && invoices.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-16"
          >
            <div className="w-16 h-16 bg-claude-sidebar rounded-full flex items-center justify-center mx-auto mb-4">
              <FileText size={24} className="text-claude-subtext" />
            </div>
            <h3 className="text-lg font-serif text-claude-text mb-2">
              Рахунків не знайдено
            </h3>
            <p className="text-claude-subtext font-sans text-sm max-w-md mx-auto mb-4">
              Створіть перший рахунок на основі записів часу
            </p>
            <button
              onClick={() => setShowGenerateModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-claude-accent text-white rounded-xl hover:bg-claude-accent/90 transition-colors text-sm font-sans"
            >
              <Plus size={18} />
              Створити рахунок
            </button>
          </motion.div>
        )}

        {/* Invoices Table */}
        {!isLoading && !error && invoices.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
            className="bg-white rounded-xl border border-claude-border overflow-hidden shadow-sm"
          >
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-claude-sidebar border-b border-claude-border">
                  <tr>
                    <th className="px-5 py-3 text-left text-xs font-sans font-medium text-claude-subtext uppercase tracking-wide">
                      Рахунок №
                    </th>
                    <th className="px-5 py-3 text-left text-xs font-sans font-medium text-claude-subtext uppercase tracking-wide">
                      Клієнт / Справа
                    </th>
                    <th className="px-5 py-3 text-left text-xs font-sans font-medium text-claude-subtext uppercase tracking-wide">
                      Дата
                    </th>
                    <th className="px-5 py-3 text-left text-xs font-sans font-medium text-claude-subtext uppercase tracking-wide">
                      Термін оплати
                    </th>
                    <th className="px-5 py-3 text-left text-xs font-sans font-medium text-claude-subtext uppercase tracking-wide">
                      Сума
                    </th>
                    <th className="px-5 py-3 text-left text-xs font-sans font-medium text-claude-subtext uppercase tracking-wide">
                      Оплачено
                    </th>
                    <th className="px-5 py-3 text-left text-xs font-sans font-medium text-claude-subtext uppercase tracking-wide">
                      Статус
                    </th>
                    <th className="px-5 py-3 text-right text-xs font-sans font-medium text-claude-subtext uppercase tracking-wide">
                      Дії
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-claude-border">
                  {invoices.map((invoice, index) => (
                    <motion.tr
                      key={invoice.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: index * 0.03 }}
                      className="hover:bg-claude-bg/50 transition-colors cursor-pointer group"
                      onClick={() => handleViewDetails(invoice)}
                    >
                      <td className="px-5 py-4 whitespace-nowrap">
                        <span className="font-sans font-medium text-claude-text text-sm">
                          {invoice.invoice_number}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <div className="text-sm font-sans">
                          <div className="font-medium text-claude-text">
                            {invoice.client_name || 'Невідомо'}
                          </div>
                          <div className="text-claude-subtext text-xs">
                            {invoice.matter_name || 'Невідомо'}
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-4 whitespace-nowrap text-sm text-claude-subtext font-sans">
                        {new Date(invoice.issue_date).toLocaleDateString('uk-UA')}
                      </td>
                      <td className="px-5 py-4 whitespace-nowrap text-sm text-claude-subtext font-sans">
                        {new Date(invoice.due_date).toLocaleDateString('uk-UA')}
                      </td>
                      <td className="px-5 py-4 whitespace-nowrap text-sm font-sans font-medium text-claude-text">
                        ${Number(invoice.total_usd || 0).toFixed(2)}
                      </td>
                      <td className="px-5 py-4 whitespace-nowrap text-sm font-sans text-claude-subtext">
                        ${Number(invoice.amount_paid_usd || 0).toFixed(2)}
                      </td>
                      <td className="px-5 py-4 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-sans font-medium ${
                            STATUS_COLORS[invoice.status]
                          }`}
                        >
                          {STATUS_ICONS[invoice.status]}
                          {STATUS_LABELS[invoice.status]}
                        </span>
                      </td>
                      <td className="px-5 py-4 whitespace-nowrap text-right">
                        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleViewDetails(invoice);
                            }}
                            className="p-1.5 text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors"
                            title="Деталі"
                          >
                            <Eye size={16} />
                          </button>
                          <button
                            onClick={(e) => handleDownloadPDF(invoice, e)}
                            className="p-1.5 text-claude-subtext hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                            title="Завантажити PDF"
                          >
                            <Download size={16} />
                          </button>
                          {invoice.status === 'draft' && (
                            <button
                              onClick={(e) => handleSend(invoice.id, e)}
                              className="p-1.5 text-claude-subtext hover:text-green-600 hover:bg-green-50 rounded-lg transition-colors"
                              title="Надіслати клієнту"
                            >
                              <Send size={16} />
                            </button>
                          )}
                        </div>
                      </td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.div>
        )}
      </div>

      {/* Generate Invoice Modal */}
      {showGenerateModal && (
        <GenerateInvoiceModal
          isOpen={showGenerateModal}
          onClose={() => setShowGenerateModal(false)}
        />
      )}

      {/* Invoice Detail Modal */}
      {selectedInvoice && (
        <InvoiceDetailModal
          isOpen={!!selectedInvoice}
          onClose={() => setSelectedInvoice(null)}
          invoiceId={selectedInvoice.id}
        />
      )}
    </div>
  );
}
