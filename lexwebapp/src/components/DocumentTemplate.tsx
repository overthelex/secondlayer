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

import React, { useRef, useCallback } from 'react';
import { Copy, FileText, FileDown } from 'lucide-react';
import showToast from '../utils/toast';

interface DocumentTemplateProps {
  content: string;
}

/**
 * Build clean plain text from document markup (for copy).
 */
function buildCleanText(lines: string[]): string {
  return lines.map(line => {
    if (line.startsWith('>> ')) return '                    ' + line.slice(3);
    if (line.startsWith('^^ ')) return '          ' + line.slice(3);
    if (line.startsWith(':: ')) return '                    ' + line.slice(3);
    if (line.startsWith('-- ')) return '\u2500'.repeat(40);
    if (line.startsWith('** ') && line.endsWith(' **')) return line.slice(3, -3);
    return line;
  }).join('\n');
}

function escapeHTML(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Build an HTML string suitable for PDF rendering.
 * Uses inline styles so the output works standalone (no Tailwind needed).
 */
function buildDocumentHTML(lines: string[], title: string): string {
  const bodyParts = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) return '<div style="height:10px"></div>';

    if (line.startsWith('>> '))
      return `<div style="text-align:right;font-size:13px;line-height:1.6">${escapeHTML(line.slice(3))}</div>`;

    if (line.startsWith('^^ '))
      return `<div style="text-align:center;font-weight:bold;font-size:15px;letter-spacing:1px;margin:16px 0;text-transform:uppercase">${escapeHTML(line.slice(3))}</div>`;

    if (line.startsWith(':: '))
      return `<div style="text-align:right;font-size:13px;margin-top:8px;font-weight:500">${escapeHTML(line.slice(3))}</div>`;

    if (line.startsWith('-- '))
      return '<hr style="margin:12px 0;border:none;border-top:1px solid #ccc">';

    if (line.startsWith('** ') && line.endsWith(' **'))
      return `<div style="font-weight:600;font-size:14px;margin-top:16px;margin-bottom:4px">${escapeHTML(line.slice(3, -3))}</div>`;

    if (line.startsWith('    '))
      return `<p style="font-size:13px;line-height:1.7;padding-left:40px;margin:2px 0">${escapeHTML(line.trimStart())}</p>`;

    if (/^\d+\.\s/.test(trimmed))
      return `<p style="font-size:13px;line-height:1.7;padding-left:20px;margin:2px 0">${escapeHTML(trimmed)}</p>`;

    return `<p style="font-size:13px;line-height:1.7;margin:2px 0">${escapeHTML(trimmed)}</p>`;
  });

  const style = 'body{font-family:"Times New Roman",serif;margin:40px 60px;color:#222}@page{size:A4;margin:20mm 25mm}@media print{body{margin:0}}';

  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    `<title>${escapeHTML(title)}</title>`,
    `<style>${style}</style>`,
    '</head><body>',
    ...bodyParts,
    '</body></html>',
  ].join('\n');
}

/**
 * Extract a short title from the document content (first ^^ line or fallback).
 */
function extractTitle(lines: string[]): string {
  const titleLine = lines.find(l => l.startsWith('^^ '));
  return titleLine ? titleLine.slice(3).trim() : 'Документ';
}

export function DocumentTemplate({ content }: DocumentTemplateProps) {
  const lines = content.split('\n');
  const docRef = useRef<HTMLDivElement>(null);
  const title = extractTitle(lines);

  const handleCopy = useCallback(() => {
    const cleanText = buildCleanText(lines);
    navigator.clipboard.writeText(cleanText).then(() => {
      showToast.success('Документ скопійовано');
    }).catch(() => {
      showToast.error('Не вдалося скопіювати');
    });
  }, [lines]);

  const handleSavePDF = useCallback(async () => {
    try {
      showToast.info('Генерую PDF...');
      const html = buildDocumentHTML(lines, title);
      const printWindow = window.open('', '_blank');
      if (!printWindow) {
        showToast.error('Дозвольте спливаючі вікна для збереження PDF');
        return;
      }
      // Build DOM safely using DOMParser, then populate the new window
      const parser = new DOMParser();
      const parsed = parser.parseFromString(html, 'text/html');
      printWindow.document.replaceChild(
        printWindow.document.importNode(parsed.documentElement, true),
        printWindow.document.documentElement,
      );
      printWindow.document.close();
      setTimeout(() => {
        printWindow.print();
      }, 300);
    } catch (err) {
      showToast.error('Помилка при створенні PDF');
    }
  }, [lines, title]);

  const handleSaveDOCX = useCallback(async () => {
    try {
      showToast.info('Генерую DOCX...');
      const { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle } = await import('docx');
      const { saveAs } = await import('file-saver');

      const paragraphs: InstanceType<typeof Paragraph>[] = [];

      for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed) {
          paragraphs.push(new Paragraph({ text: '', spacing: { after: 100 } }));
          continue;
        }

        // >> Right-aligned
        if (line.startsWith('>> ')) {
          paragraphs.push(new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: line.slice(3), size: 24, font: 'Times New Roman' })],
            spacing: { after: 20 },
          }));
          continue;
        }

        // ^^ Centered title
        if (line.startsWith('^^ ')) {
          paragraphs.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({
              text: line.slice(3).toUpperCase(),
              bold: true,
              size: 28,
              font: 'Times New Roman',
            })],
            spacing: { before: 240, after: 240 },
          }));
          continue;
        }

        // :: Signature line
        if (line.startsWith(':: ')) {
          paragraphs.push(new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: line.slice(3), size: 24, font: 'Times New Roman' })],
            spacing: { before: 80 },
          }));
          continue;
        }

        // -- Separator
        if (line.startsWith('-- ')) {
          paragraphs.push(new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } },
            spacing: { before: 120, after: 120 },
          }));
          continue;
        }

        // ** Section header **
        if (line.startsWith('** ') && line.endsWith(' **')) {
          paragraphs.push(new Paragraph({
            children: [new TextRun({
              text: line.slice(3, -3),
              bold: true,
              size: 26,
              font: 'Times New Roman',
            })],
            spacing: { before: 200, after: 60 },
          }));
          continue;
        }

        // Indented paragraph
        if (line.startsWith('    ')) {
          paragraphs.push(new Paragraph({
            indent: { firstLine: 720 },
            children: [new TextRun({ text: line.trimStart(), size: 24, font: 'Times New Roman' })],
            spacing: { after: 20 },
          }));
          continue;
        }

        // Numbered list item
        if (/^\d+\.\s/.test(trimmed)) {
          paragraphs.push(new Paragraph({
            indent: { left: 360 },
            children: [new TextRun({ text: trimmed, size: 24, font: 'Times New Roman' })],
            spacing: { after: 20 },
          }));
          continue;
        }

        // Default body text
        paragraphs.push(new Paragraph({
          children: [new TextRun({ text: trimmed, size: 24, font: 'Times New Roman' })],
          spacing: { after: 20 },
        }));
      }

      const doc = new Document({
        sections: [{
          properties: {
            page: {
              margin: { top: 1134, right: 850, bottom: 1134, left: 1701 }, // standard UA margins
            },
          },
          children: paragraphs,
        }],
      });

      const blob = await Packer.toBlob(doc);
      const filename = title.replace(/[^\w\u0400-\u04FF\s-]/g, '').trim().slice(0, 60) || 'Документ';
      saveAs(blob, `${filename}.docx`);
      showToast.success('DOCX збережено');
    } catch (err) {
      console.error('DOCX export error:', err);
      showToast.error('Помилка при створенні DOCX');
    }
  }, [lines, title]);

  const renderLine = (line: string, idx: number) => {
    const trimmed = line.trim();

    if (!trimmed) {
      return <div key={idx} className="h-3" />;
    }

    if (line.startsWith('>> ')) {
      return (
        <div key={idx} className="text-right text-[13px] leading-[1.6] text-claude-text break-words">
          {line.slice(3)}
        </div>
      );
    }

    if (line.startsWith('^^ ')) {
      return (
        <div key={idx} className="text-center font-bold text-[15px] tracking-wide my-4 text-claude-text uppercase break-words">
          {line.slice(3)}
        </div>
      );
    }

    if (line.startsWith(':: ')) {
      return (
        <div key={idx} className="text-right text-[13px] mt-2 text-claude-text font-medium break-words">
          {line.slice(3)}
        </div>
      );
    }

    if (line.startsWith('-- ')) {
      return <hr key={idx} className="my-3 border-claude-border" />;
    }

    if (line.startsWith('** ') && line.endsWith(' **')) {
      return (
        <div key={idx} className="font-semibold text-[14px] mt-4 mb-1 text-claude-text break-words">
          {line.slice(3, -3)}
        </div>
      );
    }

    if (line.startsWith('    ')) {
      return (
        <p key={idx} className="text-[13px] leading-[1.7] text-claude-text pl-8 my-0.5 break-words">
          {line.trimStart()}
        </p>
      );
    }

    if (/^\d+\.\s/.test(trimmed)) {
      return (
        <p key={idx} className="text-[13px] leading-[1.7] text-claude-text pl-4 my-0.5 break-words">
          {trimmed}
        </p>
      );
    }

    return (
      <p key={idx} className="text-[13px] leading-[1.7] text-claude-text my-0.5 break-words">
        {trimmed}
      </p>
    );
  };

  return (
    <div className="my-4 border border-claude-border rounded-lg bg-white shadow-sm overflow-hidden" style={{ overflowWrap: 'anywhere', wordBreak: 'normal' }}>
      {/* Document toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-claude-bg/60 border-b border-claude-border">
        <span className="text-[12px] font-medium text-claude-subtext uppercase tracking-wider">
          Зразок документа
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 text-[12px] text-claude-subtext hover:text-claude-text transition-colors px-2 py-1 rounded hover:bg-claude-subtext/8"
            title="Копіювати текст"
          >
            <Copy size={12} strokeWidth={2} />
            <span className="hidden sm:inline">Копіювати</span>
          </button>
          <button
            onClick={handleSavePDF}
            className="flex items-center gap-1.5 text-[12px] text-claude-subtext hover:text-claude-text transition-colors px-2 py-1 rounded hover:bg-claude-subtext/8"
            title="Зберегти як PDF"
          >
            <FileDown size={12} strokeWidth={2} />
            <span className="hidden sm:inline">PDF</span>
          </button>
          <button
            onClick={handleSaveDOCX}
            className="flex items-center gap-1.5 text-[12px] text-claude-subtext hover:text-claude-text transition-colors px-2 py-1 rounded hover:bg-claude-subtext/8"
            title="Зберегти як DOCX"
          >
            <FileText size={12} strokeWidth={2} />
            <span className="hidden sm:inline">DOCX</span>
          </button>
        </div>
      </div>

      {/* Document body */}
      <div ref={docRef} className="px-4 sm:px-8 py-6 font-sans overflow-hidden break-words">
        {lines.map((line, idx) => renderLine(line, idx))}
      </div>
    </div>
  );
}
