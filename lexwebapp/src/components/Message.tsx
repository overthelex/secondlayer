import React, { useState, useCallback, useRef, useEffect, useContext, createContext } from 'react';
import { Copy, RotateCw, Star, ThumbsUp, ThumbsDown, ChevronDown, Pencil, Check, X } from 'lucide-react';

// Context to pass list type (ul/ol) down to li without prop drilling
const ListTypeContext = createContext<'ul' | 'ol'>('ul');

// Defined outside Message to avoid remounting on each render (react-markdown rule)
function MdLi({ children }: { children?: React.ReactNode }) {
  const listType = useContext(ListTypeContext);
  // Ordered list: rely on CSS list-decimal + marker coloring from parent ol
  if (listType === 'ol') {
    return (
      <li className="leading-[1.7] text-claude-text pl-1">{children}</li>
    );
  }
  // Unordered list: custom dot bullet via flex
  return (
    <li className="flex gap-2.5 leading-[1.7] text-claude-text list-none">
      <span className="flex-shrink-0 mt-[10px] w-[6px] h-[6px] rounded-full bg-claude-accent/65 select-none" aria-hidden />
      <span className="flex-1">{children}</span>
    </li>
  );
}
import { motion, AnimatePresence } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Decision } from './DecisionCard';
import { AnalyticsBlock } from './AnalyticsBlock';
import { ThinkingSteps } from './ThinkingSteps';
import { PlanDisplay } from './PlanDisplay';
import { DocumentTemplate } from './DocumentTemplate';
import { CostSummary } from './CostSummary';
import showToast from '../utils/toast';
import type { ExecutionPlan, CitationWarning, CostSummary as CostSummaryType } from '../types/models/Message';

export type MessageRole = 'user' | 'assistant';
export interface MessageProps {
  id: string;
  role: MessageRole;
  content: string;
  isStreaming?: boolean;
  decisions?: Decision[];
  analytics?: {
    totalCases: number;
    satisfied: number;
    rejected: number;
    partial: number;
    trend: 'up' | 'down' | 'stable';
    interpretation: string;
  };
  citations?: Array<{
    text: string;
    source: string;
  }>;
  documents?: Array<{
    id: string;
    title: string;
    type: string;
  }>;
  thinkingSteps?: Array<{
    id: string;
    title: string;
    content?: string;
    isComplete: boolean;
  }>;
  executionPlan?: ExecutionPlan;
  citationWarnings?: CitationWarning[];
  costSummary?: CostSummaryType;
  onRegenerate?: () => void;
  onEdit?: (newContent: string) => void;
}

/**
 * Highlight legal code references in text
 */
function highlightLegalCodes(text: string): React.ReactNode {
  const parts = text.split(/((?:ЦКУ|ГКУ|КПК|ЦПК|ГПК|КАС|ПКУ|СКУ|ККУ|КЗпП)\s+(?:ст\.|статт[яі])\s*\d+)/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) => {
    if (/^(?:ЦКУ|ГКУ|КПК|ЦПК|ГПК|КАС|ПКУ|СКУ|ККУ|КЗпП)/.test(part)) {
      return <span key={i} className="font-semibold text-claude-text">{part}</span>;
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

/**
 * Detect if content is raw JSON that the LLM echoed instead of synthesizing.
 */
function isRawJsonContent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    const parsed = JSON.parse(trimmed);
    // MCP content array format or tool result objects
    if (parsed?.content && Array.isArray(parsed.content)) return true;
    if (parsed?.source_case || parsed?.similar_cases || parsed?.results) return true;
    if (parsed?.legislation || parsed?.articles) return true;
    // Registry / RADA / procedural results
    if (parsed?.entities || parsed?.bills || parsed?.deputies) return true;
    if (parsed?.deadlines || parsed?.checklist || parsed?.risk_score != null) return true;
    if (parsed?.beneficiaries || parsed?.votings || parsed?.findings) return true;
    // Generic large JSON objects (>500 chars) are likely raw tool results
    if (trimmed.length > 500) return true;
    return false;
  } catch {
    return false;
  }
}

export function Message({
  role,
  content,
  isStreaming,
  decisions,
  analytics,
  citations,
  documents,
  thinkingSteps,
  executionPlan,
  citationWarnings,
  costSummary,
  onRegenerate,
  onEdit,
}: MessageProps) {
  const isUser = role === 'user';
  const [showThinking, setShowThinking] = useState(false);
  const [starred, setStarred] = useState(false);
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.selectionStart = textareaRef.current.value.length;
    }
  }, [isEditing]);

  const handleEditSave = useCallback(() => {
    const trimmed = editDraft.trim();
    if (trimmed && trimmed !== content) {
      onEdit?.(trimmed);
    }
    setIsEditing(false);
  }, [editDraft, content, onEdit]);

  const handleEditCancel = useCallback(() => {
    setEditDraft(content);
    setIsEditing(false);
  }, [content]);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleEditSave();
    }
    if (e.key === 'Escape') {
      handleEditCancel();
    }
  }, [handleEditSave, handleEditCancel]);

  // Guard: if content is raw JSON and we have extracted evidence, don't show it
  const hasEvidence = (decisions && decisions.length > 0) || (citations && citations.length > 0) || (documents && documents.length > 0);
  const displayContent = (!isUser && !isStreaming && isRawJsonContent(content) && hasEvidence)
    ? 'Результати відображені на панелі праворуч.'
    : content;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      showToast.success('Скопійовано');
    }).catch(() => {
      showToast.error('Не вдалося скопіювати');
    });
  }, [content]);

  const handleStar = useCallback(() => {
    setStarred((prev) => !prev);
    showToast.info(starred ? 'Вилучено з обраного' : 'Збережено в обране');
  }, [starred]);

  const handleFeedback = useCallback((type: 'up' | 'down') => {
    setFeedback((prev) => prev === type ? null : type);
    if (feedback !== type) {
      showToast.info(type === 'up' ? 'Дякуємо за відгук!' : 'Дякуємо, врахуємо');
    }
  }, [feedback]);

  return <motion.div initial={{
    opacity: 0,
    y: 8
  }} animate={{
    opacity: 1,
    y: 0
  }} transition={{
    duration: 0.4,
    ease: [0.22, 1, 0.36, 1]
  }} className="group w-full py-5 md:py-6">
      <div className="max-w-3xl mx-auto px-4 md:px-6">
        {/* User Message */}
        {isUser ? <div className="flex flex-col items-end gap-1.5">
            {isEditing ? (
              <div className="w-full max-w-[85%]">
                <textarea
                  ref={textareaRef}
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  onKeyDown={handleEditKeyDown}
                  rows={Math.min(10, editDraft.split('\n').length + 1)}
                  className="w-full bg-claude-bg/80 border border-claude-text/30 rounded-2xl px-4 py-3 text-[15px] text-claude-text leading-relaxed resize-none focus:outline-none focus:border-claude-text/60 shadow-sm"
                />
                <div className="flex items-center justify-end gap-2 mt-1.5">
                  <span className="text-[11px] text-claude-subtext">⌘↵ зберегти · Esc скасувати</span>
                  <button
                    onClick={handleEditCancel}
                    className="flex items-center gap-1 px-2.5 py-1 text-[12px] text-claude-subtext hover:text-claude-text border border-claude-border rounded-lg transition-colors"
                  >
                    <X size={11} strokeWidth={2} /> Скасувати
                  </button>
                  <button
                    onClick={handleEditSave}
                    className="flex items-center gap-1 px-2.5 py-1 text-[12px] text-claude-text border border-claude-border bg-claude-bg rounded-lg hover:bg-claude-subtext/10 transition-colors"
                  >
                    <Check size={11} strokeWidth={2.5} /> Надіслати
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="max-w-[85%] bg-claude-bg/60 backdrop-blur-sm border border-claude-border/50 rounded-2xl px-4 py-3 shadow-sm">
                  <p className="font-sans text-[15px] text-claude-text leading-relaxed whitespace-pre-wrap">
                    {content}
                  </p>
                </div>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                  <button
                    onClick={handleCopy}
                    className="p-1.5 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-md transition-all duration-200"
                    title="Копіювати"
                  >
                    <Copy size={12} strokeWidth={2} />
                  </button>
                  {onEdit && (
                    <button
                      onClick={() => { setEditDraft(content); setIsEditing(true); }}
                      className="p-1.5 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-md transition-all duration-200"
                      title="Редагувати"
                    >
                      <Pencil size={12} strokeWidth={2} />
                    </button>
                  )}
                </div>
              </>
            )}
          </div> /* Assistant Message */ : <div className="flex gap-3 md:gap-4">
            {/* Avatar */}
            <div className="flex-shrink-0 mt-1">
              <div className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center">
                <img src="/Image_1.jpg" alt="Lex" className="w-full h-full object-cover" />
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0 space-y-4">
              {/* Execution Plan */}
              {executionPlan && <PlanDisplay plan={executionPlan} />}

              {/* Thinking Steps */}
              {thinkingSteps && thinkingSteps.length > 0 && <div>
                  <button onClick={() => setShowThinking(!showThinking)} className="flex items-center gap-2 text-[13px] text-claude-subtext hover:text-claude-text transition-colors mb-2">
                    <ChevronDown size={14} className={`transition-transform ${showThinking ? 'rotate-180' : ''}`} strokeWidth={2} />
                    <span className="font-medium">
                      {thinkingSteps[0]?.title || 'Обдумую відповідь...'}
                    </span>
                  </button>

                  <AnimatePresence>
                    {showThinking && <ThinkingSteps steps={thinkingSteps} isThinking={isStreaming} />}
                  </AnimatePresence>
                </div>}

              {/* Main Content - Markdown */}
              <div className="font-sans text-[16px] text-claude-text prose prose-sm max-w-none
                prose-headings:font-sans prose-headings:text-claude-text prose-headings:tracking-tight
                prose-p:leading-[1.7] prose-p:my-2
                prose-code:before:content-none prose-code:after:content-none
                prose-a:text-claude-text prose-a:underline prose-a:decoration-claude-subtext/30 hover:prose-a:decoration-claude-text
                prose-strong:text-claude-text prose-strong:font-semibold
              ">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    p: ({ children }) => (
                      <p className="whitespace-pre-wrap m-0 leading-[1.7] my-2 text-claude-text">
                        {React.Children.map(children, (child) =>
                          typeof child === 'string' ? highlightLegalCodes(child) : child
                        )}
                      </p>
                    ),
                    h1: ({ children }) => (
                      <h1 className="text-[20px] font-bold mt-7 mb-3 text-claude-text tracking-tight pb-2 border-b border-claude-border">{children}</h1>
                    ),
                    h2: ({ children }) => (
                      <h2 className="text-[17px] font-semibold mt-6 mb-3 text-claude-text tracking-tight pb-2 border-b border-claude-border/70">{children}</h2>
                    ),
                    h3: ({ children }) => (
                      <h3 className="flex items-baseline gap-2 text-[15px] font-semibold mt-5 mb-2 text-claude-text">
                        <span className="flex-shrink-0 w-[3px] h-[14px] self-center rounded-full bg-claude-accent/70" />
                        <span>{children}</span>
                      </h3>
                    ),
                    h4: ({ children }) => (
                      <h4 className="text-[14px] font-semibold mt-4 mb-1.5 text-claude-subtext uppercase tracking-wide">{children}</h4>
                    ),
                    ul: ({ children }) => (
                      <ListTypeContext.Provider value="ul">
                        <ul className="my-3 pl-0 space-y-1 list-none text-claude-text">{children}</ul>
                      </ListTypeContext.Provider>
                    ),
                    ol: ({ children }) => (
                      <ListTypeContext.Provider value="ol">
                        <ol className="my-3 pl-6 space-y-1.5 list-decimal marker:text-claude-accent/80 marker:font-semibold text-claude-text">{children}</ol>
                      </ListTypeContext.Provider>
                    ),
                    li: MdLi,
                    strong: ({ children }) => (
                      <strong className="font-semibold text-claude-text">{children}</strong>
                    ),
                    em: ({ children }) => (
                      <em className="italic text-claude-text">{children}</em>
                    ),
                    blockquote: ({ children }) => (
                      <blockquote className="my-4 pl-4 pr-3 py-3 border-l-[3px] border-claude-accent/60 bg-claude-sidebar rounded-r-lg text-claude-text/85 text-[15px] leading-relaxed">
                        {children}
                      </blockquote>
                    ),
                    hr: () => (
                      <hr className="my-5 border-claude-border" />
                    ),
                    pre: ({ children }) => {
                      // Check if this pre contains a document code block
                      const child = React.Children.toArray(children)[0] as React.ReactElement;
                      if (child?.props?.className?.includes('language-document')) {
                        // Render as DocumentTemplate — extract text content
                        const text = String(child.props.children || '').replace(/\n$/, '');
                        return <DocumentTemplate content={text} />;
                      }
                      return (
                        <pre className="bg-claude-sidebar border border-claude-border rounded-lg my-3 p-4 overflow-x-auto text-claude-text text-[13px]">{children}</pre>
                      );
                    },
                    code: ({ className, children, ...props }) => {
                      const isBlock = className?.includes('language-');
                      if (isBlock) {
                        return <code className={`font-mono text-claude-text ${className || ''}`} {...props}>{children}</code>;
                      }
                      return (
                        <code className="text-[13px] bg-claude-sidebar px-1.5 py-0.5 rounded border border-claude-border font-mono text-claude-text" {...props}>
                          {children}
                        </code>
                      );
                    },
                    a: ({ href, children }) => (
                      <a href={href} className="text-claude-text underline decoration-claude-subtext/30 hover:decoration-claude-text" target="_blank" rel="noopener noreferrer">{children}</a>
                    ),
                    table: ({ children }) => (
                      <div className="overflow-x-auto my-4 rounded-lg border border-claude-border shadow-sm">
                        <table className="w-full text-[13px] text-claude-text border-collapse">{children}</table>
                      </div>
                    ),
                    thead: ({ children }) => (
                      <thead className="bg-claude-sidebar border-b border-claude-border">{children}</thead>
                    ),
                    tbody: ({ children }) => (
                      <tbody className="divide-y divide-claude-border/60">{children}</tbody>
                    ),
                    tr: ({ children }) => (
                      <tr className="even:bg-claude-bg/40 hover:bg-claude-sidebar/80 transition-colors">{children}</tr>
                    ),
                    th: ({ children }) => (
                      <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-claude-subtext uppercase tracking-wide whitespace-nowrap">{children}</th>
                    ),
                    td: ({ children }) => (
                      <td className="px-4 py-2.5 text-claude-text align-top">{children}</td>
                    ),
                  }}
                >
                  {displayContent}
                </ReactMarkdown>
                {isStreaming && <span className="inline-block w-[2px] h-[18px] ml-1 bg-claude-text/40 animate-pulse align-middle rounded-[1px]" />}
              </div>

              {/* Citation Warnings (Shepardization) */}
              {citationWarnings && citationWarnings.length > 0 && (
                <div className="space-y-2 mt-4">
                  {citationWarnings.map((warning, idx) => (
                    <motion.div
                      key={`cw-${idx}`}
                      initial={{ opacity: 0, y: -5 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.3, delay: idx * 0.1 }}
                      className={`flex items-start gap-3 px-4 py-3 rounded-lg border ${
                        warning.status === 'explicitly_overruled'
                          ? 'bg-orange-50/70 border-orange-200 dark:bg-orange-950/20 dark:border-orange-800/50'
                          : 'bg-amber-50/70 border-amber-200 dark:bg-amber-950/20 dark:border-amber-800/50'
                      }`}
                    >
                      <span className="text-base mt-0.5 opacity-70">
                        {warning.status === 'explicitly_overruled' ? '\u{1F4CB}' : '\u{1F4CC}'}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm ${
                          warning.status === 'explicitly_overruled'
                            ? 'text-orange-700 dark:text-orange-300'
                            : 'text-amber-700 dark:text-amber-300'
                        }`}>
                          {warning.message}
                        </p>
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                          {warning.status === 'explicitly_overruled' ? 'Скасовано вищою інстанцією' : 'Частково змінено'} &middot; впевненість: {Math.round(warning.confidence * 100)}%
                        </p>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}

              {/* Analytics Block */}
              {analytics && <AnalyticsBlock data={analytics} />}

              {/* Cost Summary */}
              {costSummary && !isStreaming && (
                <CostSummary data={costSummary} />
              )}

              {/* Actions */}
              {!isStreaming && content && <div className="flex items-center gap-1 pt-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                  <button
                    onClick={handleCopy}
                    className="p-1.5 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-md transition-all duration-200"
                    aria-label="Copy message"
                    title="Копіювати"
                  >
                    <Copy size={13} strokeWidth={2} />
                  </button>
                  <button
                    onClick={handleStar}
                    className={`p-1.5 hover:bg-claude-subtext/8 rounded-md transition-all duration-200 ${starred ? 'text-claude-text' : 'text-claude-subtext hover:text-claude-text'}`}
                    aria-label="Save to favorites"
                    title="Зберегти в обране"
                  >
                    <Star size={13} strokeWidth={2} fill={starred ? 'currentColor' : 'none'} />
                  </button>
                  {onRegenerate && (
                    <button
                      onClick={onRegenerate}
                      className="p-1.5 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-md transition-all duration-200"
                      aria-label="Regenerate response"
                      title="Повторити"
                    >
                      <RotateCw size={13} strokeWidth={2} />
                    </button>
                  )}
                  <div className="w-px h-3 bg-claude-border mx-1" />
                  <button
                    onClick={() => handleFeedback('up')}
                    className={`p-1.5 hover:bg-claude-subtext/10 rounded-md transition-all duration-200 ${feedback === 'up' ? 'text-claude-text' : 'text-claude-subtext hover:text-claude-text'}`}
                    aria-label="Good response"
                    title="Гарна відповідь"
                  >
                    <ThumbsUp size={13} strokeWidth={2} fill={feedback === 'up' ? 'currentColor' : 'none'} />
                  </button>
                  <button
                    onClick={() => handleFeedback('down')}
                    className={`p-1.5 hover:bg-claude-subtext/10 rounded-md transition-all duration-200 ${feedback === 'down' ? 'text-claude-text' : 'text-claude-subtext hover:text-claude-text'}`}
                    aria-label="Bad response"
                    title="Погана відповідь"
                  >
                    <ThumbsDown size={13} strokeWidth={2} fill={feedback === 'down' ? 'currentColor' : 'none'} />
                  </button>
                </div>}
            </div>
          </div>}
      </div>
    </motion.div>;
}
