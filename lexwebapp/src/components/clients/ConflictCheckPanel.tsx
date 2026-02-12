/**
 * Conflict Check Panel
 * Run and display conflict check results for a client
 */

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Shield,
  Loader2,
  AlertTriangle,
  Link as LinkIcon,
} from 'lucide-react';
import { useConflictCheck } from '../../hooks/queries/useClients';
import type { ConflictResult } from '../../types/models/Matter';
import type { ConflictStatus } from '../../types/models/Client';

interface ConflictCheckPanelProps {
  clientId: string;
  conflictStatus: ConflictStatus;
  conflictCheckDate: string | null;
}

const STATUS_CONFIG: Record<ConflictStatus, { icon: React.ReactNode; label: string; color: string }> = {
  unchecked: { icon: <Shield size={20} />, label: 'Не перевірено', color: 'text-gray-500 bg-gray-50 border-gray-200' },
  clear: { icon: <ShieldCheck size={20} />, label: 'Конфліктів не виявлено', color: 'text-green-600 bg-green-50 border-green-200' },
  flagged: { icon: <ShieldAlert size={20} />, label: 'Потребує уваги', color: 'text-amber-600 bg-amber-50 border-amber-200' },
  conflicted: { icon: <ShieldX size={20} />, label: 'Виявлено конфлікт', color: 'text-red-600 bg-red-50 border-red-200' },
};

export function ConflictCheckPanel({ clientId, conflictStatus, conflictCheckDate }: ConflictCheckPanelProps) {
  const conflictCheck = useConflictCheck();
  const [result, setResult] = React.useState<ConflictResult | null>(null);

  const config = STATUS_CONFIG[conflictStatus];

  const handleRunCheck = async () => {
    try {
      const res = await conflictCheck.mutateAsync(clientId);
      setResult(res);
    } catch {
      // Error handled by mutation
    }
  };

  return (
    <div className="space-y-4">
      {/* Current Status */}
      <div className={`flex items-center gap-3 p-4 rounded-xl border ${config.color}`}>
        {config.icon}
        <div className="flex-1">
          <div className="font-medium font-sans text-sm">{config.label}</div>
          {conflictCheckDate && (
            <div className="text-xs opacity-70 font-sans mt-0.5">
              Остання перевірка: {new Date(conflictCheckDate).toLocaleDateString('uk-UA')}
            </div>
          )}
        </div>
      </div>

      {/* Run Check Button */}
      <button
        onClick={handleRunCheck}
        disabled={conflictCheck.isPending}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-claude-accent text-white rounded-xl font-medium text-sm font-sans hover:bg-[#C66345] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {conflictCheck.isPending ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <Shield size={16} />
        )}
        Перевірити конфлікти
      </button>

      {/* Results */}
      <AnimatePresence>
        {result && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-3"
          >
            {result.has_conflicts ? (
              <div className="p-4 bg-red-50 border border-red-200 rounded-xl">
                <div className="flex items-center gap-2 text-red-700 font-medium font-sans text-sm mb-3">
                  <AlertTriangle size={16} />
                  Виявлено {result.matches.length} потенційних конфліктів
                </div>
                <div className="space-y-2">
                  {result.matches.map((match, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-3 p-3 bg-white border border-red-100 rounded-lg"
                    >
                      <LinkIcon size={14} className="text-red-500 mt-0.5 flex-shrink-0" />
                      <div>
                        <div className="text-sm font-medium text-claude-text font-sans">
                          {match.matched_entity}
                        </div>
                        <div className="text-xs text-claude-subtext font-sans mt-0.5">
                          Тип: {match.type}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 p-4 bg-green-50 border border-green-200 rounded-xl text-green-700">
                <ShieldCheck size={20} />
                <div>
                  <div className="font-medium font-sans text-sm">Конфліктів не виявлено</div>
                  <div className="text-xs opacity-70 font-sans mt-0.5">
                    Перевірено: {new Date(result.checked_at).toLocaleString('uk-UA')}
                  </div>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
