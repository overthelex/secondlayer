import React from 'react';
import { motion } from 'framer-motion';
import {
  FileText,
  Image,
  Film,
  FileSpreadsheet,
} from 'lucide-react';
import type { VaultDocument } from './types';

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

interface DocumentGridProps {
  documents: VaultDocument[];
  onDocumentClick: (doc: VaultDocument) => void;
}

export function DocumentGrid({ documents, onDocumentClick }: DocumentGridProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {documents.map((doc, index) => {
        const Icon = getFileIcon(doc.metadata?.mimeType);
        return (
          <motion.div
            key={doc.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.03 }}
            className="bg-white rounded-2xl border border-claude-border p-4 hover:shadow-md transition-all group cursor-pointer"
            onClick={() => onDocumentClick(doc)}
          >
            <div className="flex items-start justify-between mb-3">
              <div className="p-2 bg-claude-subtext/5 rounded-lg">
                <Icon size={20} className="text-claude-subtext/50" />
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
            <div className="flex items-center gap-2">
              <p className="text-xs text-claude-subtext/50 font-sans">
                {doc.metadata?.documentDate
                  ? formatDate(doc.metadata.documentDate)
                  : doc.metadata?.uploadedAt
                  ? formatDate(doc.metadata.uploadedAt)
                  : ''}
              </p>
              {doc.metadata?.fileSize && (
                <span className="text-xs text-claude-subtext/40 font-sans">
                  · {formatFileSize(doc.metadata.fileSize)}
                </span>
              )}
            </div>
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
          </motion.div>
        );
      })}
    </div>
  );
}
