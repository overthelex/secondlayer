/**
 * Holds List
 * Reusable legal holds list component
 */

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Lock,
  Unlock,
  Plus,
  Shield,
  Clock,
  User,
  AlertCircle,
} from 'lucide-react';
import { useMatterHolds } from '../../hooks/queries/useMatters';
import { Spinner } from '../ui/Spinner';
import { CreateHoldModal } from './CreateHoldModal';
import { ReleaseHoldConfirmation } from './ReleaseHoldConfirmation';
import type { LegalHold } from '../../types/models/Matter';

const HOLD_TYPE_LABELS: Record<string, string> = {
  litigation: 'Судовий процес',
  regulatory: 'Регуляторне',
  investigation: 'Розслідування',
  preservation: 'Збереження',
};

const HOLD_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  active: { label: 'Активне', color: 'bg-red-100 text-red-700' },
  released: { label: 'Знято', color: 'bg-green-100 text-green-700' },
  expired: { label: 'Завершено', color: 'bg-gray-100 text-gray-600' },
};

interface HoldsListProps {
  matterId: string;
}

export function HoldsList({ matterId }: HoldsListProps) {
  const { data, isLoading, error } = useMatterHolds(matterId);
  const [showCreate, setShowCreate] = useState(false);
  const [releasingHold, setReleasingHold] = useState<LegalHold | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner size="md" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 font-sans text-sm">
        <AlertCircle size={18} />
        Помилка завантаження утримань
      </div>
    );
  }

  const holds = data?.holds || [];
  const activeHolds = holds.filter((h) => h.status === 'active');
  const releasedHolds = holds.filter((h) => h.status !== 'active');

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-serif text-claude-text">Утримання</h3>
          {activeHolds.length > 0 && (
            <span className="px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700 rounded-full">
              {activeHolds.length} активних
            </span>
          )}
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-3 py-2 bg-claude-accent text-white rounded-xl font-medium text-xs font-sans hover:bg-[#C66345] transition-colors shadow-sm"
        >
          <Plus size={14} />
          Створити утримання
        </button>
      </div>

      {/* Holds */}
      {holds.length === 0 ? (
        <div className="text-center py-8">
          <Shield size={24} className="mx-auto text-claude-subtext mb-2" />
          <p className="text-claude-subtext font-sans text-sm">Утримань немає</p>
        </div>
      ) : (
        <div className="space-y-3">
          {holds.map((hold, index) => {
            const statusConfig = HOLD_STATUS_CONFIG[hold.status] || HOLD_STATUS_CONFIG.active;
            return (
              <motion.div
                key={hold.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
                className="bg-white rounded-xl p-4 border border-claude-border shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <div className={`p-2 rounded-lg ${hold.status === 'active' ? 'bg-red-50 text-red-600' : 'bg-gray-50 text-gray-500'}`}>
                      {hold.status === 'active' ? <Lock size={16} /> : <Unlock size={16} />}
                    </div>
                    <div>
                      <h4 className="font-medium text-claude-text font-sans text-sm">{hold.hold_name}</h4>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusConfig.color}`}>
                          {statusConfig.label}
                        </span>
                        <span className="text-xs text-claude-subtext font-sans">
                          {HOLD_TYPE_LABELS[hold.hold_type] || hold.hold_type}
                        </span>
                      </div>
                      {hold.scope_description && (
                        <p className="text-xs text-claude-subtext font-sans mt-2">{hold.scope_description}</p>
                      )}
                      <div className="flex items-center gap-3 mt-2 text-xs text-claude-subtext font-sans">
                        <span className="flex items-center gap-1">
                          <Clock size={11} />
                          {new Date(hold.created_at).toLocaleDateString('uk-UA')}
                        </span>
                        {hold.custodians && hold.custodians.length > 0 && (
                          <span className="flex items-center gap-1">
                            <User size={11} />
                            {hold.custodians.length} відповідальних
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {hold.status === 'active' && (
                    <button
                      onClick={() => setReleasingHold(hold)}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium font-sans text-amber-700 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors"
                    >
                      <Unlock size={12} />
                      Зняти
                    </button>
                  )}
                </div>

                {hold.released_at && (
                  <div className="mt-3 pt-3 border-t border-claude-border/50 text-xs text-claude-subtext font-sans">
                    Знято: {new Date(hold.released_at).toLocaleDateString('uk-UA')}
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>
      )}

      {/* Create Hold Modal */}
      <CreateHoldModal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        matterId={matterId}
      />

      {/* Release Confirmation */}
      {releasingHold && (
        <ReleaseHoldConfirmation
          hold={releasingHold}
          matterId={matterId}
          onClose={() => setReleasingHold(null)}
        />
      )}
    </div>
  );
}
