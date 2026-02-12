/**
 * Create Time Entry Modal
 * Manual time entry creation form
 */

import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useCreateTimeEntry } from '../../hooks/queries';
import { useMatters } from '../../hooks/queries/useMatters';

interface CreateTimeEntryModalProps {
  isOpen: boolean;
  onClose: () => void;
  matterId?: string;
  matterName?: string;
}

export function CreateTimeEntryModal({
  isOpen,
  onClose,
  matterId: preselectedMatterId,
  matterName: preselectedMatterName,
}: CreateTimeEntryModalProps) {
  const createEntry = useCreateTimeEntry();
  const { data: mattersData } = useMatters({ limit: 100 });

  const [matterId, setMatterId] = useState(preselectedMatterId || '');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [hours, setHours] = useState('');
  const [minutes, setMinutes] = useState('');
  const [description, setDescription] = useState('');
  const [billable, setBillable] = useState(true);
  const [notes, setNotes] = useState('');

  const matters = mattersData?.matters || [];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!matterId || !description.trim()) return;

    const durationMinutes = parseInt(hours || '0') * 60 + parseInt(minutes || '0');
    if (durationMinutes <= 0) {
      alert('Duration must be greater than 0');
      return;
    }

    try {
      await createEntry.mutateAsync({
        matter_id: matterId,
        entry_date: date,
        duration_minutes: durationMinutes,
        description: description.trim(),
        billable,
        notes: notes.trim() || undefined,
      });
      handleClose();
    } catch (error) {
      // Error handled by mutation
      console.error('Failed to create time entry:', error);
    }
  };

  const handleClose = () => {
    setMatterId(preselectedMatterId || '');
    setDate(new Date().toISOString().split('T')[0]);
    setHours('');
    setMinutes('');
    setDescription('');
    setBillable(true);
    setNotes('');
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="New Time Entry" size="lg">
      <form onSubmit={handleSubmit} className="space-y-4 p-1">
        {/* Preselected Matter */}
        {preselectedMatterName && (
          <div className="p-3 bg-indigo-50 rounded-lg text-sm">
            <span className="text-gray-600">Matter:</span>{' '}
            <span className="font-medium text-gray-900">{preselectedMatterName}</span>
          </div>
        )}

        {/* Matter Selection (if not preselected) */}
        {!preselectedMatterId && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Matter <span className="text-red-500">*</span>
            </label>
            <select
              required
              value={matterId}
              onChange={(e) => setMatterId(e.target.value)}
              className="w-full px-3 py-2.5 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
            >
              <option value="">Select a matter...</option>
              {matters.map((matter) => (
                <option key={matter.id} value={matter.id}>
                  {matter.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Date */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Date <span className="text-red-500">*</span>
          </label>
          <input
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
            max={new Date().toISOString().split('T')[0]}
            className="w-full px-3 py-2.5 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
          />
        </div>

        {/* Duration */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Duration <span className="text-red-500">*</span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Hours</label>
              <input
                type="number"
                min="0"
                max="24"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                placeholder="0"
                className="w-full px-3 py-2.5 bg-white border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Minutes</label>
              <input
                type="number"
                min="0"
                max="59"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                placeholder="0"
                className="w-full px-3 py-2.5 bg-white border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
              />
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Total:{' '}
            {parseInt(hours || '0') * 60 + parseInt(minutes || '0')} minutes
            {parseInt(hours || '0') > 0 &&
              ` (${(parseInt(hours || '0') + parseInt(minutes || '0') / 60).toFixed(2)} hours)`}
          </p>
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Description <span className="text-red-500">*</span>
          </label>
          <textarea
            required
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What did you work on?"
            rows={3}
            className="w-full px-3 py-2.5 bg-white border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all resize-none"
          />
        </div>

        {/* Billable Toggle */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={billable}
              onChange={(e) => setBillable(e.target.checked)}
              className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-2 focus:ring-indigo-500"
            />
            <span className="text-sm font-medium text-gray-700">Billable</span>
          </label>
          <p className="text-xs text-gray-500 mt-1 ml-6">
            {billable
              ? 'This time will be charged to the client'
              : 'This time is non-billable'}
          </p>
        </div>

        {/* Notes */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Notes (optional)
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Additional notes or context"
            rows={2}
            className="w-full px-3 py-2.5 bg-white border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all resize-none"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-gray-200">
          <button
            type="button"
            onClick={handleClose}
            disabled={createEntry.isPending}
            className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createEntry.isPending || !matterId || !description.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {createEntry.isPending && <Loader2 size={16} className="animate-spin" />}
            Create Entry
          </button>
        </div>
      </form>
    </Modal>
  );
}
