/**
 * Upload Store - Zustand state for file uploads
 */

import { create } from 'zustand';
import {
  uploadManager,
  UploadManager,
  UploadItem,
  UploadEvent,
} from '../services/upload/UploadManager';
import { uploadService, ActiveSession } from '../services/api/UploadService';

export interface RecoveredSession {
  uploadId: string;
  fileName: string;
  status: 'recovering' | 'completed' | 'failed';
  documentId?: string;
  error?: string;
}

interface UploadState {
  items: UploadItem[];
  isUploading: boolean;
  isPaused: boolean;
  globalProgress: number;
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  totalBytes: number;
  uploadedBytes: number;
  concurrency: number;

  // Recovery state
  recoveredSessions: RecoveredSession[];
  isRecovering: boolean;

  // Actions
  addFiles: (
    files: Array<{
      file: File;
      mimeType: string;
      relativePath: string;
      docType: string;
    }>
  ) => void;
  startUpload: () => void;
  pauseUpload: () => void;
  resumeUpload: () => void;
  cancelFile: (itemId: string) => void;
  cancelAll: () => void;
  retryFile: (itemId: string) => void;
  retryAllFailed: () => void;
  removeFile: (itemId: string) => void;
  clearFinished: () => void;
  updateDocType: (itemId: string, docType: string) => void;
  updateAllDocTypes: (docType: string) => void;
  setConcurrency: (n: number) => void;
  recoverSessions: () => Promise<void>;
  dismissRecoveredSession: (uploadId: string) => void;
  clearRecoveredSessions: () => void;
}

function syncFromManager(manager: UploadManager) {
  const items = manager.getItems();
  const stats = manager.getStats();
  return {
    items: [...items],
    totalFiles: stats.total,
    completedFiles: stats.completed,
    failedFiles: stats.failed,
    totalBytes: stats.totalBytes,
    uploadedBytes: stats.uploadedBytes,
  };
}

export const useUploadStore = create<UploadState>((set) => {
  // Subscribe to upload manager events
  uploadManager.subscribe((event: UploadEvent) => {
    const sync = syncFromManager(uploadManager);
    if (event.type === 'all-completed') {
      set({ ...sync, isUploading: false });
    } else {
      set(sync);
    }
  });

  return {
    items: [],
    isUploading: false,
    isPaused: false,
    globalProgress: 0,
    totalFiles: 0,
    completedFiles: 0,
    failedFiles: 0,
    totalBytes: 0,
    uploadedBytes: 0,
    concurrency: uploadManager.getConcurrency(),
    recoveredSessions: [],
    isRecovering: false,

    addFiles: (files) => {
      uploadManager.addFiles(files);
      set(syncFromManager(uploadManager));
    },

    startUpload: () => {
      uploadManager.start();
      set({ isUploading: true, isPaused: false, ...syncFromManager(uploadManager) });
    },

    pauseUpload: () => {
      uploadManager.pause();
      set({ isPaused: true, ...syncFromManager(uploadManager) });
    },

    resumeUpload: () => {
      uploadManager.resume();
      set({ isPaused: false, ...syncFromManager(uploadManager) });
    },

    cancelFile: async (itemId) => {
      await uploadManager.cancelFile(itemId);
      set(syncFromManager(uploadManager));
    },

    cancelAll: async () => {
      await uploadManager.cancelAll();
      set({ isUploading: false, isPaused: false, ...syncFromManager(uploadManager) });
    },

    retryFile: (itemId) => {
      uploadManager.retryFile(itemId);
      set(syncFromManager(uploadManager));
    },

    retryAllFailed: () => {
      uploadManager.retryAllFailed();
      set(syncFromManager(uploadManager));
    },

    removeFile: (itemId) => {
      uploadManager.removeFile(itemId);
      set(syncFromManager(uploadManager));
    },

    clearFinished: () => {
      uploadManager.clearFinished();
      set(syncFromManager(uploadManager));
    },

    updateDocType: (itemId, docType) => {
      uploadManager.updateDocType(itemId, docType);
      set({ items: [...uploadManager.getItems()] });
    },

    updateAllDocTypes: (docType) => {
      uploadManager.updateAllDocTypes(docType);
      set({ items: [...uploadManager.getItems()] });
    },

    setConcurrency: (n) => {
      uploadManager.setConcurrency(n);
      set({ concurrency: uploadManager.getConcurrency() });
    },

    recoverSessions: async () => {
      try {
        set({ isRecovering: true });
        const sessions = await uploadService.getActiveSessions();
        const stuck = sessions.filter(
          (s: ActiveSession) => s.status === 'assembling' || s.status === 'processing'
        );

        if (stuck.length === 0) {
          set({ isRecovering: false });
          return;
        }

        const recovered: RecoveredSession[] = stuck.map((s: ActiveSession) => ({
          uploadId: s.uploadId,
          fileName: s.fileName,
          status: 'recovering' as const,
        }));
        set({ recoveredSessions: recovered });

        // Poll each session until it resolves
        for (const s of stuck) {
          pollRecovery(s.uploadId, set);
        }
      } catch (err) {
        console.error('[UploadStore] Recovery check failed:', err);
        set({ isRecovering: false });
      }
    },

    dismissRecoveredSession: (uploadId) => {
      set((state) => ({
        recoveredSessions: state.recoveredSessions.filter((s) => s.uploadId !== uploadId),
      }));
    },

    clearRecoveredSessions: () => {
      set({ recoveredSessions: [], isRecovering: false });
    },
  };
});

async function pollRecovery(
  uploadId: string,
  set: (fn: (state: UploadState) => Partial<UploadState>) => void
) {
  const maxPolls = 60; // 5 minutes at 5s intervals
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const status = await uploadService.getStatus(uploadId);
      if (status.status === 'completed') {
        set((state) => ({
          recoveredSessions: state.recoveredSessions.map((s) =>
            s.uploadId === uploadId
              ? { ...s, status: 'completed' as const, documentId: status.documentId }
              : s
          ),
          isRecovering: state.recoveredSessions.some(
            (s) => s.uploadId !== uploadId && s.status === 'recovering'
          ),
        }));
        return;
      }
      if (status.status === 'failed') {
        set((state) => ({
          recoveredSessions: state.recoveredSessions.map((s) =>
            s.uploadId === uploadId
              ? { ...s, status: 'failed' as const, error: status.errorMessage }
              : s
          ),
          isRecovering: state.recoveredSessions.some(
            (s) => s.uploadId !== uploadId && s.status === 'recovering'
          ),
        }));
        return;
      }
      // Still processing — continue polling
    } catch {
      // Network error — continue polling
    }
  }
  // Timed out
  set((state) => ({
    recoveredSessions: state.recoveredSessions.map((s) =>
      s.uploadId === uploadId
        ? { ...s, status: 'failed' as const, error: 'Recovery poll timed out' }
        : s
    ),
    isRecovering: state.recoveredSessions.some(
      (s) => s.uploadId !== uploadId && s.status === 'recovering'
    ),
  }));
}
