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
    isUploading: stats.uploading > 0 || stats.queued > 0,
  };
}

export const useUploadStore = create<UploadState>((set) => {
  // Subscribe to upload manager events
  uploadManager.subscribe((_event: UploadEvent) => {
    set(syncFromManager(uploadManager));
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

    addFiles: (files) => {
      uploadManager.addFiles(files);
      set(syncFromManager(uploadManager));
    },

    startUpload: () => {
      uploadManager.start();
      set({ isPaused: false, ...syncFromManager(uploadManager) });
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
      set({ isPaused: true, ...syncFromManager(uploadManager) });
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
  };
});
