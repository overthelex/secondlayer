/**
 * Upload Service - HTTP client for chunked file uploads
 */

import { BaseService } from '../base/BaseService';

export interface InitUploadResponse {
  uploadId: string;
  chunkSize: number;
  totalChunks: number;
  uploadedChunks: number[];
  expiresAt: string;
}

export interface ChunkUploadResponse {
  chunkIndex: number;
  uploadedChunks: number[];
  totalChunks: number;
  progress: number;
}

export interface UploadStatusResponse {
  uploadId: string;
  status: string;
  documentId?: string;
  storageType?: string;
  progress: number;
  uploadedChunks: number[];
  totalChunks: number;
  errorMessage?: string;
}

export interface ActiveSession {
  uploadId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  status: string;
  progress: number;
  uploadedChunks: number[];
  totalChunks: number;
  createdAt: string;
  expiresAt: string;
}

export class UploadService extends BaseService {
  /**
   * Initialize an upload session
   */
  async initUpload(params: {
    fileName: string;
    fileSize: number;
    mimeType: string;
    docType?: string;
    relativePath?: string;
    metadata?: any;
  }): Promise<InitUploadResponse> {
    try {
      const response = await this.client.post('/upload/init', params);
      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Batch initialize multiple upload sessions (for 10+ files)
   */
  async initBatch(files: Array<{
    fileName: string;
    fileSize: number;
    mimeType: string;
    docType?: string;
    relativePath?: string;
    metadata?: any;
  }>): Promise<{ sessions: Array<InitUploadResponse | { error: string; fileName: string }> }> {
    try {
      const response = await this.client.post('/upload/init-batch', { files });
      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Upload a single chunk using XMLHttpRequest for progress tracking
   */
  uploadChunk(
    uploadId: string,
    chunkIndex: number,
    chunk: Blob,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<ChunkUploadResponse> {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append('chunkIndex', String(chunkIndex));
      formData.append('chunk', chunk);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${this.client.defaults.baseURL}/upload/${uploadId}/chunk`);

      // Add auth header
      const token = localStorage.getItem('auth_token');
      if (token) {
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      }

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) {
          onProgress(event.loaded, event.total);
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const result = JSON.parse(xhr.responseText);
          // Attach response headers for backpressure detection
          result._headers = {
            'x-upload-queue-depth': xhr.getResponseHeader('X-Upload-Queue-Depth') || '0',
            'x-upload-throttle': xhr.getResponseHeader('X-Upload-Throttle') || '0',
            'retry-after': xhr.getResponseHeader('Retry-After') || '',
          };
          resolve(result);
        } else if (xhr.status === 429) {
          const retryAfter = xhr.getResponseHeader('Retry-After') || '5';
          const err: any = new Error(`HTTP 429 - Rate limited`);
          err.status = 429;
          err.retryAfter = retryAfter;
          reject(err);
        } else {
          try {
            const err = JSON.parse(xhr.responseText);
            reject(new Error(err.error || `HTTP ${xhr.status}`));
          } catch {
            reject(new Error(`HTTP ${xhr.status}`));
          }
        }
      };

      xhr.onerror = () => reject(new Error('Network error'));
      xhr.ontimeout = () => reject(new Error('Upload timeout'));
      xhr.timeout = 60000; // 60s per chunk

      xhr.send(formData);
    });
  }

  /**
   * Signal that all chunks are uploaded and file should be assembled
   */
  async completeUpload(uploadId: string): Promise<{ uploadId: string; status: string }> {
    try {
      const response = await this.client.post(`/upload/${uploadId}/complete`);
      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Poll upload status
   */
  async getStatus(uploadId: string): Promise<UploadStatusResponse> {
    try {
      const response = await this.client.get(`/upload/${uploadId}/status`);
      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Cancel an upload
   */
  async cancelUpload(uploadId: string): Promise<void> {
    try {
      await this.client.delete(`/upload/${uploadId}`);
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Get active upload sessions
   */
  async getActiveSessions(): Promise<ActiveSession[]> {
    try {
      const response = await this.client.get('/upload/active');
      return response.data.sessions;
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Retry a stuck/failed upload session
   */
  async retrySession(uploadId: string): Promise<{ uploadId: string; status: string }> {
    try {
      const response = await this.client.post(`/upload/${uploadId}/retry`);
      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }
}

export const uploadService = new UploadService();
