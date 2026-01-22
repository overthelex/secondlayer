import React, { useState } from 'react';
import { Copy, RotateCw, User, Star, ThumbsUp, ThumbsDown, Quote, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { DecisionCard, Decision } from './DecisionCard';
import { AnalyticsBlock } from './AnalyticsBlock';
import { ThinkingSteps } from './ThinkingSteps';
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
  thinkingSteps?: Array<{
    id: string;
    title: string;
    content?: string;
    isComplete: boolean;
  }>;
}
export function Message({
  role,
  content,
  isStreaming,
  decisions,
  analytics,
  citations,
  thinkingSteps
}: MessageProps) {
  const isUser = role === 'user';
  const [showThinking, setShowThinking] = useState(false);
  // Parse content for legal citations and headings
  const renderContent = (text: string) => {
    return <div className="space-y-4">
        {text.split('\n\n').map((paragraph, idx) => {
        // Check if this is a heading (starts with #)
        if (paragraph.startsWith('# ')) {
          return <h3 key={idx} className="font-sans text-[19px] font-bold text-claude-text mt-6 mb-3">
                {paragraph.replace('# ', '')}
              </h3>;
        }
        // Check if this is a subheading (starts with ##)
        if (paragraph.startsWith('## ')) {
          return <h4 key={idx} className="font-sans text-[17px] font-semibold text-claude-text mt-5 mb-2">
                {paragraph.replace('## ', '')}
              </h4>;
        }
        // Check if this is a numbered list item
        if (/^\d+\.\s/.test(paragraph)) {
          const items = paragraph.split('\n').filter((line) => /^\d+\.\s/.test(line));
          return <ol key={idx} className="list-decimal list-inside space-y-2 ml-2">
                {items.map((item, i) => <li key={i} className="text-[15px] leading-[1.7]">
                    {item.replace(/^\d+\.\s/, '')}
                  </li>)}
              </ol>;
        }
        // Check if this is a bulleted list
        if (paragraph.startsWith('- ')) {
          const items = paragraph.split('\n').filter((line) => line.startsWith('- '));
          return <ul key={idx} className="space-y-2 ml-2">
                {items.map((item, i) => <li key={i} className="flex items-start gap-3 text-[15px] leading-[1.7]">
                    <span className="text-claude-text mt-1.5">•</span>
                    <span>{item.replace('- ', '')}</span>
                  </li>)}
              </ul>;
        }
        return <p key={idx} className="whitespace-pre-wrap m-0 leading-[1.7]">
              {paragraph.split(/(ЦКУ|ГКУ|КПК|ЦПК)\s+(ст\.|статт[яі])\s*\d+/g).map((part, i) => {
            if (['ЦКУ', 'ГКУ', 'КПК', 'ЦПК'].includes(part)) {
              return <span key={i} className="font-semibold text-claude-text">
                        {part}
                      </span>;
            }
            return <span key={i}>{part}</span>;
          })}
            </p>;
      })}
      </div>;
  };
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

              {/* Main Content */}
              <div className="font-sans text-[16px] text-claude-text">
                {renderContent(content)}
                {isStreaming && <span className="inline-block w-[2px] h-[18px] ml-1 bg-claude-text/40 animate-pulse align-middle rounded-[1px]" />}
              </div>

              {/* Citations */}
              {citations && citations.length > 0 && <div className="space-y-3 mt-5">
                  {citations.map((citation, idx) => <motion.div key={idx} initial={{
              opacity: 0,
              x: -10
            }} animate={{
              opacity: 1,
              x: 0
            }} transition={{
              duration: 0.3,
              delay: idx * 0.1
            }} className="bg-claude-bg/80 backdrop-blur-sm border-l-4 border-claude-text/20 pl-5 pr-4 py-4 rounded-r-xl shadow-sm">
                      <div className="flex items-start gap-4">
                        <div className="text-5xl leading-none text-claude-subtext/20 font-serif select-none -mt-2">
                          "
                        </div>
                        <div className="flex-1 -mt-1">
                          <p className="font-sans text-[15px] text-claude-text italic leading-relaxed mb-2">
                            {citation.text}
                          </p>
                          <p className="text-[12px] text-claude-subtext font-semibold">
                            — {citation.source}
                          </p>
                        </div>
                      </div>
                    </motion.div>)}
                </div>}

              {/* Decision Cards */}
              {decisions && decisions.length > 0 && <div className="mt-5 space-y-3">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-claude-text">
                    <div className="w-1 h-4 bg-claude-subtext/40 rounded-full" />
                    Релевантные судебные решения
                    <span className="text-[11px] font-semibold text-claude-subtext bg-claude-subtext/8 px-2 py-0.5 rounded-full">
                      {decisions.length}
                    </span>
                  </div>
                  <div className="grid gap-3">
                    {decisions.map((decision, idx) => <motion.div key={decision.id} initial={{
                opacity: 0,
                y: 10
              }} animate={{
                opacity: 1,
                y: 0
              }} transition={{
                duration: 0.3,
                delay: idx * 0.1
              }}>
                        <DecisionCard decision={decision} />
                      </motion.div>)}
                  </div>
                </div>}

              {/* Analytics Block */}
              {analytics && <AnalyticsBlock data={analytics} />}

              {/* Actions */}
              {!isStreaming && <div className="flex items-center gap-1 pt-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                  <button className="p-1.5 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-md transition-all duration-200" aria-label="Copy message" title="Копировать">
                    <Copy size={13} strokeWidth={2} />
                  </button>
                  <button className="p-1.5 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-md transition-all duration-200" aria-label="Save to favorites" title="Сохранить в избранное">
                    <Star size={13} strokeWidth={2} />
                  </button>
                  <button className="p-1.5 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-md transition-all duration-200" aria-label="Regenerate response" title="Регенерировать">
                    <RotateCw size={13} strokeWidth={2} />
                  </button>
                  <div className="w-px h-3 bg-claude-border mx-1" />
                  <button className="p-1.5 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/10 rounded-md transition-all duration-200" aria-label="Good response" title="Хороший ответ">
                    <ThumbsUp size={13} strokeWidth={2} />
                  </button>
                  <button className="p-1.5 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/10 rounded-md transition-all duration-200" aria-label="Bad response" title="Плохой ответ">
                    <ThumbsDown size={13} strokeWidth={2} />
                  </button>
                </div>}
            </div>
          </div>}
      </div>
    </motion.div>;
}