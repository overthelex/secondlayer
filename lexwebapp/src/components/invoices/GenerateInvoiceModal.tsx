/**
 * Generate Invoice Modal
 * Select unbilled time entries and generate invoice
 */

import React, { useState } from 'react';
import { Loader2, CheckCircle, DollarSign } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useGenerateInvoice } from '../../hooks/queries';
import { useTimeEntries } from '../../hooks/queries/useTimeEntries';
import { useMatters } from '../../hooks/queries/useMatters';
import { TimeEntry } from '../../types/models';

interface GenerateInvoiceModalProps {
  isOpen: boolean;
  onClose: () => void;
  matterId?: string;
}

export function GenerateInvoiceModal({
  isOpen,
  onClose,
  matterId: preselectedMatterId,
}: GenerateInvoiceModalProps) {
  const generateInvoice = useGenerateInvoice();
  const { data: mattersData } = useMatters({ limit: 100 });

  const [matterId, setMatterId] = useState(preselectedMatterId || '');
  const [selectedEntries, setSelectedEntries] = useState<Set<string>>(new Set());
  const [taxRate, setTaxRate] = useState('0');
  const [dueDays, setDueDays] = useState('30');
  const [notes, setNotes] = useState('');
  const [terms, setTerms] = useState('Payment due within 30 days');

  const matters = mattersData?.matters || [];

  // Fetch unbilled time entries for selected matter
  const { data: entriesData } = useTimeEntries({
    matter_id: matterId || undefined,
    status: 'approved',
  });

  const entries = (entriesData?.entries || []).filter((e) => !e.invoice_id);

  const toggleEntry = (id: string) => {
    const newSet = new Set(selectedEntries);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedEntries(newSet);
  };

  const toggleAll = () => {
    if (selectedEntries.size === entries.length) {
      setSelectedEntries(new Set());
    } else {
      setSelectedEntries(new Set(entries.map((e) => e.id)));
    }
  };

  const calculateAmount = (entry: TimeEntry): number => {
    const hours = entry.duration_minutes / 60;
    return hours * entry.hourly_rate_usd;
  };

  const selectedEntriesList = entries.filter((e) => selectedEntries.has(e.id));
  const subtotal = selectedEntriesList.reduce((sum, e) => sum + calculateAmount(e), 0);
  const tax = subtotal * parseFloat(taxRate || '0');
  const total = subtotal + tax;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!matterId || selectedEntries.size === 0) return;

    try {
      await generateInvoice.mutateAsync({
        matter_id: matterId,
        time_entry_ids: Array.from(selectedEntries),
        due_days: parseInt(dueDays),
        tax_rate: parseFloat(taxRate),
        notes: notes.trim() || undefined,
        terms: terms.trim() || undefined,
      });
      handleClose();
    } catch (error) {
      console.error('Failed to generate invoice:', error);
    }
  };

  const handleClose = () => {
    setMatterId(preselectedMatterId || '');
    setSelectedEntries(new Set());
    setTaxRate('0');
    setDueDays('30');
    setNotes('');
    setTerms('Payment due within 30 days');
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Generate Invoice" size="xl">
      <form onSubmit={handleSubmit} className="space-y-4 p-1">
        {/* Matter Selection */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Matter <span className="text-red-500">*</span>
          </label>
          <select
            required
            value={matterId}
            onChange={(e) => {
              setMatterId(e.target.value);
              setSelectedEntries(new Set());
            }}
            className="w-full px-3 py-2.5 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
          >
            <option value="">Select a matter...</option>
            {matters.map((matter) => (
              <option key={matter.id} value={matter.id}>
                {matter.matter_name}
              </option>
            ))}
          </select>
        </div>

        {/* Time Entries Selection */}
        {matterId && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700">
                Unbilled Time Entries ({entries.length})
              </label>
              {entries.length > 0 && (
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-sm text-indigo-600 hover:text-indigo-700"
                >
                  {selectedEntries.size === entries.length ? 'Deselect All' : 'Select All'}
                </button>
              )}
            </div>

            <div className="max-h-64 overflow-y-auto border border-gray-300 rounded-lg">
              {entries.length === 0 ? (
                <div className="p-8 text-center text-gray-500">
                  No unbilled time entries found for this matter
                </div>
              ) : (
                <div className="divide-y divide-gray-200">
                  {entries.map((entry) => (
                    <label
                      key={entry.id}
                      className="flex items-center gap-3 p-3 hover:bg-gray-50 cursor-pointer transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={selectedEntries.has(entry.id)}
                        onChange={() => toggleEntry(entry.id)}
                        className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-2 focus:ring-indigo-500"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-medium text-gray-900">
                            {new Date(entry.entry_date).toLocaleDateString()} -{' '}
                            {Math.floor(entry.duration_minutes / 60)}h {entry.duration_minutes % 60}m
                          </div>
                          <div className="text-sm font-semibold text-gray-900">
                            ${calculateAmount(entry).toFixed(2)}
                          </div>
                        </div>
                        <div className="text-xs text-gray-600 truncate mt-1">
                          {entry.description}
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          ${entry.hourly_rate_usd}/hr × {(entry.duration_minutes / 60).toFixed(2)}h
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {selectedEntries.size > 0 && (
              <div className="mt-2 text-sm text-gray-600">
                {selectedEntries.size} of {entries.length} entries selected
              </div>
            )}
          </div>
        )}

        {/* Invoice Details */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Due in Days
            </label>
            <input
              id="invoice-due-days"
              name="dueDays"
              type="number"
              min="1"
              max="365"
              value={dueDays}
              onChange={(e) => setDueDays(e.target.value)}
              className="w-full px-3 py-2.5 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Tax Rate (%)
            </label>
            <input
              id="invoice-tax-rate"
              name="taxRate"
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={taxRate}
              onChange={(e) => setTaxRate(e.target.value)}
              className="w-full px-3 py-2.5 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
            />
          </div>
        </div>

        {/* Payment Terms */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Payment Terms
          </label>
          <input
            type="text"
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
            placeholder="e.g., Payment due within 30 days"
            className="w-full px-3 py-2.5 bg-white border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
          />
        </div>

        {/* Notes */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Notes (optional)
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Additional notes for the client"
            rows={2}
            className="w-full px-3 py-2.5 bg-white border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all resize-none"
          />
        </div>

        {/* Invoice Summary */}
        {selectedEntries.size > 0 && (
          <div className="bg-indigo-50 rounded-lg p-4 space-y-2">
            <h4 className="font-semibold text-gray-900 mb-3">Invoice Summary</h4>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Subtotal:</span>
              <span className="font-medium text-gray-900">${subtotal.toFixed(2)}</span>
            </div>
            {parseFloat(taxRate) > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">Tax ({taxRate}%):</span>
                <span className="font-medium text-gray-900">${tax.toFixed(2)}</span>
              </div>
            )}
            <div className="flex justify-between text-base font-semibold pt-2 border-t border-indigo-200">
              <span className="text-gray-900">Total:</span>
              <span className="text-indigo-600">${total.toFixed(2)}</span>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-gray-200">
          <button
            type="button"
            onClick={handleClose}
            disabled={generateInvoice.isPending}
            className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={
              generateInvoice.isPending || !matterId || selectedEntries.size === 0
            }
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {generateInvoice.isPending && <Loader2 size={16} className="animate-spin" />}
            Generate Invoice
          </button>
        </div>
      </form>
    </Modal>
  );
}
