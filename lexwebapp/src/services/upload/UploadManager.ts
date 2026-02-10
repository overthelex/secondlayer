/**
 * Upload Manager - Orchestrates chunked file uploads with queue management
 *
 * Features:
 * - 3 parallel files, sequential chunks per file
 * - Exponential backoff retry (3 attempts per chunk)
 * - Pause/Resume/Cancel per-file and global
 * - Byte-level progress tracking
 */

import { uploadService, InitUploadResponse, UploadStatusResponse } from '../api/UploadService';

export type UploadItemStatus =
  | 'queued'
  | 'initializing'
  | 'uploading'
  | 'assembling'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused';

export interface UploadItem {
  id: string; // Client-side ID
  file: File;
  fileName: string;
  fileSize: number;
  mimeType: string;
  relativePath: string;
  docType: string;
  status: UploadItemStatus;
  uploadId?: string; // Server-side session ID
  documentId?: string;
  storageType?: string;
  progress: number; // 0-1
  uploadedBytes: number;
  error?: string;
  retries: number;
}

export type UploadEventType =
  | 'item-updated'
  | 'global-progress'
  | 'all-completed'
  | 'error';

export interface UploadEvent {
  type: UploadEventType;
  item?: UploadItem;
  globalProgress?: number;
  error?: string;
}

type UploadListener = (event: UploadEvent) => void;

const DEFAULT_CONCURRENT_FILES = 3;
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // ms
const POLL_INTERVAL = 2000; // ms

export class UploadManager {
  private items: Map<string, UploadItem> = new Map();
  private activeUploads = 0;
  private maxConcurrentFiles = DEFAULT_CONCURRENT_FILES;
  private isPaused = false;
  private listeners: Set<UploadListener> = new Set();
  private abortControllers: Map<string, AbortController> = new Map();

  subscribe(listener: UploadListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setConcurrency(n: number) {
    this.maxConcurrentFiles = Math.max(1, Math.min(100, n));
  }

  getConcurrency(): number {
    return this.maxConcurrentFiles;
  }

  private emit(event: UploadEvent) {
    this.listeners.forEach((l) => l(event));
  }

  private emitItemUpdate(item: UploadItem) {
    this.emit({ type: 'item-updated', item: { ...item } });
    this.emitGlobalProgress();
  }

  private emitGlobalProgress() {
    const items = Array.from(this.items.values());
    if (items.length === 0) return;
    const totalBytes = items.reduce((sum, i) => sum + i.fileSize, 0);
    const uploadedBytes = items.reduce((sum, i) => sum + i.uploadedBytes, 0);
    this.emit({
      type: 'global-progress',
      globalProgress: totalBytes > 0 ? uploadedBytes / totalBytes : 0,
    });
  }

  /**
   * Add files to the upload queue
   */
  addFiles(
    files: Array<{
      file: File;
      mimeType: string;
      relativePath: string;
      docType: string;
    }>
  ): UploadItem[] {
    const newItems: UploadItem[] = [];

    for (const f of files) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const item: UploadItem = {
        id,
        file: f.file,
        fileName: f.file.name,
        fileSize: f.file.size,
        mimeType: f.mimeType,
        relativePath: f.relativePath,
        docType: f.docType,
        status: 'queued',
        progress: 0,
        uploadedBytes: 0,
        retries: 0,
      };
      this.items.set(id, item);
      newItems.push(item);
    }

    return newItems;
  }

  /**
   * Start uploading all queued files
   */
  start() {
    this.isPaused = false;
    this.processQueue();
  }

  /**
   * Pause all uploads
   */
  pause() {
    this.isPaused = true;
    // Pause active uploads
    for (const [id, item] of this.items) {
      if (item.status === 'uploading' || item.status === 'initializing') {
        item.status = 'paused';
        this.emitItemUpdate(item);
        const controller = this.abortControllers.get(id);
        if (controller) controller.abort();
      }
    }
  }

  /**
   * Resume paused uploads
   */
  resume() {
    this.isPaused = false;
    // Reset paused items to queued
    for (const item of this.items.values()) {
      if (item.status === 'paused') {
        item.status = 'queued';
        this.emitItemUpdate(item);
      }
    }
    this.processQueue();
  }

  /**
   * Cancel a specific file
   */
  async cancelFile(itemId: string) {
    const item = this.items.get(itemId);
    if (!item) return;

    const controller = this.abortControllers.get(itemId);
    if (controller) controller.abort();

    if (item.uploadId) {
      try {
        await uploadService.cancelUpload(item.uploadId);
      } catch {
        // Best effort
      }
    }

    item.status = 'cancelled';
    this.emitItemUpdate(item);
  }

  /**
   * Cancel all uploads
   */
  async cancelAll() {
    this.isPaused = true;
    const promises: Promise<void>[] = [];

    for (const [id, item] of this.items) {
      if (['queued', 'initializing', 'uploading', 'paused'].includes(item.status)) {
        promises.push(this.cancelFile(id));
      }
    }

    await Promise.allSettled(promises);
  }

  /**
   * Retry a failed file
   */
  retryFile(itemId: string) {
    const item = this.items.get(itemId);
    if (!item || item.status !== 'failed') return;

    item.status = 'queued';
    item.retries = 0;
    item.error = undefined;
    item.uploadedBytes = 0;
    item.progress = 0;
    this.emitItemUpdate(item);
    this.processQueue();
  }

  /**
   * Retry all failed files
   */
  retryAllFailed() {
    for (const item of this.items.values()) {
      if (item.status === 'failed') {
        item.status = 'queued';
        item.retries = 0;
        item.error = undefined;
        item.uploadedBytes = 0;
        item.progress = 0;
        this.emitItemUpdate(item);
      }
    }
    this.processQueue();
  }

  /**
   * Remove a file from the queue (only if not actively uploading)
   */
  removeFile(itemId: string) {
    const item = this.items.get(itemId);
    if (!item) return;

    if (['queued', 'completed', 'failed', 'cancelled'].includes(item.status)) {
      this.items.delete(itemId);
      this.emitGlobalProgress();
    }
  }

  /**
   * Clear all completed/cancelled/failed items
   */
  clearFinished() {
    for (const [id, item] of this.items) {
      if (['completed', 'cancelled', 'failed'].includes(item.status)) {
        this.items.delete(id);
      }
    }
    this.emitGlobalProgress();
  }

  /**
   * Get all items as array
   */
  getItems(): UploadItem[] {
    return Array.from(this.items.values());
  }

  /**
   * Get stats
   */
  getStats() {
    const items = Array.from(this.items.values());
    return {
      total: items.length,
      queued: items.filter((i) => i.status === 'queued').length,
      uploading: items.filter((i) =>
        ['initializing', 'uploading', 'assembling', 'processing'].includes(i.status)
      ).length,
      completed: items.filter((i) => i.status === 'completed').length,
      failed: items.filter((i) => i.status === 'failed').length,
      cancelled: items.filter((i) => i.status === 'cancelled').length,
      paused: items.filter((i) => i.status === 'paused').length,
      totalBytes: items.reduce((s, i) => s + i.fileSize, 0),
      uploadedBytes: items.reduce((s, i) => s + i.uploadedBytes, 0),
    };
  }

  /**
   * Update doc type for a queued item
   */
  updateDocType(itemId: string, docType: string) {
    const item = this.items.get(itemId);
    if (item && item.status === 'queued') {
      item.docType = docType;
    }
  }

  /**
   * Update doc type for all queued items
   */
  updateAllDocTypes(docType: string) {
    for (const item of this.items.values()) {
      if (item.status === 'queued') {
        item.docType = docType;
      }
    }
  }

  // --- Internal ---

  private processQueue() {
    if (this.isPaused) return;

    const queued = Array.from(this.items.values()).filter(
      (i) => i.status === 'queued'
    );

    while (this.activeUploads < this.maxConcurrentFiles && queued.length > 0) {
      const item = queued.shift()!;
      this.activeUploads++;
      this.uploadFile(item).finally(() => {
        this.activeUploads--;
        this.processQueue();

        // Check if all done
        const stats = this.getStats();
        if (stats.queued === 0 && stats.uploading === 0 && stats.paused === 0) {
          this.emit({ type: 'all-completed' });
        }
      });
    }
  }

  private async uploadFile(item: UploadItem): Promise<void> {
    try {
      // Step 1: Init session
      item.status = 'initializing';
      this.emitItemUpdate(item);

      let initResponse: InitUploadResponse;

      if (item.uploadId) {
        // Resuming - check existing session
        const status = await uploadService.getStatus(item.uploadId);
        initResponse = {
          uploadId: item.uploadId,
          chunkSize: item.fileSize / (status.totalChunks || 1), // approximate
          totalChunks: status.totalChunks,
          uploadedChunks: status.uploadedChunks,
          expiresAt: '',
        };
      } else {
        initResponse = await uploadService.initUpload({
          fileName: item.fileName,
          fileSize: item.fileSize,
          mimeType: item.mimeType,
          docType: item.docType,
          relativePath: item.relativePath,
        });
        item.uploadId = initResponse.uploadId;
      }

      // Step 2: Upload chunks
      item.status = 'uploading';
      this.emitItemUpdate(item);

      const chunkSize = initResponse.chunkSize;
      const totalChunks = initResponse.totalChunks;
      const uploadedSet = new Set(initResponse.uploadedChunks);

      // Calculate already uploaded bytes from resumed chunks
      item.uploadedBytes = uploadedSet.size * chunkSize;

      for (let i = 0; i < totalChunks; i++) {
        if (this.isPaused || (item.status as string) === 'paused' || (item.status as string) === 'cancelled') {
          return;
        }

        // Skip already uploaded chunks (resume support)
        if (uploadedSet.has(i)) continue;

        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, item.fileSize);
        const chunk = item.file.slice(start, end);

        // Upload with retries
        let lastError: Error | null = null;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            await uploadService.uploadChunk(
              item.uploadId!,
              i,
              chunk,
              (loaded, _total) => {
                // Per-chunk progress
                const bytesBeforeThisChunk = i * chunkSize;
                const alreadyResumed = uploadedSet.size * chunkSize;
                item.uploadedBytes =
                  alreadyResumed +
                  (bytesBeforeThisChunk - alreadyResumed) +
                  loaded;
                item.progress = item.uploadedBytes / item.fileSize;
                this.emitItemUpdate(item);
              }
            );
            lastError = null;
            break;
          } catch (err: any) {
            lastError = err;
            if (attempt < MAX_RETRIES) {
              const delay = RETRY_DELAYS[attempt] || 4000;
              await new Promise((r) => setTimeout(r, delay));
            }
          }
        }

        if (lastError) {
          throw lastError;
        }

        // Update progress after successful chunk
        item.uploadedBytes = end;
        item.progress = item.uploadedBytes / item.fileSize;
        this.emitItemUpdate(item);
      }

      // Step 3: Complete
      item.status = 'assembling';
      this.emitItemUpdate(item);

      await uploadService.completeUpload(item.uploadId!);

      // Step 4: Poll for completion
      item.status = 'processing';
      this.emitItemUpdate(item);

      const result = await this.pollForCompletion(item.uploadId!);
      item.documentId = result.documentId;
      item.storageType = result.storageType;
      item.status = 'completed';
      item.progress = 1;
      item.uploadedBytes = item.fileSize;
      this.emitItemUpdate(item);
    } catch (error: any) {
      if (item.status === 'cancelled' || item.status === 'paused') return;

      item.status = 'failed';
      item.error = error.message || 'Upload failed';
      item.retries++;
      this.emitItemUpdate(item);
      this.emit({ type: 'error', error: `${item.fileName}: ${item.error}` });
    }
  }

  private async pollForCompletion(
    uploadId: string,
    maxAttempts = 120 // 4 min max
  ): Promise<UploadStatusResponse> {
    for (let i = 0; i < maxAttempts; i++) {
      const status = await uploadService.getStatus(uploadId);

      if (status.status === 'completed') {
        return status;
      }
      if (status.status === 'failed') {
        throw new Error(status.errorMessage || 'Processing failed');
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }

    throw new Error('Processing timeout');
  }
}

// Singleton instance
export const uploadManager = new UploadManager();
