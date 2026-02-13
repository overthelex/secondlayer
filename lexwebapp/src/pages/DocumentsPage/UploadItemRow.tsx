import React from 'react';
import { motion } from 'framer-motion';
import {
  CheckCircle,
  AlertCircle,
  Loader2,
  X,
  Pause,
  RotateCcw,
  XCircle,
  FileText,
  Image,
  Film,
  FileSpreadsheet,
} from 'lucide-react';
import type { UploadItem } from '../../services/upload/UploadManager';

const DOC_TYPE_LABELS: Record<string, string> = {
  contract: 'Договір',
  legislation: 'Законодавство',
  court_decision: 'Судове рішення',
  internal: 'Внутрішній',
  other: 'Інше',
};

const STATUS_LABELS: Record<string, string> = {
  queued: 'В черзі',
  initializing: 'Ініціалізація...',
  uploading: 'Завантаження...',
  assembling: 'Збирання файлу...',
  processing: 'Обробка...',
  completed: 'Готово',
  failed: 'Помилка',
  cancelled: 'Скасовано',
  paused: 'Пауза',
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return Image;
  if (mimeType.startsWith('video/')) return Film;
  if (
    mimeType.includes('spreadsheet') ||
    mimeType.includes('excel') ||
    mimeType === 'text/csv'
  )
    return FileSpreadsheet;
  return FileText;
}

interface UploadItemRowProps {
  item: UploadItem;
  onRemove: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDocTypeChange: (id: string, docType: string) => void;
}

export function UploadItemRow({
  item,
  onRemove,
  onCancel,
  onRetry,
  onDocTypeChange,
}: UploadItemRowProps) {
  const Icon = getFileIcon(item.mimeType);
  const isActive = ['initializing', 'uploading', 'assembling', 'processing'].includes(
    item.status
  );

  return (
    <div
      data-upload-active={isActive || undefined}
      className="flex items-center gap-3 px-5 py-2.5 hover:bg-claude-bg/50 transition-colors"
    >
      <div className="flex-shrink-0">
        {item.status === 'completed' ? (
          <CheckCircle size={16} className="text-green-500" />
        ) : item.status === 'failed' ? (
          <AlertCircle size={16} className="text-red-500" />
        ) : item.status === 'cancelled' ? (
          <XCircle size={16} className="text-gray-400" />
        ) : isActive ? (
          <Loader2 size={16} className="text-claude-accent animate-spin" />
        ) : item.status === 'paused' ? (
          <Pause size={16} className="text-amber-500" />
        ) : (
          <Icon size={16} className="text-claude-subtext/50" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-claude-text truncate font-sans">
            {item.relativePath || item.fileName}
          </span>
          <span className="text-[10px] text-claude-subtext/50 flex-shrink-0 font-sans">
            {formatFileSize(item.fileSize)}
          </span>
          {isActive && (
            <span className="text-[10px] text-claude-accent font-sans">
              {STATUS_LABELS[item.status] || item.status}
            </span>
          )}
        </div>
        {(isActive || item.status === 'paused') && (
          <div className="mt-1 h-1 bg-claude-border/30 rounded-full overflow-hidden">
            <motion.div
              className={`h-full rounded-full ${
                item.status === 'paused' ? 'bg-amber-400' : 'bg-claude-accent'
              }`}
              initial={{ width: 0 }}
              animate={{ width: `${item.progress * 100}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>
        )}
        {item.error && (
          <span className="text-[10px] text-red-500 font-sans">{item.error}</span>
        )}
      </div>

      {/* Per-item doc type selector (only for queued) */}
      {item.status === 'queued' && (
        <select
          value={item.docType}
          onChange={(e) => onDocTypeChange(item.id, e.target.value)}
          className="text-[10px] border border-claude-border rounded-md px-1.5 py-0.5 bg-white text-claude-text font-sans"
        >
          {(Object.keys(DOC_TYPE_LABELS) as string[]).map((t) => (
            <option key={t} value={t}>
              {DOC_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      )}

      {/* Action buttons */}
      {item.status === 'failed' && (
        <button
          onClick={() => onRetry(item.id)}
          className="p-1 text-amber-500 hover:text-amber-700 transition-colors"
          title="Повторити"
        >
          <RotateCcw size={14} />
        </button>
      )}
      {isActive && (
        <button
          onClick={() => onCancel(item.id)}
          className="p-1 text-claude-subtext/40 hover:text-red-500 transition-colors"
          title="Скасувати"
        >
          <XCircle size={14} />
        </button>
      )}
      {['queued', 'completed', 'failed', 'cancelled'].includes(item.status) && (
        <button
          onClick={() => onRemove(item.id)}
          className="p-1 text-claude-subtext/40 hover:text-red-500 transition-colors"
          title="Видалити"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
