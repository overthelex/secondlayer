/**
 * Invoice Detail Modal
 * View invoice details, line items, payments, and record payments
 */

import React, { useState } from 'react';
import { Loader2, Download, DollarSign, Calendar, FileText, CreditCard } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Spinner } from '../ui/Spinner';
import { useInvoice, useDownloadInvoicePDF, useRecordPayment } from '../../hooks/queries';

interface InvoiceDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  invoiceId: string;
}

export function InvoiceDetailModal({
  isOpen,
  onClose,
  invoiceId,
}: InvoiceDetailModalProps) {
  const { data: invoice, isLoading } = useInvoice(invoiceId);
  const downloadPDF = useDownloadInvoicePDF();
  const recordPayment = useRecordPayment();

  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);
  const [paymentMethod, setPaymentMethod] = useState('');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');

  if (isLoading || !invoice) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title="Invoice Details" size="xl">
        <div className="flex justify-center py-12">
          <Spinner size="lg" />
        </div>
      </Modal>
    );
  }

  const balance = invoice.total_usd - invoice.amount_paid_usd;

  const handleDownload = async () => {
    try {
      await downloadPDF.mutateAsync({
        id: invoice.id,
        invoiceNumber: invoice.invoice_number,
      });
    } catch (err) {
      console.error('Failed to download PDF:', err);
    }
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseFloat(paymentAmount);
    if (isNaN(amount) || amount <= 0) {
      alert('Please enter a valid payment amount');
      return;
    }

    try {
      await recordPayment.mutateAsync({
        id: invoice.id,
        params: {
          amount_usd: amount,
          payment_date: paymentDate,
          payment_method: paymentMethod.trim() || undefined,
          reference_number: paymentReference.trim() || undefined,
          notes: paymentNotes.trim() || undefined,
        },
      });

      // Reset form
      setShowPaymentForm(false);
      setPaymentAmount('');
      setPaymentDate(new Date().toISOString().split('T')[0]);
      setPaymentMethod('');
      setPaymentReference('');
      setPaymentNotes('');
    } catch (error) {
      console.error('Failed to record payment:', error);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Invoice Details" size="xl">
      <div className="space-y-6 p-1">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">
              {invoice.invoice_number}
            </h2>
            <p className="text-sm text-gray-600 mt-1">
              {invoice.client_name} • {invoice.matter_name}
            </p>
          </div>
          <button
            onClick={handleDownload}
            disabled={downloadPDF.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50"
          >
            {downloadPDF.isPending ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Download size={16} />
            )}
            Download PDF
          </button>
        </div>

        {/* Invoice Info */}
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex items-center gap-2 text-gray-600 mb-1">
              <Calendar size={16} />
              <span className="text-sm font-medium">Issue Date</span>
            </div>
            <p className="text-lg font-semibold text-gray-900">
              {new Date(invoice.issue_date).toLocaleDateString()}
            </p>
          </div>

          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex items-center gap-2 text-gray-600 mb-1">
              <Calendar size={16} />
              <span className="text-sm font-medium">Due Date</span>
            </div>
            <p className="text-lg font-semibold text-gray-900">
              {new Date(invoice.due_date).toLocaleDateString()}
            </p>
          </div>
        </div>

        {/* Line Items */}
        <div>
          <h3 className="text-lg font-semibold text-gray-900 mb-3">Line Items</h3>
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Description
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    Qty
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    Rate
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {invoice.line_items.map((item) => (
                  <tr key={item.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm text-gray-900">
                      {item.description}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 text-right">
                      {item.quantity.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 text-right">
                      ${item.unit_price_usd.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold text-gray-900 text-right">
                      ${item.amount_usd.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Totals */}
        <div className="bg-gray-50 rounded-lg p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">Subtotal:</span>
            <span className="font-medium text-gray-900">
              ${invoice.subtotal_usd.toFixed(2)}
            </span>
          </div>
          {invoice.tax_rate > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">
                Tax ({(invoice.tax_rate * 100).toFixed(2)}%):
              </span>
              <span className="font-medium text-gray-900">
                ${invoice.tax_amount_usd.toFixed(2)}
              </span>
            </div>
          )}
          <div className="flex justify-between text-base font-semibold pt-2 border-t border-gray-300">
            <span className="text-gray-900">Total:</span>
            <span className="text-gray-900">${invoice.total_usd.toFixed(2)}</span>
          </div>
          {invoice.amount_paid_usd > 0 && (
            <>
              <div className="flex justify-between text-sm text-green-600">
                <span>Amount Paid:</span>
                <span className="font-medium">-${invoice.amount_paid_usd.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-base font-semibold pt-2 border-t border-gray-300">
                <span className="text-gray-900">Balance Due:</span>
                <span className={balance > 0 ? 'text-red-600' : 'text-green-600'}>
                  ${balance.toFixed(2)}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Payments */}
        {invoice.payments.length > 0 && (
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-3">Payment History</h3>
            <div className="space-y-2">
              {invoice.payments.map((payment) => (
                <div
                  key={payment.id}
                  className="flex items-center justify-between bg-green-50 border border-green-200 rounded-lg p-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-green-100 rounded-lg">
                      <CreditCard size={16} className="text-green-600" />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-gray-900">
                        ${payment.amount_usd.toFixed(2)}
                      </div>
                      <div className="text-xs text-gray-600">
                        {new Date(payment.payment_date).toLocaleDateString()}
                        {payment.payment_method && ` • ${payment.payment_method}`}
                        {payment.reference_number && ` • Ref: ${payment.reference_number}`}
                      </div>
                      {payment.notes && (
                        <div className="text-xs text-gray-500 mt-1">{payment.notes}</div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Record Payment */}
        {balance > 0 && (
          <div>
            {!showPaymentForm ? (
              <button
                onClick={() => setShowPaymentForm(true)}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
              >
                <DollarSign size={20} />
                Record Payment
              </button>
            ) : (
              <div className="bg-gray-50 rounded-lg p-4">
                <h4 className="font-semibold text-gray-900 mb-3">Record Payment</h4>
                <form onSubmit={handleRecordPayment} className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Amount <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="number"
                        required
                        min="0.01"
                        max={balance}
                        step="0.01"
                        value={paymentAmount}
                        onChange={(e) => setPaymentAmount(e.target.value)}
                        placeholder={`Max: $${balance.toFixed(2)}`}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Payment Date
                      </label>
                      <input
                        type="date"
                        value={paymentDate}
                        onChange={(e) => setPaymentDate(e.target.value)}
                        max={new Date().toISOString().split('T')[0]}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Payment Method
                      </label>
                      <input
                        type="text"
                        value={paymentMethod}
                        onChange={(e) => setPaymentMethod(e.target.value)}
                        placeholder="e.g., Credit Card, Wire Transfer"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Reference Number
                      </label>
                      <input
                        type="text"
                        value={paymentReference}
                        onChange={(e) => setPaymentReference(e.target.value)}
                        placeholder="Transaction ID"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Notes
                    </label>
                    <textarea
                      value={paymentNotes}
                      onChange={(e) => setPaymentNotes(e.target.value)}
                      placeholder="Additional notes"
                      rows={2}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent resize-none"
                    />
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setShowPaymentForm(false)}
                      className="flex-1 px-4 py-2 text-gray-700 hover:bg-gray-200 rounded-lg transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={recordPayment.isPending}
                      className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50"
                    >
                      {recordPayment.isPending && (
                        <Loader2 size={16} className="animate-spin" />
                      )}
                      Record Payment
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>
        )}

        {/* Terms and Notes */}
        {(invoice.terms || invoice.notes) && (
          <div className="space-y-3">
            {invoice.terms && (
              <div>
                <h4 className="text-sm font-semibold text-gray-700 mb-1">Payment Terms</h4>
                <p className="text-sm text-gray-600">{invoice.terms}</p>
              </div>
            )}
            {invoice.notes && (
              <div>
                <h4 className="text-sm font-semibold text-gray-700 mb-1">Notes</h4>
                <p className="text-sm text-gray-600">{invoice.notes}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
