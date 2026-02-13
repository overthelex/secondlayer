import React from 'react';
import { motion } from 'framer-motion';
import {
  FileText,
  MoreVertical,
  ChevronUp,
  ChevronDown,
  Image,
  Film,
  FileSpreadsheet,
} from 'lucide-react';
import type { VaultDocument, SortField, SortOrder } from './types';

const DOC_TYPE_LABELS: Record<string, string> = {
  contract: 'Договір',
  legislation: 'Законодавство',
  court_decision: 'Судове рішення',
  internal: 'Внутрішній',
  other: 'Інше',
};

const DOC_TYPE_COLORS: Record<string, string> = {
  contract: 'bg-blue-50 text-blue-700 border-blue-200',
  legislation: 'bg-purple-50 text-purple-700 border-purple-200',
  court_decision: 'bg-amber-50 text-amber-700 border-amber-200',
  internal: 'bg-green-50 text-green-700 border-green-200',
  other: 'bg-gray-50 text-gray-700 border-gray-200',
};

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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getFileIcon(mimeType?: string) {
  if (!mimeType) return FileText;
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

interface DocumentTableProps {
  documents: VaultDocument[];
  sortBy: SortField;
  sortOrder: SortOrder;
  onSort: (field: SortField) => void;
  onDocumentClick: (doc: VaultDocument) => void;
}

function SortIcon({ field, sortBy, sortOrder }: { field: SortField; sortBy: SortField; sortOrder: SortOrder }) {
  if (field !== sortBy) {
    return <ChevronDown size={12} className="text-claude-subtext/20" />;
  }
  return sortOrder === 'asc'
    ? <ChevronUp size={12} className="text-claude-text" />
    : <ChevronDown size={12} className="text-claude-text" />;
}

function SortableHeader({
  label,
  field,
  sortBy,
  sortOrder,
  onSort,
  className = '',
}: {
  label: string;
  field: SortField;
  sortBy: SortField;
  sortOrder: SortOrder;
  onSort: (field: SortField) => void;
  className?: string;
}) {
  return (
    <th
      className={`text-left px-5 py-3 text-[11px] font-semibold text-claude-subtext/60 uppercase tracking-wider font-sans cursor-pointer select-none hover:text-claude-text transition-colors ${className}`}
      onClick={() => onSort(field)}
    >
      <div className="flex items-center gap-1">
        {label}
        <SortIcon field={field} sortBy={sortBy} sortOrder={sortOrder} />
      </div>
    </th>
  );
}

export function DocumentTable({ documents, sortBy, sortOrder, onSort, onDocumentClick }: DocumentTableProps) {
  return (
    <div className="bg-white rounded-2xl border border-claude-border shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-claude-border/50">
              <SortableHeader label="Назва" field="title" sortBy={sortBy} sortOrder={sortOrder} onSort={onSort} />
              <SortableHeader label="Тип" field="type" sortBy={sortBy} sortOrder={sortOrder} onSort={onSort} />
              <SortableHeader label="Дата" field="uploadedAt" sortBy={sortBy} sortOrder={sortOrder} onSort={onSort} />
              <th className="text-left px-5 py-3 text-[11px] font-semibold text-claude-subtext/60 uppercase tracking-wider font-sans">
                Розмір
              </th>
              <th className="text-left px-5 py-3 text-[11px] font-semibold text-claude-subtext/60 uppercase tracking-wider font-sans hidden md:table-cell">
                Теги
              </th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody className="divide-y divide-claude-border/30">
            {documents.map((doc, index) => {
              const Icon = getFileIcon(doc.metadata?.mimeType);
              return (
                <motion.tr
                  key={doc.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.03 }}
                  className="hover:bg-claude-bg/50 transition-colors group cursor-pointer"
                  onClick={() => onDocumentClick(doc)}
                >
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <Icon
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
                  <td className="px-5 py-3 text-xs text-claude-subtext/60 font-sans whitespace-nowrap">
                    {doc.metadata?.documentDate
                      ? formatDate(doc.metadata.documentDate)
                      : doc.metadata?.uploadedAt
                      ? formatDate(doc.metadata.uploadedAt)
                      : '—'}
                  </td>
                  <td className="px-5 py-3 text-xs text-claude-subtext/60 font-sans whitespace-nowrap">
                    {doc.metadata?.fileSize
                      ? formatFileSize(doc.metadata.fileSize)
                      : '—'}
                  </td>
                  <td className="px-5 py-3 hidden md:table-cell">
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
                    <button
                      className="p-1 text-claude-subtext/30 hover:text-claude-text transition-colors opacity-0 group-hover:opacity-100"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MoreVertical size={14} />
                    </button>
                  </td>
                </motion.tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
