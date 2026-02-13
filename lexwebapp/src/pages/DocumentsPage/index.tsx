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
  LayoutGrid,
  List,
} from 'lucide-react';
import { mcpService } from '../../services';
import { useUploadStore } from '../../stores/uploadStore';
import toast from 'react-hot-toast';
import { api } from '../../utils/api-client';
import { FolderNavigator } from './FolderNavigator';
import { UploadQueuePanel } from './UploadQueuePanel';
import { DocumentTable } from './DocumentTable';
import { DocumentGrid } from './DocumentGrid';
import { DocumentViewerModal } from '../../components/DocumentViewerModal';
import type { VaultDocument, DocType, ViewMode, SortField, SortOrder } from './types';

const DOC_TYPE_LABELS: Record<DocType, string> = {
  contract: 'Договір',
  legislation: 'Законодавство',
  court_decision: 'Судове рішення',
  internal: 'Внутрішній',
  other: 'Інше',
};

const ACCEPTED_TYPES =
  '.pdf,.docx,.doc,.html,.htm,.txt,.rtf,.jpg,.jpeg,.png,.bmp,.gif,.xlsx,.xls,.csv,.mp4,.mov,.avi,.mkv,.webm';

const PAGE_SIZE = 50;

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

function SkeletonRows() {
  return (
    <div className="bg-white rounded-2xl border border-claude-border shadow-sm overflow-hidden">
      <div className="divide-y divide-claude-border/30">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-4 animate-pulse">
            <div className="h-4 w-4 bg-claude-border/30 rounded" />
            <div className="h-4 bg-claude-border/30 rounded w-1/3" />
            <div className="h-4 bg-claude-border/30 rounded w-16" />
            <div className="h-4 bg-claude-border/30 rounded w-24" />
            <div className="h-4 bg-claude-border/30 rounded w-14 hidden md:block" />
            <div className="h-4 bg-claude-border/30 rounded w-20 hidden md:block" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function DocumentsPage() {
  // Document list state
  const [documents, setDocuments] = useState<VaultDocument[]>([]);
  const [totalDocs, setTotalDocs] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<DocType | ''>('');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [offset, setOffset] = useState(0);
  const [sortBy, setSortBy] = useState<SortField>('uploadedAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  // Document preview state
  const [previewDoc, setPreviewDoc] = useState<{
    type: 'document';
    title: string;
    subtitle?: string;
    badge?: string;
    content: string;
  } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Folder navigation state
  const [currentFolderPath, setCurrentFolderPath] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);

  // Upload state from Zustand store
  const {
    items: uploadItems,
    isUploading,
    completedFiles,
    addFiles,
    startUpload,
    recoverSessions,
    recoveredSessions,
    dismissRecoveredSession,
    clearRecoveredSessions,
  } = useUploadStore();

  // Local UI state
  const [isDragOver, setIsDragOver] = useState(false);
  const [showUploadPanel, setShowUploadPanel] = useState(false);
  const [defaultDocType, setDefaultDocType] = useState<DocType>('other');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  // Reset offset when filters change
  useEffect(() => {
    setOffset(0);
  }, [filterType, currentFolderPath, searchQuery]);

  // Load documents on mount and when filters/sort/offset change
  useEffect(() => {
    if (!searchQuery.trim()) {
      loadDocuments();
    }
    loadFolders(currentFolderPath);
  }, [filterType, currentFolderPath, offset, sortBy, sortOrder]);

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

  // Reload docs and folders when uploads complete
  useEffect(() => {
    if (completedFiles > 0 && !isUploading) {
      loadDocuments();
      loadFolders(currentFolderPath);
    }
  }, [completedFiles, isUploading]);

  const loadDocuments = async () => {
    setLoading(true);
    try {
      const params: Record<string, any> = {
        limit: PAGE_SIZE,
        offset,
        sortBy,
        sortOrder,
      };
      if (filterType) params.type = filterType;
      if (currentFolderPath) params.folderPath = currentFolderPath;

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

  const loadFolders = async (prefix: string) => {
    setFoldersLoading(true);
    try {
      const resp = await api.documents.getFolders(prefix || undefined);
      setFolders(resp.data.folders || []);
    } catch (err: any) {
      console.error('Failed to load folders:', err);
      setFolders([]);
    } finally {
      setFoldersLoading(false);
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

  const handleClearSearch = () => {
    setSearchQuery('');
    setOffset(0);
    loadDocuments();
  };

  // Sort handler
  const handleSort = (field: SortField) => {
    if (field === sortBy) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortOrder('desc');
    }
  };

  // Document preview
  const handleDocumentClick = async (doc: VaultDocument) => {
    setPreviewLoading(true);
    setPreviewOpen(true);
    try {
      const result = await mcpService.callTool('get_document', { documentId: doc.id });
      const parsed = result?.result?.content?.[0]?.text
        ? JSON.parse(result.result.content[0].text)
        : result?.result || result;

      const content = parsed.content || parsed.text || parsed.sections?.map((s: any) => s.content).join('\n\n') || 'Вміст недоступний';
      const badge = DOC_TYPE_LABELS[doc.type] || doc.type;

      setPreviewDoc({
        type: 'document',
        title: doc.title,
        subtitle: doc.metadata?.uploadedAt ? `Завантажено: ${new Date(doc.metadata.uploadedAt).toLocaleDateString('uk-UA')}` : undefined,
        badge,
        content,
      });
    } catch (err: any) {
      console.error('Failed to fetch document:', err);
      toast.error('Не вдалося завантажити документ');
      setPreviewOpen(false);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Pagination
  const hasMore = offset + PAGE_SIZE < totalDocs;
  const hasPrev = offset > 0;
  const isSearchActive = searchQuery.trim().length > 0;

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
          <UploadQueuePanel
            showUploadPanel={showUploadPanel}
            setShowUploadPanel={setShowUploadPanel}
            defaultDocType={defaultDocType}
            setDefaultDocType={setDefaultDocType}
            onStartUpload={handleStartUpload}
          />

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
                className="w-full pl-10 pr-9 py-2.5 bg-white border border-claude-border rounded-xl text-sm text-claude-text placeholder:text-claude-subtext/40 focus:outline-none focus:border-claude-subtext/40 transition-colors font-sans"
              />
              {searchQuery && (
                <button
                  onClick={handleClearSearch}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 text-claude-subtext/40 hover:text-claude-text transition-colors"
                >
                  <X size={14} />
                </button>
              )}
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

          {/* Folder Navigator */}
          {(currentFolderPath || folders.length > 0) && (
            <FolderNavigator
              currentPath={currentFolderPath}
              folders={folders}
              onNavigate={(folderName) => {
                const newPath = currentFolderPath
                  ? `${currentFolderPath}${folderName}/`
                  : `${folderName}/`;
                setCurrentFolderPath(newPath);
              }}
              onReset={() => setCurrentFolderPath('')}
              onBreadcrumbClick={(depth) => {
                const segments = currentFolderPath.split('/').filter(Boolean);
                const newPath = segments.slice(0, depth).join('/') + '/';
                setCurrentFolderPath(newPath);
              }}
              loading={foldersLoading}
            />
          )}

          {/* Document List */}
          {loading ? (
            <SkeletonRows />
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
            <DocumentTable
              documents={documents}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSort={handleSort}
              onDocumentClick={handleDocumentClick}
            />
          ) : (
            <DocumentGrid
              documents={documents}
              onDocumentClick={handleDocumentClick}
            />
          )}

          {/* Pagination footer */}
          {documents.length > 0 && !isSearchActive && (
            <div className="flex items-center justify-between mt-4">
              <span className="text-xs text-claude-subtext/50 font-sans">
                {offset + 1}–{Math.min(offset + PAGE_SIZE, totalDocs)} з {totalDocs}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
                  disabled={!hasPrev}
                  className="px-4 py-2 rounded-xl text-sm font-sans font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-white border border-claude-border text-claude-text hover:bg-claude-bg"
                >
                  Назад
                </button>
                <button
                  onClick={() => setOffset((prev) => prev + PAGE_SIZE)}
                  disabled={!hasMore}
                  className="px-4 py-2 rounded-xl text-sm font-sans font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-white border border-claude-border text-claude-text hover:bg-claude-bg"
                >
                  Далі
                </button>
              </div>
            </div>
          )}

          {/* Search results count */}
          {documents.length > 0 && isSearchActive && (
            <div className="mt-4 text-center">
              <span className="text-xs text-claude-subtext/50 font-sans">
                Знайдено {documents.length} документів
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Document Preview Modal */}
      <DocumentViewerModal
        isOpen={previewOpen}
        onClose={() => {
          setPreviewOpen(false);
          setPreviewDoc(null);
        }}
        item={previewLoading ? {
          type: 'document',
          title: 'Завантаження...',
          content: '',
        } : previewDoc}
      />
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
