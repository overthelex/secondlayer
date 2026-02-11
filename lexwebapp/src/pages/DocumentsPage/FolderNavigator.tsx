import React from 'react';
import { Folder, ChevronRight, Home } from 'lucide-react';

interface FolderNavigatorProps {
  currentPath: string;
  folders: string[];
  onNavigate: (folderName: string) => void;
  onReset: () => void;
  onBreadcrumbClick: (depth: number) => void;
  loading: boolean;
}

export function FolderNavigator({
  currentPath,
  folders,
  onNavigate,
  onReset,
  onBreadcrumbClick,
  loading,
}: FolderNavigatorProps) {
  const segments = currentPath ? currentPath.split('/').filter(Boolean) : [];

  return (
    <div className="mb-4">
      {/* Breadcrumbs */}
      {(currentPath || folders.length > 0) && (
        <div className="flex items-center gap-1 mb-3 text-sm font-sans flex-wrap">
          <button
            onClick={onReset}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg transition-colors ${
              !currentPath
                ? 'text-claude-text font-semibold'
                : 'text-claude-subtext/70 hover:text-claude-text hover:bg-claude-bg'
            }`}
          >
            <Home size={14} />
            <span>Всі документи</span>
          </button>

          {segments.map((seg, idx) => (
            <React.Fragment key={idx}>
              <ChevronRight size={14} className="text-claude-subtext/30 flex-shrink-0" />
              <button
                onClick={() => onBreadcrumbClick(idx + 1)}
                className={`px-2 py-1 rounded-lg transition-colors ${
                  idx === segments.length - 1
                    ? 'text-claude-text font-semibold'
                    : 'text-claude-subtext/70 hover:text-claude-text hover:bg-claude-bg'
                }`}
              >
                {seg}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}

      {/* Subfolder grid */}
      {folders.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
          {folders.map((folder) => (
            <button
              key={folder}
              onClick={() => onNavigate(folder)}
              disabled={loading}
              className="flex items-center gap-2 px-3 py-2.5 bg-white border border-claude-border rounded-xl text-sm text-claude-text hover:bg-claude-bg hover:border-claude-subtext/30 transition-all active:scale-[0.98] font-sans disabled:opacity-50"
            >
              <Folder size={16} className="text-claude-subtext/50 flex-shrink-0" />
              <span className="truncate">{folder}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
