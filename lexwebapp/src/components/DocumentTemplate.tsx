/**
 * DocumentTemplate — renders legal document text (позовна заява, скарга, клопотання)
 * as a formatted document with proper alignment, indentation, and typography.
 *
 * Expects plain text with line-based structure:
 * - Lines starting with >> are right-aligned (court header, plaintiff/defendant info)
 * - Lines starting with ^^ are centered (document title like ПОЗОВНА ЗАЯВА)
 * - Lines starting with :: are signature/date lines (right-aligned, bold)
 * - Lines starting with -- are separator lines
 * - Lines starting with ** are section headers (bold)
 * - Lines starting with  (4 spaces) are indented paragraphs
 * - Everything else is normal body text
 */

import React from 'react';
import { Copy, Download } from 'lucide-react';
import showToast from '../utils/toast';

interface DocumentTemplateProps {
  content: string;
}

export function DocumentTemplate({ content }: DocumentTemplateProps) {
  const lines = content.split('\n');

  const handleCopy = () => {
    // Copy clean text without formatting markers
    const cleanText = lines.map(line => {
      if (line.startsWith('>> ')) return '                    ' + line.slice(3);
      if (line.startsWith('^^ ')) return '          ' + line.slice(3);
      if (line.startsWith(':: ')) return '                    ' + line.slice(3);
      if (line.startsWith('-- ')) return '─'.repeat(40);
      if (line.startsWith('** ') && line.endsWith(' **')) return line.slice(3, -3);
      return line;
    }).join('\n');
    navigator.clipboard.writeText(cleanText).then(() => {
      showToast.success('Документ скопійовано');
    }).catch(() => {
      showToast.error('Не вдалося скопіювати');
    });
  };

  const renderLine = (line: string, idx: number) => {
    const trimmed = line.trim();

    // Empty line = paragraph break
    if (!trimmed) {
      return <div key={idx} className="h-3" />;
    }

    // >> Right-aligned text (court header, addresses)
    if (line.startsWith('>> ')) {
      return (
        <div key={idx} className="text-right text-[13px] leading-[1.6] text-claude-text">
          {line.slice(3)}
        </div>
      );
    }

    // ^^ Centered text (document title)
    if (line.startsWith('^^ ')) {
      return (
        <div key={idx} className="text-center font-bold text-[15px] tracking-wide my-4 text-claude-text uppercase">
          {line.slice(3)}
        </div>
      );
    }

    // :: Signature / date line (right-aligned, styled)
    if (line.startsWith(':: ')) {
      return (
        <div key={idx} className="text-right text-[13px] mt-2 text-claude-text font-medium">
          {line.slice(3)}
        </div>
      );
    }

    // -- Separator
    if (line.startsWith('-- ')) {
      return <hr key={idx} className="my-3 border-claude-border" />;
    }

    // ** Bold section header **
    if (line.startsWith('** ') && line.endsWith(' **')) {
      return (
        <div key={idx} className="font-semibold text-[14px] mt-4 mb-1 text-claude-text">
          {line.slice(3, -3)}
        </div>
      );
    }

    // Indented paragraph (starts with 4 spaces)
    if (line.startsWith('    ')) {
      return (
        <p key={idx} className="text-[13px] leading-[1.7] text-claude-text pl-8 my-0.5">
          {line.trimStart()}
        </p>
      );
    }

    // Numbered list item (1. 2. etc.)
    if (/^\d+\.\s/.test(trimmed)) {
      return (
        <p key={idx} className="text-[13px] leading-[1.7] text-claude-text pl-4 my-0.5">
          {trimmed}
        </p>
      );
    }

    // Default body text
    return (
      <p key={idx} className="text-[13px] leading-[1.7] text-claude-text my-0.5">
        {trimmed}
      </p>
    );
  };

  return (
    <div className="my-4 border border-claude-border rounded-lg bg-white shadow-sm overflow-hidden">
      {/* Document toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-claude-bg/60 border-b border-claude-border">
        <span className="text-[12px] font-medium text-claude-subtext uppercase tracking-wider">
          Зразок документа
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 text-[12px] text-claude-subtext hover:text-claude-text transition-colors px-2 py-1 rounded hover:bg-claude-subtext/8"
          title="Копіювати текст документа"
        >
          <Copy size={12} strokeWidth={2} />
          Копіювати
        </button>
      </div>

      {/* Document body */}
      <div className="px-8 py-6 font-serif">
        {lines.map((line, idx) => renderLine(line, idx))}
      </div>
    </div>
  );
}
