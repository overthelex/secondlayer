/**
 * Invoices Tab
 * Displays invoice history with PDF download capability
 */

import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  FileText,
  Download,
  CheckCircle,
  Clock,
  AlertCircle,
  Calendar,
  DollarSign,
} from 'lucide-react';
import { format } from 'date-fns';
import { generateInvoicePDF, InvoiceData } from '../../utils/invoice-generator';
import { api } from '../../utils/api-client';
import showToast from '../../utils/toast';
import { useAuth } from '../../contexts/AuthContext';

export function InvoicesTab() {
  const [invoices, setInvoices] = useState<InvoiceData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { user } = useAuth();

  useEffect(() => {
    const fetchInvoices = async () => {
      try {
        const response = await api.billing.getInvoices({ limit: 50 });
        const data = response.data;

        const invoiceList: InvoiceData[] = (data.invoices || []).map((inv: any) => ({
          invoiceNumber: inv.invoiceNumber,
          date: new Date(inv.date),
          customerName: inv.customerName || user?.name || 'Customer',
          customerEmail: inv.customerEmail || user?.email || '',
          items: [{
            description: 'SecondLayer Account Top-Up',
            amount: inv.amount,
            currency: inv.currency,
          }],
          subtotal: inv.currency === 'UAH' ? inv.amount - inv.amount * 0.2 : inv.amount,
          tax: inv.currency === 'UAH' ? inv.amount * 0.2 : 0,
          total: inv.amount,
          currency: inv.currency,
          paymentMethod: inv.paymentMethod || 'Unknown',
          status: inv.status || 'paid',
        }));

        setInvoices(invoiceList);
      } catch (error) {
        console.error('Failed to load invoices:', error);
        showToast.error('Failed to load invoices');
      } finally {
        setIsLoading(false);
      }
    };

    fetchInvoices();
  }, [user]);

  const handleDownloadInvoice = async (invoice: InvoiceData) => {
    try {
      // Try backend PDF generation first
      const response = await api.billing.downloadInvoicePDF(invoice.invoiceNumber);
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `invoice_${invoice.invoiceNumber}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      showToast.success(`Invoice ${invoice.invoiceNumber} downloaded`);
    } catch {
      // Fall back to client-side PDF generation
      try {
        generateInvoicePDF(invoice);
        showToast.success(`Invoice ${invoice.invoiceNumber} downloaded`);
      } catch (error) {
        console.error('Failed to generate PDF:', error);
        showToast.error('Failed to generate invoice PDF');
      }
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'paid':
        return <CheckCircle size={18} className="text-green-600" />;
      case 'pending':
        return <Clock size={18} className="text-yellow-600" />;
      case 'overdue':
        return <AlertCircle size={18} className="text-red-600" />;
      default:
        return <FileText size={18} className="text-gray-600" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'paid':
        return 'text-green-600 bg-green-50';
      case 'pending':
        return 'text-yellow-600 bg-yellow-50';
      case 'overdue':
        return 'text-red-600 bg-red-50';
      default:
        return 'text-gray-600 bg-gray-50';
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <FileText size={48} className="text-claude-accent mx-auto mb-4 animate-pulse" />
          <p className="text-claude-subtext">Loading invoices...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white border border-claude-border rounded-xl p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-claude-subtext">Total Invoices</p>
              <p className="text-2xl font-bold text-claude-text mt-1">{invoices.length}</p>
            </div>
            <FileText size={32} className="text-claude-accent" />
          </div>
        </div>

        <div className="bg-white border border-claude-border rounded-xl p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-claude-subtext">Paid</p>
              <p className="text-2xl font-bold text-green-600 mt-1">
                {invoices.filter((i) => i.status === 'paid').length}
              </p>
            </div>
            <CheckCircle size={32} className="text-green-600" />
          </div>
        </div>

        <div className="bg-white border border-claude-border rounded-xl p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-claude-subtext">Pending</p>
              <p className="text-2xl font-bold text-yellow-600 mt-1">
                {invoices.filter((i) => i.status === 'pending').length}
              </p>
            </div>
            <Clock size={32} className="text-yellow-600" />
          </div>
        </div>
      </div>

      {invoices.length === 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <p className="text-sm text-blue-800">
            <strong>Note:</strong> Invoices are generated automatically for all top-up transactions.
            Top up your account to see invoices here.
          </p>
        </div>
      )}

      {/* Invoices List */}
      <div className="bg-white border border-claude-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-claude-bg border-b border-claude-border">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider">
                  Invoice
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider">
                  Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider">
                  Description
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-claude-subtext uppercase tracking-wider">
                  Amount
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-claude-subtext uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-center text-xs font-medium text-claude-subtext uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-claude-border">
              {invoices.map((invoice, index) => (
                <motion.tr
                  key={invoice.invoiceNumber}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.03 }}
                  className="hover:bg-claude-bg transition-colors">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <FileText size={18} className="text-claude-accent" />
                      <span className="text-sm font-medium text-claude-text">
                        {invoice.invoiceNumber}
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <Calendar size={16} className="text-claude-subtext" />
                      <div>
                        <div className="text-sm text-claude-text">
                          {format(invoice.date, 'MMM dd, yyyy')}
                        </div>
                        {invoice.dueDate && invoice.status === 'pending' && (
                          <div className="text-xs text-claude-subtext">
                            Due: {format(invoice.dueDate, 'MMM dd')}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm text-claude-text">
                      {invoice.items.map((item) => item.description).join(', ')}
                    </div>
                    <div className="text-xs text-claude-subtext">
                      via {invoice.paymentMethod}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    <div className="flex items-center justify-end gap-1">
                      <DollarSign size={14} className="text-claude-subtext" />
                      <span className="text-sm font-semibold text-claude-text">
                        {invoice.currency === 'USD' ? '$' : '₴'}
                        {(Number(invoice.total) || 0).toFixed(2)}
                      </span>
                    </div>
                    {invoice.currency === 'UAH' && (
                      <div className="text-xs text-claude-subtext">
                        +₴{(Number(invoice.tax) || 0).toFixed(2)} VAT
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      {getStatusIcon(invoice.status)}
                      <span
                        className={`px-2.5 py-1 rounded-full text-xs font-medium capitalize ${getStatusColor(
                          invoice.status
                        )}`}>
                        {invoice.status}
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-center">
                    <button
                      onClick={() => handleDownloadInvoice(invoice)}
                      className="inline-flex items-center gap-2 px-3 py-1.5 bg-claude-accent text-white rounded-lg hover:bg-opacity-90 transition-colors text-sm font-medium">
                      <Download size={14} />
                      PDF
                    </button>
                  </td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Help Text */}
      <div className="text-center text-sm text-claude-subtext">
        <p>
          Need help with an invoice?{' '}
          <a href="mailto:billing@legal.org.ua" className="text-claude-accent hover:underline">
            Contact Support
          </a>
        </p>
      </div>
    </div>
  );
}
