/**
 * Release Hold Confirmation Dialog
 */

import React from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useReleaseHold } from '../../hooks/queries/useMatters';
import type { LegalHold } from '../../types/models/Matter';

interface ReleaseHoldConfirmationProps {
  hold: LegalHold;
  matterId: string;
  onClose: () => void;
}

export function ReleaseHoldConfirmation({ hold, matterId, onClose }: ReleaseHoldConfirmationProps) {
  const releaseHold = useReleaseHold();

  const handleRelease = async () => {
    try {
      await releaseHold.mutateAsync({ holdId: hold.id, matterId });
      onClose();
    } catch {
      // Error handled by mutation
    }
  };

  return (
    <Modal isOpen={true} onClose={onClose} title="Зняти утримання" size="sm">
      <div className="space-y-4 p-1">
        <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
          <AlertTriangle size={20} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-800 font-sans">
              Ви впевнені, що хочете зняти утримання?
            </p>
            <p className="text-xs text-amber-700 font-sans mt-1">
              Утримання "{hold.hold_name}" буде знято. Документи, що знаходяться під цим
              утриманням, більше не будуть захищені від видалення.
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2.5 bg-white border border-claude-border text-claude-text rounded-xl font-medium text-sm font-sans hover:bg-claude-bg transition-colors"
          >
            Скасувати
          </button>
          <button
            onClick={handleRelease}
            disabled={releaseHold.isPending}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-600 text-white rounded-xl font-medium text-sm font-sans hover:bg-amber-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {releaseHold.isPending && <Loader2 size={16} className="animate-spin" />}
            Зняти утримання
          </button>
        </div>
      </div>
    </Modal>
  );
}
