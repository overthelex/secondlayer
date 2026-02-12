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
      alert('Тривалість має бути більше 0');
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
    <Modal isOpen={isOpen} onClose={handleClose} title="Новий запис часу" size="lg">
      <form onSubmit={handleSubmit} className="space-y-4 p-1">
        {/* Preselected Matter */}
        {preselectedMatterName && (
          <div className="p-3 bg-claude-bg rounded-xl text-sm font-sans">
            <span className="text-claude-subtext">Справа:</span>{' '}
            <span className="font-medium text-claude-text">{preselectedMatterName}</span>
          </div>
        )}

        {/* Matter Selection */}
        {!preselectedMatterId && (
          <div>
            <label className="block text-sm font-medium text-claude-text font-sans mb-1">
              Справа <span className="text-red-500">*</span>
            </label>
            <select
              required
              value={matterId}
              onChange={(e) => setMatterId(e.target.value)}
              className="w-full px-3 py-2.5 bg-white border border-claude-border rounded-xl text-claude-text text-sm font-sans focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all"
            >
              <option value="">Оберіть справу...</option>
              {matters.map((matter) => (
                <option key={matter.id} value={matter.id}>
                  {matter.matter_name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Date */}
        <div>
          <label className="block text-sm font-medium text-claude-text font-sans mb-1">
            Дата <span className="text-red-500">*</span>
          </label>
          <input
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
            max={new Date().toISOString().split('T')[0]}
            className="w-full px-3 py-2.5 bg-white border border-claude-border rounded-xl text-claude-text text-sm font-sans focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all"
          />
        </div>

        {/* Duration */}
        <div>
          <label className="block text-sm font-medium text-claude-text font-sans mb-1">
            Тривалість <span className="text-red-500">*</span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-claude-subtext font-sans mb-1">Години</label>
              <input
                type="number"
                min="0"
                max="24"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                placeholder="0"
                className="w-full px-3 py-2.5 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 text-sm font-sans focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all"
              />
            </div>
            <div>
              <label className="block text-xs text-claude-subtext font-sans mb-1">Хвилини</label>
              <input
                type="number"
                min="0"
                max="59"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                placeholder="0"
                className="w-full px-3 py-2.5 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 text-sm font-sans focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all"
              />
            </div>
          </div>
          <p className="text-xs text-claude-subtext font-sans mt-1">
            Разом:{' '}
            {parseInt(hours || '0') * 60 + parseInt(minutes || '0')} хв
            {parseInt(hours || '0') > 0 &&
              ` (${(parseInt(hours || '0') + parseInt(minutes || '0') / 60).toFixed(2)} год)`}
          </p>
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-claude-text font-sans mb-1">
            Опис <span className="text-red-500">*</span>
          </label>
          <textarea
            required
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Опишіть виконану роботу"
            rows={3}
            className="w-full px-3 py-2.5 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 text-sm font-sans focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all resize-none"
          />
        </div>

        {/* Billable Toggle */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={billable}
              onChange={(e) => setBillable(e.target.checked)}
              className="w-4 h-4 text-claude-accent border-claude-border rounded focus:ring-2 focus:ring-claude-accent/20"
            />
            <span className="text-sm font-medium text-claude-text font-sans">Оплачуваний</span>
          </label>
          <p className="text-xs text-claude-subtext font-sans mt-1 ml-6">
            {billable
              ? 'Цей час буде включено у рахунок клієнта'
              : 'Цей час не підлягає оплаті'}
          </p>
        </div>

        {/* Notes */}
        <div>
          <label className="block text-sm font-medium text-claude-text font-sans mb-1">
            Примітки (необов'язково)
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Додаткові примітки або контекст"
            rows={2}
            className="w-full px-3 py-2.5 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 text-sm font-sans focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all resize-none"
          />
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={handleClose}
            disabled={createEntry.isPending}
            className="flex-1 px-4 py-2.5 bg-white border border-claude-border text-claude-text rounded-xl font-medium text-sm font-sans hover:bg-claude-bg transition-colors disabled:opacity-50"
          >
            Скасувати
          </button>
          <button
            type="submit"
            disabled={createEntry.isPending || !matterId || !description.trim()}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-claude-accent text-white rounded-xl font-medium text-sm font-sans hover:bg-[#C66345] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {createEntry.isPending && <Loader2 size={16} className="animate-spin" />}
            Створити
          </button>
        </div>
      </form>
    </Modal>
  );
}
