/**
 * Audit Log Viewer
 * Timeline-style audit log with filters and chain validation
 */

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Clock,
  User,
  Filter,
  ShieldCheck,
  ShieldX,
  Loader2,
  ChevronDown,
  ChevronUp,
  FileText,
  Users,
  Briefcase,
  Lock,
  AlertCircle,
} from 'lucide-react';
import { useAuditLog, useValidateAuditChain } from '../../hooks/queries/useMatters';
import { Spinner } from '../ui/Spinner';
import type { AuditLogParams } from '../../services/api/MatterService';

// Ukrainian action labels
const ACTION_LABELS: Record<string, string> = {
  'client.create': 'Створено клієнта',
  'client.update': 'Оновлено клієнта',
  'client.delete': 'Видалено клієнта',
  'matter.create': 'Створено справу',
  'matter.update': 'Оновлено справу',
  'matter.close': 'Закрито справу',
  'matter.reopen': 'Відкрито справу повторно',
  'team.add': 'Додано учасника команди',
  'team.remove': 'Видалено учасника команди',
  'hold.create': 'Встановлено утримання',
  'hold.release': 'Знято утримання',
  'hold.add_documents': 'Додано документи до утримання',
  'document.upload': 'Завантажено документ',
  'document.delete': 'Видалено документ',
  'conflict_check.run': 'Перевірка конфліктів',
  'access.grant': 'Надано доступ',
  'access.revoke': 'Відкликано доступ',
};

const RESOURCE_ICONS: Record<string, React.ReactNode> = {
  client: <Users size={14} />,
  matter: <Briefcase size={14} />,
  document: <FileText size={14} />,
  hold: <Lock size={14} />,
  team: <Users size={14} />,
};

interface AuditLogViewerProps {
  resourceType?: string;
  resourceId?: string;
  compact?: boolean;
}

export function AuditLogViewer({ resourceType, resourceId, compact = false }: AuditLogViewerProps) {
  const [showFilters, setShowFilters] = useState(false);
  const [actionFilter, setActionFilter] = useState('');
  const [limit] = useState(compact ? 10 : 50);

  const params: AuditLogParams = {
    resourceType,
    resourceId,
    action: actionFilter || undefined,
    limit,
  };

  const { data, isLoading, error } = useAuditLog(params);
  const validateChain = useValidateAuditChain();

  const handleValidateChain = async () => {
    try {
      await validateChain.mutateAsync();
    } catch {
      // Error handled by mutation
    }
  };

  const getActionLabel = (action: string) => ACTION_LABELS[action] || action;
  const getResourceIcon = (type: string) => RESOURCE_ICONS[type] || <FileText size={14} />;

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
        Помилка завантаження аудит-логу
      </div>
    );
  }

  const entries = data?.entries || [];

  return (
    <div className="space-y-4">
      {/* Header with filters and validate */}
      {!compact && (
        <div className="flex items-center justify-between">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="flex items-center gap-2 px-3 py-2 text-sm font-sans text-claude-subtext hover:text-claude-text hover:bg-claude-bg rounded-lg transition-colors"
          >
            <Filter size={14} />
            Фільтри
            {showFilters ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>

          <button
            onClick={handleValidateChain}
            disabled={validateChain.isPending}
            className="flex items-center gap-2 px-3 py-2 text-sm font-sans font-medium text-claude-accent hover:bg-claude-accent/10 rounded-lg transition-colors disabled:opacity-50"
          >
            {validateChain.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <ShieldCheck size={14} />
            )}
            Перевірити ланцюжок
          </button>
        </div>
      )}

      {/* Validation Result */}
      {validateChain.data && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className={`flex items-center gap-3 p-3 rounded-xl border text-sm font-sans ${
            validateChain.data.valid
              ? 'bg-green-50 border-green-200 text-green-700'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          {validateChain.data.valid ? <ShieldCheck size={16} /> : <ShieldX size={16} />}
          {validateChain.data.message}
          {validateChain.data.checked > 0 && (
            <span className="ml-auto text-xs opacity-70">
              Перевірено: {validateChain.data.checked} записів
            </span>
          )}
        </motion.div>
      )}

      {/* Filters */}
      {showFilters && !compact && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="flex gap-2 flex-wrap"
        >
          {['', 'client', 'matter', 'hold', 'team', 'document'].map((type) => (
            <button
              key={type}
              onClick={() => setActionFilter(type ? `${type}.` : '')}
              className={`px-3 py-1.5 rounded-lg text-xs font-sans font-medium transition-all ${
                (type === '' && !actionFilter) || actionFilter.startsWith(type + '.')
                  ? 'bg-claude-accent text-white'
                  : 'bg-white text-claude-text border border-claude-border hover:bg-claude-bg'
              }`}
            >
              {type === '' ? 'Всі' : type === 'client' ? 'Клієнти' : type === 'matter' ? 'Справи' : type === 'hold' ? 'Утримання' : type === 'team' ? 'Команда' : 'Документи'}
            </button>
          ))}
        </motion.div>
      )}

      {/* Timeline */}
      {entries.length === 0 ? (
        <div className="text-center py-8">
          <Clock size={24} className="mx-auto text-claude-subtext mb-2" />
          <p className="text-claude-subtext font-sans text-sm">
            Записів не знайдено
          </p>
        </div>
      ) : (
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-[19px] top-0 bottom-0 w-px bg-claude-border" />

          <div className="space-y-1">
            {entries.map((entry, index) => (
              <motion.div
                key={entry.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.02 }}
                className="relative flex items-start gap-3 py-2.5 pl-1"
              >
                {/* Timeline dot */}
                <div className="relative z-10 w-[38px] flex-shrink-0 flex items-center justify-center">
                  <div className="w-7 h-7 rounded-full bg-white border-2 border-claude-border flex items-center justify-center text-claude-subtext">
                    {getResourceIcon(entry.resource_type)}
                  </div>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0 pb-2">
                  <div className="text-sm font-medium text-claude-text font-sans">
                    {getActionLabel(entry.action)}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-claude-subtext font-sans">
                    <span className="flex items-center gap-1">
                      <User size={11} />
                      {entry.user_name || entry.user_id.slice(0, 8)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock size={11} />
                      {new Date(entry.created_at).toLocaleString('uk-UA')}
                    </span>
                  </div>
                  {entry.details && Object.keys(entry.details).length > 0 && !compact && (
                    <div className="mt-1.5 text-xs text-claude-subtext/70 font-sans bg-claude-bg p-2 rounded-lg">
                      {Object.entries(entry.details).slice(0, 3).map(([key, val]) => (
                        <div key={key}>
                          <span className="font-medium">{key}:</span> {String(val)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {/* Total count */}
      {data && data.total > entries.length && (
        <div className="text-center text-xs text-claude-subtext font-sans pt-2">
          Показано {entries.length} з {data.total} записів
        </div>
      )}
    </div>
  );
}
