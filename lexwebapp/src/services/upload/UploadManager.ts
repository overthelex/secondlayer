/**
 * Upload Manager - Orchestrates chunked file uploads with queue management
 *
 * Features:
 * - 3 parallel files, sequential chunks per file
 * - Exponential backoff retry (3 attempts per chunk)
 * - Pause/Resume/Cancel per-file and global
 * - Byte-level progress tracking
 * - Adaptive concurrency based on server backpressure
 * - 429 handling with Retry-After
 * - Batch init for 100+ files
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
  | 'error'
  | 'throttle-changed';

export interface UploadEvent {
  type: UploadEventType;
  item?: UploadItem;
  globalProgress?: number;
  error?: string;
  isThrottled?: boolean;
  serverQueueDepth?: number;
}

type UploadListener = (event: UploadEvent) => void;

const DEFAULT_CONCURRENT_FILES = 3;
const MAX_RETRIES = 3;
const MAX_429_RETRIES = 30; // Cap 429 retries to prevent infinite loops
const RETRY_DELAYS = [1000, 2000, 4000]; // ms
const POLL_INTERVAL = 2000; // ms
const BATCH_INIT_THRESHOLD = 10; // Use batch init for 10+ files

export class UploadManager {
  private items: Map<string, UploadItem> = new Map();
  private activeUploads = 0;
  private maxConcurrentFiles = DEFAULT_CONCURRENT_FILES;
  private userRequestedConcurrency = DEFAULT_CONCURRENT_FILES;
  private isPaused = false;
  private listeners: Set<UploadListener> = new Set();
  private abortControllers: Map<string, AbortController> = new Map();

  // Adaptive throttling state
  private _isThrottled = false;
  private _serverQueueDepth = 0;
  private interChunkDelay = 0; // ms, added when throttled

  subscribe(listener: UploadListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setConcurrency(n: number) {
    this.userRequestedConcurrency = Math.max(1, Math.min(100, n));
    this.maxConcurrentFiles = this.userRequestedConcurrency;
  }

  getConcurrency(): number {
    return this.maxConcurrentFiles;
  }

  get isThrottled(): boolean {
    return this._isThrottled;
  }

  get serverQueueDepth(): number {
    return this._serverQueueDepth;
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
   * Process backpressure headers from server response
   */
  private handleBackpressureHeaders(headers: Record<string, string> | null): void {
    if (!headers) return;

    const queueDepth = parseInt(headers['x-upload-queue-depth'] || '0', 10);
    const throttle = headers['x-upload-throttle'] === '1';

    this._serverQueueDepth = queueDepth;

    if (throttle && !this._isThrottled) {
      // Server is under load — reduce concurrency
      this._isThrottled = true;
      this.maxConcurrentFiles = Math.max(1, Math.floor(this.userRequestedConcurrency / 2));
      this.interChunkDelay = 500;
      this.emit({
        type: 'throttle-changed',
        isThrottled: true,
        serverQueueDepth: queueDepth,
      });
    } else if (!throttle && this._isThrottled && queueDepth < 100) {
      // Server recovered — gradually restore concurrency
      this._isThrottled = false;
      this.interChunkDelay = 0;
      this.maxConcurrentFiles = this.userRequestedConcurrency;
      this.emit({
        type: 'throttle-changed',
        isThrottled: false,
        serverQueueDepth: queueDepth,
      });
    }
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
  async start() {
    this.isPaused = false;
    // Batch-init sessions for large file sets (reduces 100 requests to 1)
    const queued = Array.from(this.items.values()).filter((i) => i.status === 'queued');
    if (queued.length >= BATCH_INIT_THRESHOLD) {
      await this.batchInitSessions(queued);
    }
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

  /**
   * Batch initialize sessions for queued items that don't have uploadIds yet
   */
  private async batchInitSessions(items: UploadItem[]): Promise<void> {
    const needInit = items.filter((i) => !i.uploadId);
    if (needInit.length < BATCH_INIT_THRESHOLD) return; // Not worth batching

    const files = needInit.map((i) => ({
      fileName: i.fileName,
      fileSize: i.fileSize,
      mimeType: i.mimeType,
      docType: i.docType,
      relativePath: i.relativePath,
    }));

    let throttleRetries = 0;
    let staleClearAttempted = false;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await uploadService.initBatch(files);
        if (response?.sessions) {
          for (let idx = 0; idx < response.sessions.length; idx++) {
            const session = response.sessions[idx];
            const item = needInit[idx];
            if (item && session && !('error' in session)) {
              item.uploadId = session.uploadId;
            }
          }
        }
        return; // Success
      } catch (err: any) {
        // 429 — wait for Retry-After, don't count as attempt (but cap retries)
        if (err.status === 429) {
          // Auto-clear stale sessions on SESSION_QUOTA_EXCEEDED (once per batch)
          if (err.details?.code === 'SESSION_QUOTA_EXCEEDED' && !staleClearAttempted) {
            staleClearAttempted = true;
            try {
              const clearResult = await uploadService.clearStaleSessions();
              if (clearResult.cancelled > 0) {
                this.emit({
                  type: 'error',
                  error: `Cleared ${clearResult.cancelled} stale session(s), retrying...`,
                });
                attempt--; // Retry immediately
                continue;
              }
            } catch {
              // Best effort — fall through to normal 429 handling
            }
          }

          throttleRetries++;
          if (throttleRetries > MAX_429_RETRIES) {
            this.emit({ type: 'error', error: 'Server busy too long, batch init failed' });
            break; // Fall through to individual init
          }
          const retryAfter = parseInt(err.details?.retryAfter || '60', 10);
          this.emit({
            type: 'error',
            error: `Server busy, batch init paused for ${retryAfter}s (${throttleRetries}/${MAX_429_RETRIES})`,
          });
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          attempt--; // Don't count 429 as an attempt
          continue;
        }

        // Other errors — backoff then fall through to individual init
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAYS[attempt] || 4000;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        // All retries exhausted — fall back to individual init per file
        this.emit({
          type: 'error',
          error: 'Batch init failed, falling back to individual init',
        });
      }
    }
  }

  private async uploadFile(item: UploadItem): Promise<void> {
    try {
      // Step 1: Init session
      item.status = 'initializing';
      this.emitItemUpdate(item);

      let initResponse: InitUploadResponse = undefined!;

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
        // Init with retry (same pattern as chunk upload 429 handling)
        let initError: Error | null = null;
        let initThrottleRetries = 0;
        let initStaleClearAttempted = false;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            initResponse = await uploadService.initUpload({
              fileName: item.fileName,
              fileSize: item.fileSize,
              mimeType: item.mimeType,
              docType: item.docType,
              relativePath: item.relativePath,
            });
            item.uploadId = initResponse.uploadId;
            initError = null;
            break;
          } catch (err: any) {
            // 429 — wait for Retry-After, don't count as attempt (but cap retries)
            if (err.status === 429) {
              // Auto-clear stale sessions on SESSION_QUOTA_EXCEEDED (once per file)
              if (err.details?.code === 'SESSION_QUOTA_EXCEEDED' && !initStaleClearAttempted) {
                initStaleClearAttempted = true;
                try {
                  const clearResult = await uploadService.clearStaleSessions();
                  if (clearResult.cancelled > 0) {
                    this.emit({
                      type: 'error',
                      error: `Cleared ${clearResult.cancelled} stale session(s), retrying...`,
                    });
                    attempt--; // Retry immediately
                    continue;
                  }
                } catch {
                  // Best effort — fall through to normal 429 handling
                }
              }

              initThrottleRetries++;
              if (initThrottleRetries > MAX_429_RETRIES) {
                initError = new Error('Server busy too long, upload init failed');
                break;
              }
              const retryAfter = parseInt(err.details?.retryAfter || '60', 10);
              this.emit({
                type: 'error',
                error: `Server busy, init paused for ${retryAfter}s (${initThrottleRetries}/${MAX_429_RETRIES})`,
              });
              await new Promise((r) => setTimeout(r, retryAfter * 1000));
              attempt--;
              continue;
            }
            initError = err;
            if (attempt < MAX_RETRIES) {
              const delay = RETRY_DELAYS[attempt] || 4000;
              await new Promise((r) => setTimeout(r, delay));
            }
          }
        }
        if (initError) throw initError;
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

        // Inter-chunk delay when server is throttled
        if (this.interChunkDelay > 0) {
          await new Promise((r) => setTimeout(r, this.interChunkDelay));
        }

        // Upload with retries
        let lastError: Error | null = null;
        let chunkThrottleRetries = 0;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            const response = await uploadService.uploadChunk(
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

            // Process backpressure headers from chunk response
            if (response && typeof response === 'object' && '_headers' in response) {
              this.handleBackpressureHeaders((response as any)._headers);
            }

            lastError = null;
            break;
          } catch (err: any) {
            // Handle 429 — wait for Retry-After, don't count as retry attempt (but cap retries)
            if (err.status === 429 || err.message?.includes('429')) {
              chunkThrottleRetries++;
              if (chunkThrottleRetries > MAX_429_RETRIES) {
                lastError = new Error('Server busy too long, chunk upload failed');
                break;
              }
              const retryAfter = parseInt(err.retryAfter || '5', 10);
              this.emit({
                type: 'error',
                error: `Server busy, uploads paused for ${retryAfter}s (${chunkThrottleRetries}/${MAX_429_RETRIES})`,
              });
              await new Promise((r) => setTimeout(r, retryAfter * 1000));
              // Don't increment attempt counter for 429
              attempt--;
              continue;
            }

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
