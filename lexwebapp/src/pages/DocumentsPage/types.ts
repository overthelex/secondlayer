export interface VaultDocument {
  id: string;
  title: string;
  type: 'contract' | 'legislation' | 'court_decision' | 'internal' | 'other';
  metadata: {
    uploadedAt: string;
    uploadedBy?: string;
    tags?: string[];
    category?: string;
    riskLevel?: 'low' | 'medium' | 'high';
    fileSize?: number;
    mimeType?: string;
    folderPath?: string;
    documentDate?: string;
    parties?: string[];
    documentSubtype?: string;
    jurisdiction?: string;
  };
}

export type DocType = 'contract' | 'legislation' | 'court_decision' | 'internal' | 'other';
export type ViewMode = 'grid' | 'list';
export type SortField = 'uploadedAt' | 'title' | 'type';
export type SortOrder = 'asc' | 'desc';
