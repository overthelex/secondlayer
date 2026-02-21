import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Send, Plus, Square, X, FileText, Loader2, ChevronDown, Sparkles, AlignJustify, Save, Trash2 } from 'lucide-react';
import { uploadService } from '../services/api/UploadService';
import { promptService, SavedPrompt } from '../services/api/PromptService';
import showToast from '../utils/toast';

const AI_CHAT_MODE = 'ai_chat';

interface ToolOption {
  name: string;
  label: string;
}

interface ToolCategory {
  id: string;
  label: string;
  tools: ToolOption[];
}

const TOOL_CATEGORIES: ToolCategory[] = [
  {
    id: 'court',
    label: 'Судові справи',
    tools: [
      { name: 'search_legal_precedents', label: 'Пошук справ' },
      { name: 'search_supreme_court_practice', label: 'Практика ВС' },
      { name: 'get_court_decision', label: 'Рішення суду' },
      { name: 'get_case_documents_chain', label: 'Ланцюг документів' },
      { name: 'find_similar_fact_pattern_cases', label: 'Схожі справи' },
      { name: 'compare_practice_pro_contra', label: 'За і проти' },
      { name: 'count_cases_by_party', label: 'Справи сторони' },
      { name: 'get_case_text', label: 'Текст справи' },
    ],
  },
  {
    id: 'analysis',
    label: 'Аналіз',
    tools: [
      { name: 'analyze_case_pattern', label: 'Аналіз патерну' },
      { name: 'get_similar_reasoning', label: 'Схоже обґрунтування' },
      { name: 'get_citation_graph', label: 'Граф цитувань' },
      { name: 'check_precedent_status', label: 'Статус прецеденту' },
    ],
  },
  {
    id: 'legislation',
    label: 'Законодавство',
    tools: [
      { name: 'search_legislation', label: 'Пошук законів' },
      { name: 'get_legislation_article', label: 'Стаття закону' },
      { name: 'get_legislation_articles', label: 'Статті закону' },
      { name: 'get_legislation_section', label: 'Розділ закону' },
      { name: 'get_legislation_structure', label: 'Структура закону' },
      { name: 'search_procedural_norms', label: 'Процесуальні норми' },
      { name: 'find_relevant_law_articles', label: 'Релевантні статті' },
    ],
  },
  {
    id: 'documents',
    label: 'Документи',
    tools: [
      { name: 'store_document', label: 'Зберегти документ' },
      { name: 'list_documents', label: 'Список документів' },
      { name: 'semantic_search', label: 'Семантичний пошук' },
      { name: 'get_document', label: 'Отримати документ' },
      { name: 'parse_document', label: 'Розібрати документ' },
      { name: 'extract_document_sections', label: 'Секції документу' },
      { name: 'summarize_document', label: 'Резюме документу' },
      { name: 'compare_documents', label: 'Порівняти документи' },
      { name: 'extract_key_clauses', label: 'Ключові положення' },
    ],
  },
  {
    id: 'procedural',
    label: 'Процесуальне',
    tools: [
      { name: 'calculate_procedural_deadlines', label: 'Строки' },
      { name: 'build_procedural_checklist', label: 'Чеклист' },
      { name: 'calculate_monetary_claims', label: 'Грошові вимоги' },
    ],
  },
  {
    id: 'dd',
    label: 'Due Diligence',
    tools: [
      { name: 'generate_dd_report', label: 'DD звіт' },
      { name: 'risk_scoring', label: 'Скоринг ризиків' },
      { name: 'format_answer_pack', label: 'Пакет відповідей' },
    ],
  },
  {
    id: 'parliament',
    label: 'Парламент',
    tools: [
      { name: 'rada_search_parliament_bills', label: 'Законопроекти' },
      { name: 'rada_get_deputy_info', label: 'Депутати' },
      { name: 'rada_search_legislation_text', label: 'Текст законів' },
      { name: 'rada_analyze_voting_record', label: 'Голосування' },
    ],
  },
  {
    id: 'registry',
    label: 'Реєстри',
    tools: [
      { name: 'openreyestr_search_entities', label: 'Пошук юросіб' },
      { name: 'openreyestr_get_entity_details', label: 'Деталі юрособи' },
      { name: 'openreyestr_search_beneficiaries', label: 'Бенефіціари' },
      { name: 'openreyestr_get_by_edrpou', label: 'За ЄДРПОУ' },
      { name: 'openreyestr_get_statistics', label: 'Статистика' },
      { name: 'openreyestr_search_enforcement_proceedings', label: 'Виконавчі провадження' },
      { name: 'openreyestr_search_debtors', label: 'Боржники' },
      { name: 'openreyestr_search_bankruptcy_cases', label: 'Банкрутство' },
      { name: 'openreyestr_search_notaries', label: 'Нотаріуси' },
      { name: 'openreyestr_search_court_experts', label: 'Судові експерти' },
      { name: 'openreyestr_search_arbitration_managers', label: 'Арбітражні керуючі' },
    ],
  },
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
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  // Prompt save/load state
  const [showLoadModal, setShowLoadModal] = useState(false);
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);

  const activeTool = selectedTool || AI_CHAT_MODE;
  const isAIChat = activeTool === AI_CHAT_MODE;

  // Find which category the active tool belongs to
  const activeCategory = TOOL_CATEGORIES.find(cat =>
    cat.tools.some(t => t.name === activeTool)
  );

  const handleOpenLoad = async () => {
    setPromptsLoading(true);
    setShowLoadModal(true);
    try {
      const prompts = await promptService.list();
      setSavedPrompts(prompts);
    } catch {
      showToast.error('Не вдалося завантажити промпти');
    } finally {
      setPromptsLoading(false);
    }
  };

  const handleLoadPrompt = (prompt: SavedPrompt) => {
    setInput(prompt.content);
    setShowLoadModal(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleDeletePrompt = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await promptService.delete(id);
      setSavedPrompts((prev) => prev.filter((p) => p.id !== id));
    } catch {
      showToast.error('Не вдалося видалити промпт');
    }
  };

  const handleSavePrompt = async () => {
    if (!input.trim()) return;
    const autoName = input.trim().split(/\s+/).slice(0, 6).join(' ').slice(0, 60);
    setSavingPrompt(true);
    try {
      await promptService.save(autoName, input.trim());
      showToast.success('Промпт збережено');
    } catch {
      showToast.error('Не вдалося зберегти промпт');
    } finally {
      setSavingPrompt(false);
    }
  };

  return (
    <>
    <div className="max-w-3xl mx-auto px-4 md:px-6 pb-2">
      {/* Mode Selection: AI Chat + expandable manual tools */}
      {onToolChange && (
        <div className="mb-3 pb-1">
          <div className="flex flex-wrap gap-2">
            {/* AI Chat pill (default) */}
            <button
              onClick={() => {
                onToolChange(AI_CHAT_MODE);
                setShowManualTools(false);
                setExpandedCategory(null);
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
              onClick={() => {
                setShowManualTools(!showManualTools);
                if (showManualTools) setExpandedCategory(null);
              }}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-[12px] font-medium transition-all duration-200 border flex items-center gap-1 ${
                !isAIChat
                  ? 'bg-claude-text/10 text-claude-text border-claude-text/30'
                  : 'bg-white text-claude-subtext border-claude-border hover:border-claude-subtext/40 hover:text-claude-text'
              }`}
            >
              Інструменти
              <ChevronDown size={12} className={`transition-transform ${showManualTools ? 'rotate-180' : ''}`} />
            </button>

            {/* Active tool indicator (when tools panel is collapsed) */}
            {!isAIChat && !showManualTools && activeCategory && (
              <span className="flex-shrink-0 px-3 py-1.5 rounded-full text-[12px] font-medium bg-claude-text text-white border border-claude-text shadow-sm">
                {activeCategory.tools.find(t => t.name === activeTool)?.label}
              </span>
            )}
          </div>

          {/* Category pills */}
          {showManualTools && (
            <div className="mt-2 space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {TOOL_CATEGORIES.map((cat) => (
                  <button
                    key={cat.id}
                    onClick={() => setExpandedCategory(expandedCategory === cat.id ? null : cat.id)}
                    className={`flex-shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all duration-200 border flex items-center gap-1 ${
                      expandedCategory === cat.id || activeCategory?.id === cat.id
                        ? 'bg-claude-text/10 text-claude-text border-claude-text/30'
                        : 'bg-white text-claude-subtext border-claude-border hover:border-claude-subtext/40 hover:text-claude-text'
                    }`}
                  >
                    {cat.label}
                    <ChevronDown size={10} className={`transition-transform ${expandedCategory === cat.id ? 'rotate-180' : ''}`} />
                  </button>
                ))}
              </div>

              {/* Tools in selected category */}
              {expandedCategory && (
                <div className="flex flex-wrap gap-1.5 pl-1">
                  {TOOL_CATEGORIES.find(c => c.id === expandedCategory)?.tools.map((tool) => (
                    <button
                      key={tool.name}
                      onClick={() => onToolChange(tool.name)}
                      className={`flex-shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all duration-200 border ${
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
            </div>
          )}
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

      {/* Load / Save prompt buttons */}
      <div className="flex items-center gap-3 mb-2">
        <button
          type="button"
          onClick={handleOpenLoad}
          className="flex items-center gap-1.5 text-[13px] text-claude-subtext hover:text-claude-text transition-colors"
        >
          <AlignJustify size={14} />
          Load prompt
        </button>
        <button
          type="button"
          onClick={handleSavePrompt}
          disabled={!input.trim() || savingPrompt}
          className="flex items-center gap-1.5 text-[13px] text-claude-subtext hover:text-claude-text transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <Save size={14} />
          {savingPrompt ? 'Зберігаю...' : 'Save prompt'}
        </button>
      </div>

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

      {/* Load Prompt Modal */}
      {showLoadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowLoadModal(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[15px] font-semibold text-claude-text mb-4">Завантажити промпт</h3>
            {promptsLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 size={20} className="animate-spin text-claude-subtext" />
              </div>
            ) : savedPrompts.length === 0 ? (
              <p className="text-[13px] text-claude-subtext text-center py-8">Немає збережених промптів</p>
            ) : (
              <ul className="space-y-1 max-h-72 overflow-y-auto -mx-1">
                {savedPrompts.map((p) => (
                  <li
                    key={p.id}
                    onClick={() => handleLoadPrompt(p)}
                    className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-claude-bg cursor-pointer group transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-claude-text truncate">{p.name}</p>
                      <p className="text-[11px] text-claude-subtext truncate mt-0.5">{p.content}</p>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => handleDeletePrompt(p.id, e)}
                      className="ml-3 p-1 text-claude-subtext/40 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end mt-4">
              <button
                type="button"
                onClick={() => setShowLoadModal(false)}
                className="px-4 py-2 text-[13px] text-claude-subtext hover:text-claude-text transition-colors"
              >
                Закрити
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
