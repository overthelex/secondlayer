import React, { useState, useCallback } from 'react';
import { Copy, RotateCw, Star, ThumbsUp, ThumbsDown, ChevronDown } from 'lucide-react';
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
  onRegenerate
}: MessageProps) {
  const isUser = role === 'user';
  const [showThinking, setShowThinking] = useState(false);
  const [starred, setStarred] = useState(false);
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);

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
        {isUser ? <div className="flex justify-end">
            <div className="max-w-[85%] bg-claude-bg/60 backdrop-blur-sm border border-claude-border/50 rounded-2xl px-4 py-3 shadow-sm">
              <p className="font-sans text-[15px] text-claude-text leading-relaxed whitespace-pre-wrap">
                {content}
              </p>
            </div>
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
                prose-h1:text-[19px] prose-h1:font-bold prose-h1:mt-6 prose-h1:mb-3
                prose-h2:text-[17px] prose-h2:font-semibold prose-h2:mt-5 prose-h2:mb-2
                prose-h3:text-[15px] prose-h3:font-semibold prose-h3:mt-4 prose-h3:mb-2
                prose-p:leading-[1.7] prose-p:my-2
                prose-ul:my-2 prose-ol:my-2
                prose-li:leading-[1.7]
                prose-code:text-[13px] prose-code:bg-claude-bg prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:border prose-code:border-claude-border prose-code:font-mono prose-code:before:content-none prose-code:after:content-none
                prose-pre:bg-claude-bg prose-pre:border prose-pre:border-claude-border prose-pre:rounded-lg prose-pre:my-3
                prose-blockquote:border-l-4 prose-blockquote:border-claude-text/20 prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:text-claude-subtext
                prose-table:text-[13px]
                prose-th:bg-claude-bg prose-th:px-3 prose-th:py-2 prose-th:text-left prose-th:font-semibold prose-th:border prose-th:border-claude-border
                prose-td:px-3 prose-td:py-2 prose-td:border prose-td:border-claude-border
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
                      <h1 className="text-[19px] font-bold mt-6 mb-3 text-claude-text">{children}</h1>
                    ),
                    h2: ({ children }) => (
                      <h2 className="text-[17px] font-semibold mt-5 mb-2 text-claude-text">{children}</h2>
                    ),
                    h3: ({ children }) => (
                      <h3 className="text-[15px] font-semibold mt-4 mb-2 text-claude-text">{children}</h3>
                    ),
                    h4: ({ children }) => (
                      <h4 className="text-[14px] font-semibold mt-3 mb-1 text-claude-text">{children}</h4>
                    ),
                    ul: ({ children }) => (
                      <ul className="my-2 pl-6 list-disc text-claude-text">{children}</ul>
                    ),
                    ol: ({ children }) => (
                      <ol className="my-2 pl-6 list-decimal text-claude-text">{children}</ol>
                    ),
                    li: ({ children }) => (
                      <li className="leading-[1.7] text-claude-text my-0.5">{children}</li>
                    ),
                    strong: ({ children }) => (
                      <strong className="font-semibold text-claude-text">{children}</strong>
                    ),
                    em: ({ children }) => (
                      <em className="italic text-claude-text">{children}</em>
                    ),
                    blockquote: ({ children }) => (
                      <blockquote className="border-l-4 border-claude-text/20 pl-4 italic text-claude-subtext my-3">{children}</blockquote>
                    ),
                    hr: () => (
                      <hr className="my-4 border-claude-border" />
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
                        <code className="text-[13px] bg-claude-bg px-1.5 py-0.5 rounded border border-claude-border font-mono text-claude-text" {...props}>
                          {children}
                        </code>
                      );
                    },
                    a: ({ href, children }) => (
                      <a href={href} className="text-claude-text underline decoration-claude-subtext/30 hover:decoration-claude-text" target="_blank" rel="noopener noreferrer">{children}</a>
                    ),
                    table: ({ children }) => (
                      <div className="overflow-x-auto my-3">
                        <table className="text-[13px] w-full text-claude-text">{children}</table>
                      </div>
                    ),
                    th: ({ children }) => (
                      <th className="bg-claude-bg px-3 py-2 text-left font-semibold border border-claude-border text-claude-text">{children}</th>
                    ),
                    td: ({ children }) => (
                      <td className="px-3 py-2 border border-claude-border text-claude-text">{children}</td>
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
