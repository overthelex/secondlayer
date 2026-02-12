/**
 * Create Matter Modal
 * Used from both MattersPage and ClientDetailPage
 */

import React, { useState, useEffect } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useCreateMatter } from '../../hooks/queries/useMatters';
import { useClients } from '../../hooks/queries/useClients';
import type { MatterType } from '../../types/models/Matter';

interface CreateMatterModalProps {
  isOpen: boolean;
  onClose: () => void;
  clientId?: string;
  clientName?: string;
}

const MATTER_TYPES: { value: MatterType; label: string }[] = [
  { value: 'litigation', label: 'Судовий процес' },
  { value: 'advisory', label: 'Консультування' },
  { value: 'transactional', label: 'Транзакційна' },
  { value: 'regulatory', label: 'Регуляторна' },
  { value: 'arbitration', label: 'Арбітраж' },
  { value: 'other', label: 'Інше' },
];

export function CreateMatterModal({ isOpen, onClose, clientId: preselectedClientId, clientName }: CreateMatterModalProps) {
  const createMatter = useCreateMatter();
  const { data: clientsData, isLoading: clientsLoading } = useClients({ limit: 200 });

  const clients = clientsData?.clients || [];
  const hasClients = clients.length > 0;

  // If clientId is pre-selected (from ClientDetailPage), lock it; otherwise allow selection
  const isClientLocked = !!preselectedClientId && !!clientName;

  const [selectedClientId, setSelectedClientId] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<MatterType>('litigation');
  const [attorney, setAttorney] = useState('');
  const [opposingParty, setOpposingParty] = useState('');
  const [courtNumber, setCourtNumber] = useState('');
  const [courtName, setCourtName] = useState('');

  // Sync pre-selected clientId when modal opens or prop changes
  useEffect(() => {
    if (isOpen) {
      if (preselectedClientId) {
        setSelectedClientId(preselectedClientId);
      } else if (clients.length > 0 && !selectedClientId) {
        setSelectedClientId(clients[0].id);
      }
    }
  }, [isOpen, preselectedClientId, clients]);

  const effectiveClientId = isClientLocked ? preselectedClientId : selectedClientId;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !effectiveClientId) return;

    try {
      await createMatter.mutateAsync({
        clientId: effectiveClientId,
        matterName: name.trim(),
        matterType: type,
        responsibleAttorney: attorney.trim() || undefined,
        opposingParty: opposingParty.trim() || undefined,
        courtCaseNumber: courtNumber.trim() || undefined,
        courtName: courtName.trim() || undefined,
      });
      handleClose();
    } catch {
      // Error handled by mutation
    }
  };

  const handleClose = () => {
    setName('');
    setType('litigation');
    setAttorney('');
    setOpposingParty('');
    setCourtNumber('');
    setCourtName('');
    if (!isClientLocked) setSelectedClientId('');
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Нова справа" size="lg">
      <form onSubmit={handleSubmit} className="space-y-4 p-1">
        {/* No clients warning */}
        {!clientsLoading && !hasClients && (
          <div className="flex items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-sm font-sans">
            <AlertCircle size={18} className="flex-shrink-0" />
            <div>
              <span className="font-medium">Немає клієнтів.</span>{' '}
              Спочатку створіть клієнта на сторінці{' '}
              <a href="/clients" className="underline font-medium hover:no-underline">Клієнти</a>.
            </div>
          </div>
        )}

        {/* Client selector */}
        {isClientLocked ? (
          <div className="p-3 bg-claude-bg rounded-xl text-sm font-sans">
            <span className="text-claude-subtext">Клієнт:</span>{' '}
            <span className="font-medium text-claude-text">{clientName}</span>
          </div>
        ) : (
          <div>
            <label className="block text-sm font-medium text-claude-text font-sans mb-1">
              Клієнт <span className="text-red-500">*</span>
            </label>
            {clientsLoading ? (
              <div className="flex items-center gap-2 px-3 py-2.5 text-sm text-claude-subtext">
                <Loader2 size={14} className="animate-spin" />
                Завантаження...
              </div>
            ) : (
              <select
                value={selectedClientId}
                onChange={(e) => setSelectedClientId(e.target.value)}
                disabled={!hasClients}
                className="w-full px-3 py-2.5 bg-white border border-claude-border rounded-xl text-claude-text text-sm font-sans focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {!hasClients && <option value="">— Клієнтів не знайдено —</option>}
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.client_name}</option>
                ))}
              </select>
            )}
          </div>
        )}

        {/* Matter Name */}
        <div>
          <label className="block text-sm font-medium text-claude-text font-sans mb-1">
            Назва справи <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Наприклад: Спір щодо договору оренди"
            className="w-full px-3 py-2.5 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans text-sm"
          />
        </div>

        {/* Matter Type */}
        <div>
          <label className="block text-sm font-medium text-claude-text font-sans mb-1">
            Тип справи
          </label>
          <div className="grid grid-cols-3 gap-2">
            {MATTER_TYPES.map((mt) => (
              <button
                key={mt.value}
                type="button"
                onClick={() => setType(mt.value)}
                className={`px-3 py-2 rounded-xl text-xs font-sans font-medium transition-all ${
                  type === mt.value
                    ? 'bg-claude-accent text-white shadow-sm'
                    : 'bg-white text-claude-text border border-claude-border hover:bg-claude-bg'
                }`}
              >
                {mt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Responsible Attorney */}
        <div>
          <label className="block text-sm font-medium text-claude-text font-sans mb-1">
            Відповідальний адвокат
          </label>
          <input
            type="text"
            value={attorney}
            onChange={(e) => setAttorney(e.target.value)}
            placeholder="Прізвище Ім'я"
            className="w-full px-3 py-2.5 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans text-sm"
          />
        </div>

        {/* Opposing Party */}
        <div>
          <label className="block text-sm font-medium text-claude-text font-sans mb-1">
            Протилежна сторона
          </label>
          <input
            type="text"
            value={opposingParty}
            onChange={(e) => setOpposingParty(e.target.value)}
            placeholder="Назва або ПІБ"
            className="w-full px-3 py-2.5 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans text-sm"
          />
        </div>

        {/* Court Info */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-claude-text font-sans mb-1">
              Номер справи в суді
            </label>
            <input
              type="text"
              value={courtNumber}
              onChange={(e) => setCourtNumber(e.target.value)}
              placeholder="№ 910/1234/26"
              className="w-full px-3 py-2.5 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-claude-text font-sans mb-1">
              Назва суду
            </label>
            <input
              type="text"
              value={courtName}
              onChange={(e) => setCourtName(e.target.value)}
              placeholder="Господарський суд м. Києва"
              className="w-full px-3 py-2.5 bg-white border border-claude-border rounded-xl text-claude-text placeholder-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-accent/20 focus:border-claude-accent transition-all font-sans text-sm"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={handleClose}
            className="flex-1 px-4 py-2.5 bg-white border border-claude-border text-claude-text rounded-xl font-medium text-sm font-sans hover:bg-claude-bg transition-colors"
          >
            Скасувати
          </button>
          <button
            type="submit"
            disabled={createMatter.isPending || !name.trim() || !effectiveClientId}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-claude-accent text-white rounded-xl font-medium text-sm font-sans hover:bg-[#C66345] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {createMatter.isPending && <Loader2 size={16} className="animate-spin" />}
            Створити
          </button>
        </div>
      </form>
    </Modal>
  );
}
