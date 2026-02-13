import React, { useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Upload,
  X,
  ChevronDown,
  Tag,
  Pause,
  Play,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { useUploadStore } from '../../stores/uploadStore';
import { UploadItemRow } from './UploadItemRow';

type DocType = 'contract' | 'legislation' | 'court_decision' | 'internal' | 'other';

const DOC_TYPE_LABELS: Record<DocType, string> = {
  contract: 'Договір',
  legislation: 'Законодавство',
  court_decision: 'Судове рішення',
  internal: 'Внутрішній',
  other: 'Інше',
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface UploadQueuePanelProps {
  showUploadPanel: boolean;
  setShowUploadPanel: (show: boolean) => void;
  defaultDocType: DocType;
  setDefaultDocType: (type: DocType) => void;
  onStartUpload: () => void;
}

export function UploadQueuePanel({
  showUploadPanel,
  setShowUploadPanel,
  defaultDocType,
  setDefaultDocType,
  onStartUpload,
}: UploadQueuePanelProps) {
  const {
    items: uploadItems,
    isUploading,
    isPaused,
    totalFiles,
    completedFiles,
    failedFiles,
    totalBytes,
    uploadedBytes,
    concurrency,
    pauseUpload,
    resumeUpload,
    cancelFile,
    cancelAll,
    retryFile,
    retryAllFailed,
    removeFile,
    clearFinished,
    updateDocType,
    updateAllDocTypes,
    setConcurrency,
  } = useUploadStore();

  const [showTypeDropdown, setShowTypeDropdown] = React.useState(false);
  const uploadQueueRef = useRef<HTMLDivElement>(null);

  // Auto-scroll upload queue to the first active item
  useEffect(() => {
    if (!isUploading || !uploadQueueRef.current) return;
    const activeEl = uploadQueueRef.current.querySelector('[data-upload-active="true"]');
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [uploadItems, isUploading]);

  const queuedCount = uploadItems.filter((i) => i.status === 'queued').length;
  const activeCount = uploadItems.filter((i) =>
    ['initializing', 'uploading', 'assembling', 'processing'].includes(i.status)
  ).length;
  const doneCount = completedFiles;
  const errorCount = failedFiles;
  const globalProgress = totalBytes > 0 ? uploadedBytes / totalBytes : 0;

  return (
    <AnimatePresence>
      {showUploadPanel && uploadItems.length > 0 && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="mb-6 bg-white rounded-2xl border border-claude-border shadow-sm overflow-hidden"
        >
          {/* Queue header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-claude-border/50">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold text-claude-text font-sans">
                Черга завантаження
              </h3>
              <span className="text-xs text-claude-subtext/60 font-sans">
                {totalFiles} файлів
                {doneCount > 0 && ` · ${doneCount} готово`}
                {errorCount > 0 && ` · ${errorCount} помилок`}
                {activeCount > 0 && ` · ${activeCount} активних`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {/* Concurrent uploads selector */}
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-claude-subtext/50 font-sans">Потоки:</span>
                <select
                  value={concurrency}
                  onChange={(e) => setConcurrency(Number(e.target.value))}
                  className="text-xs border border-claude-border rounded-lg px-2 py-1.5 bg-white text-claude-text font-sans focus:outline-none focus:border-claude-subtext/40"
                >
                  {[1, 2, 3, 5, 8, 10, 15, 20, 30, 50, 100].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>

              {/* Default doc type selector */}
              <div className="relative">
                <button
                  onClick={() => setShowTypeDropdown(!showTypeDropdown)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-claude-border rounded-lg hover:bg-claude-bg transition-colors font-sans"
                >
                  <Tag size={12} />
                  {DOC_TYPE_LABELS[defaultDocType]}
                  <ChevronDown size={12} />
                </button>
                <AnimatePresence>
                  {showTypeDropdown && (
                    <motion.div
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      className="absolute right-0 top-full mt-1 bg-white border border-claude-border rounded-xl shadow-lg z-20 py-1 min-w-[160px]"
                    >
                      {(Object.keys(DOC_TYPE_LABELS) as DocType[]).map((t) => (
                        <button
                          key={t}
                          onClick={() => {
                            setDefaultDocType(t);
                            updateAllDocTypes(t);
                            setShowTypeDropdown(false);
                          }}
                          className={`w-full text-left px-3 py-2 text-xs font-medium hover:bg-claude-bg transition-colors font-sans ${
                            defaultDocType === t ? 'text-claude-accent' : 'text-claude-text'
                          }`}
                        >
                          {DOC_TYPE_LABELS[t]}
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Pause/Resume */}
              {isUploading && (
                <button
                  onClick={isPaused ? resumeUpload : pauseUpload}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium border border-claude-border rounded-lg hover:bg-claude-bg transition-colors font-sans"
                  title={isPaused ? 'Продовжити' : 'Пауза'}
                >
                  {isPaused ? <Play size={12} /> : <Pause size={12} />}
                  {isPaused ? 'Продовжити' : 'Пауза'}
                </button>
              )}

              {/* Retry all failed */}
              {errorCount > 0 && !isUploading && (
                <button
                  onClick={retryAllFailed}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-amber-700 border border-amber-200 rounded-lg hover:bg-amber-50 transition-colors font-sans"
                >
                  <RotateCcw size={12} />
                  Повторити ({errorCount})
                </button>
              )}

              {doneCount > 0 && (
                <button
                  onClick={clearFinished}
                  className="text-xs text-claude-subtext hover:text-claude-text transition-colors font-sans"
                >
                  Очистити готові
                </button>
              )}

              {/* Cancel all */}
              {isUploading && (
                <button
                  onClick={cancelAll}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors font-sans"
                >
                  <XCircle size={12} />
                  Скасувати все
                </button>
              )}

              <button
                onClick={() => {
                  if (!isUploading) {
                    clearFinished();
                    setShowUploadPanel(false);
                  }
                }}
                className="p-1 text-claude-subtext hover:text-claude-text transition-colors"
                disabled={isUploading}
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Global progress bar */}
          {(isUploading || doneCount > 0) && (
            <div className="px-5 py-2 border-b border-claude-border/30">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-claude-subtext/60 font-sans">
                  {formatFileSize(uploadedBytes)} / {formatFileSize(totalBytes)}
                </span>
                <span className="text-[10px] text-claude-subtext/60 font-sans">
                  {Math.round(globalProgress * 100)}%
                </span>
              </div>
              <div className="h-1.5 bg-claude-border/30 rounded-full overflow-hidden">
                <motion.div
                  className={`h-full rounded-full ${isPaused ? 'bg-amber-400' : 'bg-claude-accent'}`}
                  initial={{ width: 0 }}
                  animate={{ width: `${globalProgress * 100}%` }}
                  transition={{ duration: 0.3 }}
                />
              </div>
            </div>
          )}

          {/* Queue items */}
          <div ref={uploadQueueRef} className="max-h-[300px] overflow-y-auto divide-y divide-claude-border/30">
            {uploadItems.map((item) => (
              <UploadItemRow
                key={item.id}
                item={item}
                onRemove={removeFile}
                onCancel={cancelFile}
                onRetry={retryFile}
                onDocTypeChange={updateDocType}
              />
            ))}
          </div>

          {/* Queue footer */}
          {queuedCount > 0 && !isUploading && (
            <div className="px-5 py-3 border-t border-claude-border/50 flex items-center justify-between">
              <span className="text-xs text-claude-subtext/60 font-sans">
                {queuedCount} файлів готові до завантаження
              </span>
              <button
                onClick={onStartUpload}
                className="inline-flex items-center gap-2 px-4 py-2 bg-claude-text text-white rounded-xl text-sm font-medium hover:bg-claude-text/90 transition-all active:scale-[0.98] shadow-sm font-sans"
              >
                <Upload size={14} />
                Завантажити ({queuedCount})
              </button>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
