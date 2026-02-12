import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Send, Plus, Square, X, FileText, Loader2, ChevronDown, Sparkles } from 'lucide-react';
import { uploadService } from '../services/api/UploadService';
import showToast from '../utils/toast';

const AI_CHAT_MODE = 'ai_chat';

const TOOL_OPTIONS = [
  { name: 'search_court_cases', label: 'Пошук справ' },
  { name: 'search_supreme_court_practice', label: 'Практика ВС' },
  { name: 'search_legislation', label: 'Законодавство' },
  { name: 'search_deputies', label: 'Депутати' },
  { name: 'search_entities', label: 'Реєстр' },
];

const ACCEPTED_FILE_TYPES = '.pdf,.docx,.doc,.txt,.rtf,.html';

interface SelectedFile {
  file: File;
  uploading: boolean;
  documentId?: string;
  error?: string;
}

interface ChatInputProps {
  onSend: (message: string, toolName?: string, documentIds?: string[]) => void;
  disabled?: boolean;
  isStreaming?: boolean;
  onCancel?: () => void;
  selectedTool?: string;
  onToolChange?: (tool: string) => void;
}

export function ChatInput({
  onSend,
  disabled,
  isStreaming,
  onCancel,
  selectedTool,
  onToolChange,
}: ChatInputProps) {
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const adjustHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  };

  useEffect(() => {
    adjustHeight();
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const uploadFiles = useCallback(async (selectedFiles: SelectedFile[]): Promise<string[]> => {
    const documentIds: string[] = [];
    const updatedFiles = [...selectedFiles];

    for (let i = 0; i < updatedFiles.length; i++) {
      const sf = updatedFiles[i];
      updatedFiles[i] = { ...sf, uploading: true };
      setFiles([...updatedFiles]);

      try {
        // Init upload
        const initResult = await uploadService.initUpload({
          fileName: sf.file.name,
          fileSize: sf.file.size,
          mimeType: sf.file.type || 'application/octet-stream',
          docType: 'other',
        });

        // Upload as single chunk (files should be small for chat context)
        const chunk = sf.file.slice(0, sf.file.size);
        await uploadService.uploadChunk(initResult.uploadId, 0, chunk);

        // Complete upload
        await uploadService.completeUpload(initResult.uploadId);

        // Poll for completion
        let attempts = 0;
        let status = await uploadService.getStatus(initResult.uploadId);
        while (status.status !== 'completed' && status.status !== 'failed' && attempts < 30) {
          await new Promise((r) => setTimeout(r, 1000));
          status = await uploadService.getStatus(initResult.uploadId);
          attempts++;
        }

        if (status.documentId) {
          documentIds.push(status.documentId);
          updatedFiles[i] = { ...sf, uploading: false, documentId: status.documentId };
        } else {
          updatedFiles[i] = { ...sf, uploading: false, error: 'Upload failed' };
        }
      } catch (err: any) {
        updatedFiles[i] = { ...sf, uploading: false, error: err.message };
      }
      setFiles([...updatedFiles]);
    }

    return documentIds;
  }, []);

  const handleSubmit = async () => {
    if ((!input.trim() && files.length === 0) || disabled || isStreaming) return;

    let documentIds: string[] = [];

    // Upload files first if any
    if (files.length > 0) {
      setIsUploadingFiles(true);
      try {
        documentIds = await uploadFiles(files);
      } catch {
        showToast.error('Помилка завантаження файлів');
      }
      setIsUploadingFiles(false);
    }

    onSend(input, undefined, documentIds.length > 0 ? documentIds : undefined);
    setInput('');
    setFiles([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []);
    if (selectedFiles.length === 0) return;

    const newFiles: SelectedFile[] = selectedFiles.map((file) => ({
      file,
      uploading: false,
    }));
    setFiles((prev) => [...prev, ...newFiles]);

    // Reset input so same file can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const [showManualTools, setShowManualTools] = useState(false);
  const activeTool = selectedTool || AI_CHAT_MODE;
  const isAIChat = activeTool === AI_CHAT_MODE;

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 pb-2">
      {/* Mode Selection: AI Chat + expandable manual tools */}
      {onToolChange && (
        <div className="flex flex-wrap gap-2 mb-3 pb-1">
          {/* AI Chat pill (default) */}
          <button
            onClick={() => {
              onToolChange(AI_CHAT_MODE);
              setShowManualTools(false);
            }}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-[12px] font-medium transition-all duration-200 border flex items-center gap-1.5 ${
              isAIChat
                ? 'bg-claude-text text-white border-claude-text shadow-sm'
                : 'bg-white text-claude-subtext border-claude-border hover:border-claude-subtext/40 hover:text-claude-text'
            }`}
          >
            <Sparkles size={12} />
            AI Чат
          </button>

          {/* Manual tools toggle */}
          <button
            onClick={() => setShowManualTools(!showManualTools)}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-[12px] font-medium transition-all duration-200 border flex items-center gap-1 ${
              !isAIChat
                ? 'bg-claude-text/10 text-claude-text border-claude-text/30'
                : 'bg-white text-claude-subtext border-claude-border hover:border-claude-subtext/40 hover:text-claude-text'
            }`}
          >
            Інструменти
            <ChevronDown size={12} className={`transition-transform ${showManualTools ? 'rotate-180' : ''}`} />
          </button>

          {/* Manual tool pills (expandable) */}
          {showManualTools && TOOL_OPTIONS.map((tool) => (
            <button
              key={tool.name}
              onClick={() => onToolChange(tool.name)}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-[12px] font-medium transition-all duration-200 border ${
                activeTool === tool.name
                  ? 'bg-claude-text text-white border-claude-text shadow-sm'
                  : 'bg-white text-claude-subtext border-claude-border hover:border-claude-subtext/40 hover:text-claude-text'
              }`}
            >
              {tool.label}
            </button>
          ))}
        </div>
      )}

      {/* File Badges */}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {files.map((sf, idx) => (
            <div
              key={idx}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] border ${
                sf.error
                  ? 'bg-red-50 border-red-200 text-red-600'
                  : sf.uploading
                  ? 'bg-claude-bg border-claude-border text-claude-subtext'
                  : sf.documentId
                  ? 'bg-green-50 border-green-200 text-green-700'
                  : 'bg-claude-bg border-claude-border text-claude-text'
              }`}
            >
              {sf.uploading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <FileText size={12} />
              )}
              <span className="max-w-[120px] truncate">{sf.file.name}</span>
              {!sf.uploading && (
                <button
                  onClick={() => removeFile(idx)}
                  className="p-0.5 hover:bg-claude-subtext/10 rounded transition-colors"
                >
                  <X size={10} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="relative bg-white rounded-2xl border border-claude-border shadow-sm focus-within:shadow-md focus-within:border-claude-subtext/40 transition-all duration-300">
        <div className="flex items-end gap-2 p-2">
          {/* Plus / Attach button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-lg transition-all duration-200 flex-shrink-0"
            aria-label="Додати вкладення"
          >
            <Plus size={18} strokeWidth={2} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_FILE_TYPES}
            onChange={handleFileSelect}
            className="hidden"
          />

          <textarea
            id="chat-message-input"
            name="message"
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Відповісти..."
            disabled={disabled || isStreaming}
            rows={1}
            className="flex-1 py-2 px-2 bg-transparent border-none resize-none focus:ring-0 focus:outline-none text-claude-text placeholder:text-claude-subtext/40 font-sans text-[15px] leading-relaxed max-h-[200px] overflow-hidden"
            style={{
              minHeight: '40px'
            }}
          />

          <div className="flex items-center gap-2 flex-shrink-0">
            {isStreaming ? (
              <button
                type="button"
                onClick={onCancel}
                className="p-2 rounded-lg transition-all duration-200 bg-claude-text text-white hover:bg-claude-text/90 shadow-sm active:scale-95"
                aria-label="Зупинити генерацію"
                title="Зупинити"
              >
                <Square size={18} strokeWidth={2} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={(!input.trim() && files.length === 0) || disabled || isUploadingFiles}
                className={`p-2 rounded-lg transition-all duration-200 ${
                  (input.trim() || files.length > 0) && !disabled && !isUploadingFiles
                    ? 'bg-claude-text text-white hover:bg-claude-text/90 shadow-sm active:scale-95'
                    : 'bg-claude-subtext/10 text-claude-subtext/30 cursor-not-allowed'
                }`}
                aria-label="Надіслати повідомлення"
              >
                {isUploadingFiles ? (
                  <Loader2 size={18} strokeWidth={2} className="animate-spin" />
                ) : (
                  <Send size={18} strokeWidth={2} />
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
