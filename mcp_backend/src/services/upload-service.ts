import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { logger } from '../utils/logger.js';

export interface UploadSession {
  id: string;
  userId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
  chunkSize: number;
  uploadedChunks: number[];
  status: string;
  docType: string;
  relativePath?: string;
  metadata?: any;
  matterId?: string;
  documentId?: string;
  errorMessage?: string;
  retryCount: number;
  processingStartedAt?: string;
  lastRetryAt?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB
const SESSION_TTL_HOURS = 24;

const DOCUMENT_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/html',
  'text/plain',
  'application/rtf',
];

export class UploadService {
  private tempDir: string;

  constructor(private pool: Pool) {
    this.tempDir = process.env.UPLOAD_TEMP_DIR || '/tmp/uploads';
  }

  /**
   * Check if a mime type is a document type (processable by VaultTools)
   */
  static isDocumentType(mimeType: string): boolean {
    return DOCUMENT_TYPES.includes(mimeType);
  }

  get defaultChunkSize(): number {
    return CHUNK_SIZE;
  }

  async createSession(
    userId: string,
    fileName: string,
    fileSize: number,
    mimeType: string,
    opts: { docType?: string; relativePath?: string; metadata?: any; matterId?: string } = {}
  ): Promise<UploadSession> {
    if (fileSize > MAX_FILE_SIZE) {
      throw new Error(`File size ${fileSize} exceeds maximum ${MAX_FILE_SIZE}`);
    }

    const id = uuidv4();
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

    const result = await this.pool.query(
      `INSERT INTO upload_sessions
        (id, user_id, file_name, file_size, mime_type, total_chunks, chunk_size,
         doc_type, relative_path, metadata, matter_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')
       RETURNING *`,
      [
        id,
        userId,
        fileName,
        fileSize,
        mimeType,
        totalChunks,
        CHUNK_SIZE,
        opts.docType || 'other',
        opts.relativePath || null,
        JSON.stringify(opts.metadata || {}),
        opts.matterId || null,
      ]
    );

    // Create temp directory for chunks
    const sessionDir = path.join(this.tempDir, id);
    await fs.mkdir(sessionDir, { recursive: true });

    logger.info('[Upload] Session created', {
      sessionId: id,
      userId,
      fileName,
      fileSize,
      totalChunks,
    });

    return this.rowToSession(result.rows[0]);
  }

  async saveChunk(
    sessionId: string,
    chunkIndex: number,
    buffer: Buffer
  ): Promise<{ chunkIndex: number; uploadedChunks: number[]; totalChunks: number; progress: number }> {
    // Verify session exists and is active
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (session.status !== 'pending' && session.status !== 'uploading') {
      throw new Error(`Session ${sessionId} is in status ${session.status}, cannot accept chunks`);
    }
    if (chunkIndex < 0 || chunkIndex >= session.totalChunks) {
      throw new Error(`Invalid chunk index ${chunkIndex}, expected 0-${session.totalChunks - 1}`);
    }

    // Save chunk to disk
    const chunkPath = path.join(this.tempDir, sessionId, `chunk_${chunkIndex}`);
    await fs.writeFile(chunkPath, buffer);

    // Update session in DB
    const result = await this.pool.query(
      `UPDATE upload_sessions
       SET uploaded_chunks = array_append(
         CASE WHEN $2 = ANY(uploaded_chunks) THEN array_remove(uploaded_chunks, $2) ELSE uploaded_chunks END,
         $2
       ),
       status = 'uploading',
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING uploaded_chunks, total_chunks`,
      [sessionId, chunkIndex]
    );

    const row = result.rows[0];
    const uploadedChunks: number[] = row.uploaded_chunks || [];
    const totalChunks: number = row.total_chunks;
    const progress = uploadedChunks.length / totalChunks;

    logger.debug('[Upload] Chunk saved', {
      sessionId,
      chunkIndex,
      uploadedCount: uploadedChunks.length,
      totalChunks,
      progress: progress.toFixed(3),
    });

    return { chunkIndex, uploadedChunks, totalChunks, progress };
  }

  async assembleFile(sessionId: string): Promise<string> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Verify all chunks are present
    if (session.uploadedChunks.length !== session.totalChunks) {
      throw new Error(
        `Missing chunks: uploaded ${session.uploadedChunks.length}/${session.totalChunks}`
      );
    }

    // Update status
    await this.pool.query(
      `UPDATE upload_sessions SET status = 'assembling', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [sessionId]
    );

    const sessionDir = path.join(this.tempDir, sessionId);
    const assembledPath = path.join(sessionDir, session.fileName);

    // Ensure session directory exists (may be lost after container restart)
    await fs.mkdir(sessionDir, { recursive: true });

    // Verify all chunk files exist before starting assembly
    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = path.join(sessionDir, `chunk_${i}`);
      try {
        await fs.access(chunkPath);
      } catch {
        throw new Error(
          `Chunk ${i} missing at ${chunkPath}. Upload session data may have been lost after a restart.`
        );
      }
    }

    // Assemble chunks in order — attach error handler immediately
    const writeStream = fsSync.createWriteStream(assembledPath);
    let streamError: Error | null = null;
    writeStream.on('error', (err) => { streamError = err; });

    try {
      for (let i = 0; i < session.totalChunks; i++) {
        if (streamError) throw streamError;
        const chunkPath = path.join(sessionDir, `chunk_${i}`);
        const chunkData = await fs.readFile(chunkPath);
        writeStream.write(chunkData);
      }

      await new Promise<void>((resolve, reject) => {
        if (streamError) return reject(streamError);
        writeStream.end(() => resolve());
        writeStream.on('error', reject);
      });

      logger.info('[Upload] File assembled', {
        sessionId,
        path: assembledPath,
        chunks: session.totalChunks,
      });

      // Clean up chunk files
      for (let i = 0; i < session.totalChunks; i++) {
        const chunkPath = path.join(sessionDir, `chunk_${i}`);
        await fs.unlink(chunkPath).catch(() => {});
      }

      return assembledPath;
    } catch (error: any) {
      writeStream.destroy();
      await this.updateStatus(sessionId, 'failed', error.message);
      throw error;
    }
  }

  async getSession(sessionId: string): Promise<UploadSession | null> {
    const result = await this.pool.query(
      `SELECT * FROM upload_sessions WHERE id = $1`,
      [sessionId]
    );
    if (result.rows.length === 0) return null;
    return this.rowToSession(result.rows[0]);
  }

  async getActiveSessionCount(userId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as cnt FROM upload_sessions
       WHERE user_id = $1 AND status NOT IN ('completed', 'cancelled', 'expired', 'failed')`,
      [userId]
    );
    return parseInt(result.rows[0].cnt, 10);
  }

  async getActiveSessions(userId: string): Promise<UploadSession[]> {
    const result = await this.pool.query(
      `SELECT * FROM upload_sessions
       WHERE user_id = $1 AND status NOT IN ('completed', 'cancelled', 'expired')
       ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows.map((row: any) => this.rowToSession(row));
  }

  async updateStatus(sessionId: string, status: string, errorMessage?: string): Promise<void> {
    const setProcessingStarted = (status === 'assembling' || status === 'processing');
    await this.pool.query(
      `UPDATE upload_sessions
       SET status = $2,
           error_message = $3,
           processing_started_at = CASE WHEN $4::boolean THEN CURRENT_TIMESTAMP ELSE processing_started_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [sessionId, status, errorMessage || null, setProcessingStarted]
    );
  }

  async setDocumentId(sessionId: string, documentId: string): Promise<void> {
    await this.pool.query(
      `UPDATE upload_sessions
       SET document_id = $1, status = 'completed', updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [documentId, sessionId]
    );
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE upload_sessions SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [sessionId]
    );

    // Cleanup temp files
    const sessionDir = path.join(this.tempDir, sessionId);
    await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});

    logger.info('[Upload] Session cancelled', { sessionId });
  }

  async cleanupExpired(): Promise<number> {
    // Get expired sessions
    const result = await this.pool.query(
      `UPDATE upload_sessions
       SET status = 'expired', updated_at = CURRENT_TIMESTAMP
       WHERE status NOT IN ('completed', 'cancelled', 'expired')
         AND expires_at < CURRENT_TIMESTAMP
       RETURNING id`
    );

    // Cleanup temp dirs
    for (const row of result.rows) {
      const sessionDir = path.join(this.tempDir, row.id);
      await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    }

    if (result.rows.length > 0) {
      logger.info('[Upload] Expired sessions cleaned', { count: result.rows.length });
    }

    return result.rows.length;
  }

  async cleanupAssembledFile(sessionId: string): Promise<void> {
    const sessionDir = path.join(this.tempDir, sessionId);
    await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Find sessions stuck in assembling/processing for longer than thresholdMinutes
   * Uses FOR UPDATE SKIP LOCKED to prevent concurrent recovery
   */
  async getStuckSessions(thresholdMinutes: number = 10): Promise<UploadSession[]> {
    const result = await this.pool.query(
      `SELECT * FROM upload_sessions
       WHERE status IN ('assembling', 'processing')
         AND updated_at < CURRENT_TIMESTAMP - ($1 || ' minutes')::interval
         AND retry_count < 3
       ORDER BY updated_at ASC
       FOR UPDATE SKIP LOCKED`,
      [thresholdMinutes]
    );
    return result.rows.map((row: any) => this.rowToSession(row));
  }

  /**
   * Find ALL sessions in assembling/processing (for startup recovery, no time threshold)
   */
  async getRecoverableOnStartup(): Promise<UploadSession[]> {
    const result = await this.pool.query(
      `SELECT * FROM upload_sessions
       WHERE status IN ('assembling', 'processing')
         AND retry_count < 3
       ORDER BY updated_at ASC
       FOR UPDATE SKIP LOCKED`
    );
    return result.rows.map((row: any) => this.rowToSession(row));
  }

  /**
   * Increment retry count and set last_retry_at
   */
  async incrementRetryCount(sessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE upload_sessions
       SET retry_count = retry_count + 1,
           last_retry_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [sessionId]
    );
  }

  /**
   * Check what files exist on disk for a session
   */
  async checkFilesOnDisk(sessionId: string): Promise<{
    hasChunks: boolean;
    hasAssembled: boolean;
    chunkCount: number;
    assembledFileName: string | null;
  }> {
    const sessionDir = path.join(this.tempDir, sessionId);
    let hasChunks = false;
    let hasAssembled = false;
    let chunkCount = 0;
    let assembledFileName: string | null = null;

    try {
      const files = await fs.readdir(sessionDir);
      for (const file of files) {
        if (file.startsWith('chunk_')) {
          hasChunks = true;
          chunkCount++;
        } else {
          hasAssembled = true;
          assembledFileName = file;
        }
      }
    } catch {
      // Directory doesn't exist
    }

    return { hasChunks, hasAssembled, chunkCount, assembledFileName };
  }

  /**
   * Check if a document already exists for this upload session
   */
  async findDocumentBySessionId(sessionId: string): Promise<string | null> {
    const result = await this.pool.query(
      `SELECT id FROM documents WHERE metadata->>'uploadSessionId' = $1 LIMIT 1`,
      [sessionId]
    );
    return result.rows.length > 0 ? result.rows[0].id : null;
  }

  get tempDirectory(): string {
    return this.tempDir;
  }

  private rowToSession(row: any): UploadSession {
    return {
      id: row.id,
      userId: row.user_id,
      fileName: row.file_name,
      fileSize: parseInt(row.file_size, 10),
      mimeType: row.mime_type,
      totalChunks: row.total_chunks,
      chunkSize: row.chunk_size,
      uploadedChunks: row.uploaded_chunks || [],
      status: row.status,
      docType: row.doc_type,
      relativePath: row.relative_path,
      metadata: row.metadata,
      matterId: row.matter_id,
      documentId: row.document_id,
      errorMessage: row.error_message,
      retryCount: row.retry_count || 0,
      processingStartedAt: row.processing_started_at,
      lastRetryAt: row.last_retry_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
