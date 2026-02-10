import React, { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Upload,
  FolderUp,
  FileText,
  Search,
  X,
  CheckCircle,
  AlertCircle,
  Loader2,
  MoreVertical,
  ChevronDown,
  Tag,
  LayoutGrid,
  List,
  Pause,
  Play,
  RotateCcw,
  Image,
  Film,
  FileSpreadsheet,
  XCircle,
} from 'lucide-react';
import { mcpService } from '../../services';
import { useUploadStore } from '../../stores/uploadStore';
import type { UploadItem } from '../../services/upload/UploadManager';
import toast from 'react-hot-toast';

// Types
interface VaultDocument {
  id: string;
  title: string;
  type: 'contract' | 'legislation' | 'court_decision' | 'internal' | 'other';
  metadata: {
    uploadedAt: string;
    uploadedBy?: string;
    tags?: string[];
    category?: string;
    riskLevel?: 'low' | 'medium' | 'high';
    fileSize?: number;
    mimeType?: string;
    folderPath?: string;
  };
}

type DocType = 'contract' | 'legislation' | 'court_decision' | 'internal' | 'other';
type ViewMode = 'grid' | 'list';

const DOC_TYPE_LABELS: Record<DocType, string> = {
  contract: 'Договір',
  legislation: 'Законодавство',
  court_decision: 'Судове рішення',
  internal: 'Внутрішній',
  other: 'Інше',
};

const DOC_TYPE_COLORS: Record<DocType, string> = {
  contract: 'bg-blue-50 text-blue-700 border-blue-200',
  legislation: 'bg-purple-50 text-purple-700 border-purple-200',
  court_decision: 'bg-amber-50 text-amber-700 border-amber-200',
  internal: 'bg-green-50 text-green-700 border-green-200',
  other: 'bg-gray-50 text-gray-700 border-gray-200',
};

const ACCEPTED_TYPES =
  '.pdf,.docx,.doc,.html,.htm,.txt,.rtf,.jpg,.jpeg,.png,.bmp,.gif,.xlsx,.xls,.csv,.mp4,.mov,.avi,.mkv,.webm';

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

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('uk-UA', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function guessMimeType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    html: 'text/html',
    htm: 'text/html',
    txt: 'text/plain',
    rtf: 'application/rtf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    bmp: 'image/bmp',
    gif: 'image/gif',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    csv: 'text/csv',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
  };
  return map[ext || ''] || 'application/octet-stream';
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

export function DocumentsPage() {
  // Document list state
  const [documents, setDocuments] = useState<VaultDocument[]>([]);
  const [totalDocs, setTotalDocs] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<DocType | ''>('');
  const [viewMode, setViewMode] = useState<ViewMode>('list');

  // Upload state from Zustand store
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
    addFiles,
    startUpload,
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
    recoveredSessions,
    recoverSessions,
    dismissRecoveredSession,
    clearRecoveredSessions,
  } = useUploadStore();

  // Local UI state
  const [isDragOver, setIsDragOver] = useState(false);
  const [showUploadPanel, setShowUploadPanel] = useState(false);
  const [defaultDocType, setDefaultDocType] = useState<DocType>('other');
  const [showTypeDropdown, setShowTypeDropdown] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const uploadQueueRef = useRef<HTMLDivElement>(null);

  // Load documents on mount and filter change
  useEffect(() => {
    loadDocuments();
  }, [filterType]);

  // Check for stuck upload sessions on mount
  useEffect(() => {
    recoverSessions();
  }, []);

  // Reload docs when a recovered session completes
  useEffect(() => {
    const hasNewlyCompleted = recoveredSessions.some((s) => s.status === 'completed');
    if (hasNewlyCompleted) {
      loadDocuments();
    }
  }, [recoveredSessions]);

  // Show upload panel when items are added
  useEffect(() => {
    if (uploadItems.length > 0) {
      setShowUploadPanel(true);
    }
  }, [uploadItems.length]);

  // Reload docs when uploads complete
  useEffect(() => {
    if (completedFiles > 0 && !isUploading) {
      loadDocuments();
    }
  }, [completedFiles, isUploading]);

  // Auto-scroll upload queue to the first active item
  useEffect(() => {
    if (!isUploading || !uploadQueueRef.current) return;
    const activeEl = uploadQueueRef.current.querySelector('[data-upload-active="true"]');
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [uploadItems, isUploading]);

  const loadDocuments = async () => {
    setLoading(true);
    try {
      const params: any = {
        limit: 50,
        offset: 0,
        sortBy: 'uploadedAt',
        sortOrder: 'desc',
      };
      if (filterType) params.type = filterType;

      const result = await mcpService.callTool('list_documents', params);
      const parsed = result?.result?.content?.[0]?.text
        ? JSON.parse(result.result.content[0].text)
        : result?.result || result;

      setDocuments(parsed.documents || []);
      setTotalDocs(parsed.total || 0);
    } catch (err: any) {
      console.error('Failed to load documents:', err);
    } finally {
      setLoading(false);
    }
  };

  // File selection handlers
  const handleFilesSelected = useCallback(
    (files: FileList | File[]) => {
      const newItems = Array.from(files)
        .filter((f) => f.size > 0)
        .map((file) => ({
          file,
          mimeType: guessMimeType(file),
          relativePath: (file as any).webkitRelativePath || file.name,
          docType: defaultDocType,
        }));

      if (newItems.length === 0) return;
      addFiles(newItems);
      setShowUploadPanel(true);
    },
    [defaultDocType, addFiles]
  );

  const handleFileSelect = () => fileInputRef.current?.click();
  const handleFolderSelect = () => folderInputRef.current?.click();

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      handleFilesSelected(e.target.files);
      e.target.value = '';
    }
  };

  // Drag and drop
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (dropZoneRef.current && !dropZoneRef.current.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const items = e.dataTransfer.items;
    if (items) {
      const files: File[] = [];
      const entries: any[] = [];
      for (let i = 0; i < items.length; i++) {
        const entry = (items[i] as any).webkitGetAsEntry?.();
        if (entry) {
          entries.push(entry);
        } else if (items[i].kind === 'file') {
          const f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }

      if (entries.length > 0) {
        readEntries(entries).then((allFiles) => {
          handleFilesSelected(allFiles);
        });
      } else if (files.length > 0) {
        handleFilesSelected(files);
      }
    } else if (e.dataTransfer.files.length) {
      handleFilesSelected(e.dataTransfer.files);
    }
  };

  // Upload actions
  const handleStartUpload = () => {
    startUpload();
    toast.success(`Завантаження ${uploadItems.filter((i) => i.status === 'queued').length} файлів розпочато`);
  };

  // Search
  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      loadDocuments();
      return;
    }
    setLoading(true);
    try {
      const result = await mcpService.callTool('semantic_search', {
        query: searchQuery,
        limit: 20,
        threshold: 0.5,
        ...(filterType ? { type: filterType } : {}),
      });
      const parsed = result?.result?.content?.[0]?.text
        ? JSON.parse(result.result.content[0].text)
        : result?.result || result;

      const docs = (parsed.results || []).map((r: any) => ({
        id: r.documentId || r.id,
        title: r.title,
        type: r.type || 'other',
        metadata: r.metadata || { uploadedAt: '' },
      }));
      setDocuments(docs);
      setTotalDocs(docs.length);
    } catch (err: any) {
      console.error('Search failed:', err);
      toast.error('Помилка пошуку');
    } finally {
      setLoading(false);
    }
  };

  const queuedCount = uploadItems.filter((i) => i.status === 'queued').length;
  const activeCount = uploadItems.filter((i) =>
    ['initializing', 'uploading', 'assembling', 'processing'].includes(i.status)
  ).length;
  const doneCount = completedFiles;
  const errorCount = failedFiles;
  const globalProgress = totalBytes > 0 ? uploadedBytes / totalBytes : 0;

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPTED_TYPES}
        className="hidden"
        onChange={handleFileInputChange}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        accept={ACCEPTED_TYPES}
        className="hidden"
        onChange={handleFileInputChange}
        {...({ webkitdirectory: '', directory: '' } as any)}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
          {/* Recovery Banner */}
          <AnimatePresence>
            {recoveredSessions.length > 0 && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="mb-4 bg-amber-50 border border-amber-200 rounded-xl p-4"
              >
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-semibold text-amber-800 font-sans">
                    Відновлення завантажень
                  </h4>
                  {recoveredSessions.every((s) => s.status !== 'recovering') && (
                    <button
                      onClick={clearRecoveredSessions}
                      className="text-xs text-amber-600 hover:text-amber-800 transition-colors font-sans"
                    >
                      Закрити
                    </button>
                  )}
                </div>
                <div className="space-y-1.5">
                  {recoveredSessions.map((s) => (
                    <div key={s.uploadId} className="flex items-center gap-2 text-xs font-sans">
                      {s.status === 'recovering' ? (
                        <Loader2 size={12} className="text-amber-500 animate-spin flex-shrink-0" />
                      ) : s.status === 'completed' ? (
                        <CheckCircle size={12} className="text-green-500 flex-shrink-0" />
                      ) : (
                        <AlertCircle size={12} className="text-red-500 flex-shrink-0" />
                      )}
                      <span className="text-amber-900 truncate flex-1">{s.fileName}</span>
                      <span className={`flex-shrink-0 ${
                        s.status === 'recovering' ? 'text-amber-600' :
                        s.status === 'completed' ? 'text-green-600' : 'text-red-600'
                      }`}>
                        {s.status === 'recovering' ? 'Обробка...' :
                         s.status === 'completed' ? 'Готово' : s.error || 'Помилка'}
                      </span>
                      {s.status !== 'recovering' && (
                        <button
                          onClick={() => dismissRecoveredSession(s.uploadId)}
                          className="text-amber-400 hover:text-amber-700 transition-colors"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Upload Zone */}
          <div
            ref={dropZoneRef}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`relative rounded-2xl border-2 border-dashed p-8 mb-6 transition-all duration-300 ${
              isDragOver
                ? 'border-claude-accent bg-claude-accent/5 scale-[1.01]'
                : 'border-claude-border hover:border-claude-subtext/40 bg-white'
            }`}
          >
            <div className="text-center">
              <div className="flex justify-center gap-3 mb-4">
                <button
                  onClick={handleFileSelect}
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-claude-text text-white rounded-xl text-sm font-medium hover:bg-claude-text/90 transition-all active:scale-[0.98] shadow-sm"
                >
                  <Upload size={16} strokeWidth={2} />
                  Завантажити файли
                </button>
                <button
                  onClick={handleFolderSelect}
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-white border border-claude-border text-claude-text rounded-xl text-sm font-medium hover:bg-claude-bg transition-all active:scale-[0.98] shadow-sm"
                >
                  <FolderUp size={16} strokeWidth={2} />
                  Завантажити папку
                </button>
              </div>
              <p className="text-sm text-claude-subtext/70 font-sans">
                Перетягніть файли або папку сюди &middot; PDF, DOCX, HTML, TXT, зображення, відео &middot; до 2 ГБ
              </p>
            </div>

            {/* Drag overlay */}
            <AnimatePresence>
              {isDragOver && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-0 flex items-center justify-center bg-claude-accent/10 rounded-2xl z-10"
                >
                  <div className="text-claude-accent font-semibold text-lg font-sans">
                    Відпустіть для завантаження
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Upload Queue Panel */}
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
                      onClick={handleStartUpload}
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

          {/* Search and Filters */}
          <div className="flex items-center gap-3 mb-5">
            <div className="flex-1 relative">
              <Search
                size={16}
                className="absolute left-3.5 top-1/2 -translate-y-1/2 text-claude-subtext/40"
              />
              <input
                type="text"
                placeholder="Семантичний пошук документів..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="w-full pl-10 pr-4 py-2.5 bg-white border border-claude-border rounded-xl text-sm text-claude-text placeholder:text-claude-subtext/40 focus:outline-none focus:border-claude-subtext/40 transition-colors font-sans"
              />
            </div>

            {/* Type filter */}
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value as DocType | '')}
              className="px-3 py-2.5 bg-white border border-claude-border rounded-xl text-sm text-claude-text focus:outline-none focus:border-claude-subtext/40 transition-colors font-sans"
            >
              <option value="">Всі типи</option>
              {(Object.keys(DOC_TYPE_LABELS) as DocType[]).map((t) => (
                <option key={t} value={t}>
                  {DOC_TYPE_LABELS[t]}
                </option>
              ))}
            </select>

            {/* View mode toggle */}
            <div className="flex border border-claude-border rounded-xl overflow-hidden">
              <button
                onClick={() => setViewMode('list')}
                className={`p-2.5 transition-colors ${
                  viewMode === 'list'
                    ? 'bg-claude-text text-white'
                    : 'bg-white text-claude-subtext hover:bg-claude-bg'
                }`}
              >
                <List size={16} />
              </button>
              <button
                onClick={() => setViewMode('grid')}
                className={`p-2.5 transition-colors ${
                  viewMode === 'grid'
                    ? 'bg-claude-text text-white'
                    : 'bg-white text-claude-subtext hover:bg-claude-bg'
                }`}
              >
                <LayoutGrid size={16} />
              </button>
            </div>
          </div>

          {/* Document List */}
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 size={24} className="animate-spin text-claude-subtext/40" />
            </div>
          ) : documents.length === 0 ? (
            <div className="text-center py-20">
              <FileText size={48} className="mx-auto mb-4 text-claude-subtext/20" />
              <h3 className="text-lg font-semibold text-claude-text mb-2 font-sans">
                Немає документів
              </h3>
              <p className="text-sm text-claude-subtext/60 font-sans">
                Завантажте документи за допомогою кнопок вище або перетягніть файли
              </p>
            </div>
          ) : viewMode === 'list' ? (
            <div className="bg-white rounded-2xl border border-claude-border shadow-sm overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-claude-border/50">
                    <th className="text-left px-5 py-3 text-[11px] font-semibold text-claude-subtext/60 uppercase tracking-wider font-sans">
                      Назва
                    </th>
                    <th className="text-left px-5 py-3 text-[11px] font-semibold text-claude-subtext/60 uppercase tracking-wider font-sans">
                      Тип
                    </th>
                    <th className="text-left px-5 py-3 text-[11px] font-semibold text-claude-subtext/60 uppercase tracking-wider font-sans">
                      Дата
                    </th>
                    <th className="text-left px-5 py-3 text-[11px] font-semibold text-claude-subtext/60 uppercase tracking-wider font-sans">
                      Теги
                    </th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-claude-border/30">
                  {documents.map((doc) => (
                    <tr
                      key={doc.id}
                      className="hover:bg-claude-bg/50 transition-colors group"
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <FileText
                            size={16}
                            className="text-claude-subtext/40 flex-shrink-0"
                          />
                          <span className="text-sm font-medium text-claude-text truncate max-w-[300px] font-sans">
                            {doc.title}
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <span
                          className={`inline-flex px-2 py-0.5 text-[10px] font-semibold rounded-md border ${
                            DOC_TYPE_COLORS[doc.type] || DOC_TYPE_COLORS.other
                          } font-sans`}
                        >
                          {DOC_TYPE_LABELS[doc.type] || doc.type}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-xs text-claude-subtext/60 font-sans">
                        {doc.metadata?.uploadedAt
                          ? formatDate(doc.metadata.uploadedAt)
                          : '—'}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex gap-1 flex-wrap">
                          {doc.metadata?.tags?.slice(0, 3).map((tag: string) => (
                            <span
                              key={tag}
                              className="text-[10px] px-1.5 py-0.5 bg-claude-subtext/5 text-claude-subtext/70 rounded font-sans"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <button className="p-1 text-claude-subtext/30 hover:text-claude-text transition-colors opacity-0 group-hover:opacity-100">
                          <MoreVertical size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            /* Grid view */
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {documents.map((doc) => (
                <div
                  key={doc.id}
                  className="bg-white rounded-2xl border border-claude-border p-4 hover:shadow-md transition-all group cursor-pointer"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="p-2 bg-claude-subtext/5 rounded-lg">
                      <FileText size={20} className="text-claude-subtext/50" />
                    </div>
                    <span
                      className={`inline-flex px-2 py-0.5 text-[10px] font-semibold rounded-md border ${
                        DOC_TYPE_COLORS[doc.type] || DOC_TYPE_COLORS.other
                      } font-sans`}
                    >
                      {DOC_TYPE_LABELS[doc.type] || doc.type}
                    </span>
                  </div>
                  <h4 className="text-sm font-semibold text-claude-text mb-1 truncate font-sans">
                    {doc.title}
                  </h4>
                  <p className="text-xs text-claude-subtext/50 font-sans">
                    {doc.metadata?.uploadedAt
                      ? formatDate(doc.metadata.uploadedAt)
                      : ''}
                  </p>
                  {doc.metadata?.tags && doc.metadata.tags.length > 0 && (
                    <div className="flex gap-1 mt-2 flex-wrap">
                      {doc.metadata.tags.slice(0, 3).map((tag: string) => (
                        <span
                          key={tag}
                          className="text-[10px] px-1.5 py-0.5 bg-claude-subtext/5 text-claude-subtext/70 rounded font-sans"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Footer with total */}
          {documents.length > 0 && (
            <div className="mt-4 text-center">
              <span className="text-xs text-claude-subtext/50 font-sans">
                Показано {documents.length} з {totalDocs} документів
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Individual upload item row component
 */
function UploadItemRow({
  item,
  onRemove,
  onCancel,
  onRetry,
  onDocTypeChange,
}: {
  item: UploadItem;
  onRemove: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDocTypeChange: (id: string, docType: string) => void;
}) {
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
          {(Object.keys(DOC_TYPE_LABELS) as DocType[]).map((t) => (
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

// Recursively read FileSystemEntry items (for drag-and-drop folder support)
async function readEntries(entries: any[]): Promise<File[]> {
  const files: File[] = [];

  async function processEntry(entry: any): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve) => entry.file(resolve));
      files.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const subEntries = await new Promise<any[]>((resolve) => {
        const allEntries: any[] = [];
        const readBatch = () => {
          reader.readEntries((batch: any[]) => {
            if (batch.length === 0) {
              resolve(allEntries);
            } else {
              allEntries.push(...batch);
              readBatch();
            }
          });
        };
        readBatch();
      });
      for (const sub of subEntries) {
        await processEntry(sub);
      }
    }
  }

  for (const entry of entries) {
    await processEntry(entry);
  }
  return files;
}
