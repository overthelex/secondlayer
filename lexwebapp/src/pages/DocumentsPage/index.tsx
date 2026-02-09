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
  File,
  Tag,
  LayoutGrid,
  List,
} from 'lucide-react';
import { mcpService } from '../../services';
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

interface UploadItem {
  id: string;
  file: File;
  name: string;
  size: number;
  type: string;
  relativePath: string;
  docType: DocType;
  status: 'pending' | 'uploading' | 'processing' | 'done' | 'error';
  progress: number;
  error?: string;
  documentId?: string;
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

const ACCEPTED_TYPES = '.pdf,.docx,.doc,.html,.htm,.txt,.rtf';

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip data URL prefix to get pure base64
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  };
  return map[ext || ''] || 'application/octet-stream';
}

export function DocumentsPage() {
  // Document list state
  const [documents, setDocuments] = useState<VaultDocument[]>([]);
  const [totalDocs, setTotalDocs] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<DocType | ''>('');
  const [viewMode, setViewMode] = useState<ViewMode>('list');

  // Upload state
  const [uploadQueue, setUploadQueue] = useState<UploadItem[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [showUploadPanel, setShowUploadPanel] = useState(false);
  const [defaultDocType, setDefaultDocType] = useState<DocType>('other');
  const [showTypeDropdown, setShowTypeDropdown] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  // Load documents on mount and filter change
  useEffect(() => {
    loadDocuments();
  }, [filterType]);

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
      // Don't toast on initial load failure - backend may not have vault yet
    } finally {
      setLoading(false);
    }
  };

  // File selection handlers
  const addFilesToQueue = useCallback(
    (files: FileList | File[]) => {
      const newItems: UploadItem[] = Array.from(files)
        .filter((f) => f.size > 0) // skip empty/directory entries
        .map((file) => ({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          name: file.name,
          size: file.size,
          type: guessMimeType(file),
          relativePath:
            (file as any).webkitRelativePath || file.name,
          docType: defaultDocType,
          status: 'pending' as const,
          progress: 0,
        }));

      if (newItems.length === 0) return;

      setUploadQueue((prev) => [...prev, ...newItems]);
      setShowUploadPanel(true);
    },
    [defaultDocType]
  );

  const handleFileSelect = () => fileInputRef.current?.click();
  const handleFolderSelect = () => folderInputRef.current?.click();

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      addFilesToQueue(e.target.files);
      e.target.value = ''; // reset so same files can be re-selected
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
      // Try to use webkitGetAsEntry for folder support
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
        // Recursively read directory entries
        readEntries(entries).then((allFiles) => {
          addFilesToQueue(allFiles);
        });
      } else if (files.length > 0) {
        addFilesToQueue(files);
      }
    } else if (e.dataTransfer.files.length) {
      addFilesToQueue(e.dataTransfer.files);
    }
  };

  // Upload execution
  const startUpload = async () => {
    const pending = uploadQueue.filter((i) => i.status === 'pending');
    if (pending.length === 0) return;

    setIsUploading(true);

    for (const item of pending) {
      setUploadQueue((prev) =>
        prev.map((i) =>
          i.id === item.id ? { ...i, status: 'uploading', progress: 10 } : i
        )
      );

      try {
        const base64 = await fileToBase64(item.file);
        setUploadQueue((prev) =>
          prev.map((i) =>
            i.id === item.id ? { ...i, status: 'processing', progress: 50 } : i
          )
        );

        const result = await mcpService.callTool('store_document', {
          fileBase64: base64,
          mimeType: item.type,
          title: item.name.replace(/\.[^/.]+$/, ''),
          type: item.docType,
          metadata: {
            tags: [],
            category: '',
            originalFilename: item.name,
            fileSize: item.size,
            mimeType: item.type,
            folderPath: item.relativePath.includes('/')
              ? item.relativePath.substring(0, item.relativePath.lastIndexOf('/'))
              : undefined,
          },
        });

        const parsed = result?.result?.content?.[0]?.text
          ? JSON.parse(result.result.content[0].text)
          : result?.result || result;

        setUploadQueue((prev) =>
          prev.map((i) =>
            i.id === item.id
              ? { ...i, status: 'done', progress: 100, documentId: parsed.id }
              : i
          )
        );
      } catch (err: any) {
        setUploadQueue((prev) =>
          prev.map((i) =>
            i.id === item.id
              ? { ...i, status: 'error', error: err.message || 'Upload failed' }
              : i
          )
        );
      }
    }

    setIsUploading(false);
    toast.success(
      `Завантажено ${pending.filter(() => uploadQueue.find((u) => u.status === 'done')).length} документів`
    );
    loadDocuments();
  };

  const removeFromQueue = (id: string) => {
    setUploadQueue((prev) => prev.filter((i) => i.id !== id));
  };

  const clearCompleted = () => {
    setUploadQueue((prev) => prev.filter((i) => i.status !== 'done'));
  };

  const updateItemDocType = (id: string, docType: DocType) => {
    setUploadQueue((prev) =>
      prev.map((i) => (i.id === id ? { ...i, docType } : i))
    );
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

      // Semantic search returns different format
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

  const pendingCount = uploadQueue.filter((i) => i.status === 'pending').length;
  const doneCount = uploadQueue.filter((i) => i.status === 'done').length;
  const errorCount = uploadQueue.filter((i) => i.status === 'error').length;

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
                Перетягніть файли або папку сюди &middot; PDF, DOCX, HTML, TXT &middot; до 50 МБ
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
            {showUploadPanel && uploadQueue.length > 0 && (
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
                      {uploadQueue.length} файлів
                      {doneCount > 0 && ` · ${doneCount} готово`}
                      {errorCount > 0 && ` · ${errorCount} помилок`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
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
                                  // Apply to all pending items
                                  setUploadQueue((prev) =>
                                    prev.map((i) =>
                                      i.status === 'pending' ? { ...i, docType: t } : i
                                    )
                                  );
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

                    {doneCount > 0 && (
                      <button
                        onClick={clearCompleted}
                        className="text-xs text-claude-subtext hover:text-claude-text transition-colors font-sans"
                      >
                        Очистити готові
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (!isUploading) {
                          setUploadQueue([]);
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

                {/* Queue items */}
                <div className="max-h-[300px] overflow-y-auto divide-y divide-claude-border/30">
                  {uploadQueue.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center gap-3 px-5 py-2.5 hover:bg-claude-bg/50 transition-colors"
                    >
                      <div className="flex-shrink-0">
                        {item.status === 'done' ? (
                          <CheckCircle size={16} className="text-green-500" />
                        ) : item.status === 'error' ? (
                          <AlertCircle size={16} className="text-red-500" />
                        ) : item.status === 'uploading' || item.status === 'processing' ? (
                          <Loader2 size={16} className="text-claude-accent animate-spin" />
                        ) : (
                          <File size={16} className="text-claude-subtext/50" />
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-claude-text truncate font-sans">
                            {item.relativePath || item.name}
                          </span>
                          <span className="text-[10px] text-claude-subtext/50 flex-shrink-0 font-sans">
                            {formatFileSize(item.size)}
                          </span>
                        </div>
                        {(item.status === 'uploading' || item.status === 'processing') && (
                          <div className="mt-1 h-1 bg-claude-border/30 rounded-full overflow-hidden">
                            <motion.div
                              className="h-full bg-claude-accent rounded-full"
                              initial={{ width: 0 }}
                              animate={{ width: `${item.progress}%` }}
                              transition={{ duration: 0.3 }}
                            />
                          </div>
                        )}
                        {item.error && (
                          <span className="text-[10px] text-red-500 font-sans">{item.error}</span>
                        )}
                      </div>

                      {/* Per-item type selector (only for pending) */}
                      {item.status === 'pending' && (
                        <select
                          value={item.docType}
                          onChange={(e) =>
                            updateItemDocType(item.id, e.target.value as DocType)
                          }
                          className="text-[10px] border border-claude-border rounded-md px-1.5 py-0.5 bg-white text-claude-text font-sans"
                        >
                          {(Object.keys(DOC_TYPE_LABELS) as DocType[]).map((t) => (
                            <option key={t} value={t}>
                              {DOC_TYPE_LABELS[t]}
                            </option>
                          ))}
                        </select>
                      )}

                      {item.status !== 'uploading' && item.status !== 'processing' && (
                        <button
                          onClick={() => removeFromQueue(item.id)}
                          className="p-1 text-claude-subtext/40 hover:text-red-500 transition-colors"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {/* Queue footer */}
                {pendingCount > 0 && (
                  <div className="px-5 py-3 border-t border-claude-border/50 flex items-center justify-between">
                    <span className="text-xs text-claude-subtext/60 font-sans">
                      {pendingCount} файлів готові до завантаження
                    </span>
                    <button
                      onClick={startUpload}
                      disabled={isUploading}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-claude-text text-white rounded-xl text-sm font-medium hover:bg-claude-text/90 transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed shadow-sm font-sans"
                    >
                      {isUploading ? (
                        <>
                          <Loader2 size={14} className="animate-spin" />
                          Завантаження...
                        </>
                      ) : (
                        <>
                          <Upload size={14} />
                          Завантажити все ({pendingCount})
                        </>
                      )}
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
