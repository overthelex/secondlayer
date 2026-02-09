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

    // Assemble chunks in order
    const writeStream = fsSync.createWriteStream(assembledPath);

    try {
      for (let i = 0; i < session.totalChunks; i++) {
        const chunkPath = path.join(sessionDir, `chunk_${i}`);
        const chunkData = await fs.readFile(chunkPath);
        writeStream.write(chunkData);
      }

      await new Promise<void>((resolve, reject) => {
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
    await this.pool.query(
      `UPDATE upload_sessions
       SET status = $2, error_message = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [sessionId, status, errorMessage || null]
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
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
