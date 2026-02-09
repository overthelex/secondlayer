import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import { UploadService } from '../services/upload-service.js';
import { MinioService } from '../services/minio-service.js';
import { VaultTools } from '../api/vault-tools.js';
import { AuthenticatedRequest as DualAuthRequest } from '../middleware/dual-auth.js';
import { Pool } from 'pg';

// Multer configured for disk storage of chunks
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 6 * 1024 * 1024, // 6MB per chunk (slightly over 5MB chunk size for overhead)
  },
});

export function createUploadRouter(
  uploadService: UploadService,
  minioService: MinioService,
  vaultTools: VaultTools,
  pool: Pool
): Router {
  const router = Router();

  /**
   * POST /init - Create a new upload session
   */
  router.post('/init', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const { fileName, fileSize, mimeType, docType, relativePath, metadata } = req.body;

      if (!fileName || !fileSize || !mimeType) {
        return res.status(400).json({
          error: 'Missing required fields: fileName, fileSize, mimeType',
        });
      }

      const session = await uploadService.createSession(userId, fileName, fileSize, mimeType, {
        docType,
        relativePath,
        metadata,
      });

      res.status(201).json({
        uploadId: session.id,
        chunkSize: session.chunkSize,
        totalChunks: session.totalChunks,
        uploadedChunks: session.uploadedChunks,
        expiresAt: session.expiresAt,
      });
    } catch (error: any) {
      logger.error('[Upload] Init failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  /**
   * POST /:uploadId/chunk - Upload a chunk
   */
  router.post('/:uploadId/chunk', upload.single('chunk'), (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const { uploadId } = req.params;
      const chunkIndex = parseInt(req.body.chunkIndex, 10);

      if (isNaN(chunkIndex)) {
        return res.status(400).json({ error: 'Missing or invalid chunkIndex' });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'Missing chunk data' });
      }

      // Verify session belongs to user
      const session = await uploadService.getSession(uploadId as string);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (session.userId !== userId) {
        return res.status(403).json({ error: 'Not authorized for this session' });
      }

      const result = await uploadService.saveChunk(
        uploadId as string,
        chunkIndex,
        req.file.buffer
      );

      res.json(result);
    } catch (error: any) {
      logger.error('[Upload] Chunk upload failed', {
        uploadId: req.params.uploadId,
        error: error.message,
      });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  /**
   * POST /:uploadId/complete - Assemble and process the file
   */
  router.post('/:uploadId/complete', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const { uploadId } = req.params;
      const session = await uploadService.getSession(uploadId as string);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (session.userId !== userId) {
        return res.status(403).json({ error: 'Not authorized for this session' });
      }
      if (session.uploadedChunks.length !== session.totalChunks) {
        return res.status(400).json({
          error: `Missing chunks: ${session.uploadedChunks.length}/${session.totalChunks}`,
        });
      }

      // Respond immediately - processing happens async
      res.status(202).json({
        uploadId: session.id,
        status: 'processing',
      });

      // Process in background
      processUpload(session, uploadService, minioService, vaultTools, pool).catch((error) => {
        logger.error('[Upload] Background processing failed', {
          uploadId: session.id,
          error: error.message,
        });
      });
    } catch (error: any) {
      logger.error('[Upload] Complete failed', {
        uploadId: req.params.uploadId,
        error: error.message,
      });
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  }) as any);

  /**
   * GET /:uploadId/status - Get session status
   */
  router.get('/:uploadId/status', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const { uploadId } = req.params;
      const session = await uploadService.getSession(uploadId as string);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (session.userId !== userId) {
        return res.status(403).json({ error: 'Not authorized for this session' });
      }

      res.json({
        uploadId: session.id,
        status: session.status,
        documentId: session.documentId,
        storageType: UploadService.isDocumentType(session.mimeType) ? 'vault' : 'minio',
        progress: session.uploadedChunks.length / session.totalChunks,
        uploadedChunks: session.uploadedChunks,
        totalChunks: session.totalChunks,
        errorMessage: session.errorMessage,
      });
    } catch (error: any) {
      logger.error('[Upload] Status check failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  /**
   * DELETE /:uploadId - Cancel and cleanup
   */
  router.delete('/:uploadId', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const { uploadId } = req.params;
      const session = await uploadService.getSession(uploadId as string);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (session.userId !== userId) {
        return res.status(403).json({ error: 'Not authorized for this session' });
      }

      await uploadService.cancelSession(uploadId as string);
      res.json({ success: true });
    } catch (error: any) {
      logger.error('[Upload] Cancel failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  /**
   * GET /active - List user's active sessions
   */
  router.get('/active', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const sessions = await uploadService.getActiveSessions(userId);
      res.json({
        sessions: sessions.map((s) => ({
          uploadId: s.id,
          fileName: s.fileName,
          fileSize: s.fileSize,
          mimeType: s.mimeType,
          status: s.status,
          progress: s.uploadedChunks.length / s.totalChunks,
          uploadedChunks: s.uploadedChunks,
          totalChunks: s.totalChunks,
          createdAt: s.createdAt,
          expiresAt: s.expiresAt,
        })),
      });
    } catch (error: any) {
      logger.error('[Upload] List active failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  return router;
}

/**
 * Background processing after all chunks uploaded
 */
async function processUpload(
  session: import('../services/upload-service.js').UploadSession,
  uploadService: UploadService,
  minioService: MinioService,
  vaultTools: VaultTools,
  pool: Pool
): Promise<void> {
  try {
    await uploadService.updateStatus(session.id, 'processing');

    // Assemble file
    const assembledPath = await uploadService.assembleFile(session.id);

    let documentId: string;
    let storageType: string;
    let storagePath: string | null = null;

    if (UploadService.isDocumentType(session.mimeType)) {
      // Route to VaultTools for parsing, embedding, etc.
      storageType = 'vault';

      const result = await vaultTools.storeDocumentFromPath({
        filePath: assembledPath,
        mimeType: session.mimeType,
        title: session.fileName.replace(/\.[^/.]+$/, ''),
        type: (session.docType || 'other') as any,
        userId: session.userId,
        metadata: {
          ...session.metadata,
          originalFilename: session.fileName,
          fileSize: session.fileSize,
          mimeType: session.mimeType,
          folderPath: session.relativePath,
          uploadSessionId: session.id,
        },
      });

      documentId = result.id;

      logger.info('[Upload] Document processed via VaultTools', {
        sessionId: session.id,
        documentId,
      });
    } else {
      // Route to MinIO for binary storage
      storageType = 'minio';
      const objectKey = MinioService.generateObjectKey(session.fileName);

      const minioResult = await minioService.uploadFile(
        session.userId,
        objectKey,
        assembledPath,
        session.mimeType
      );

      storagePath = `${minioResult.bucket}/${minioResult.key}`;
      documentId = uuidv4();

      // Save metadata record in documents table (with user_id for isolation)
      await pool.query(
        `INSERT INTO documents
          (id, zakononline_id, type, title, metadata, storage_type, storage_path, file_size, mime_type, user_id)
         VALUES ($1, $2, $3, $4, $5, 'minio', $6, $7, $8, $9)`,
        [
          documentId,
          documentId,
          session.docType || 'other',
          session.fileName.replace(/\.[^/.]+$/, ''),
          JSON.stringify({
            ...session.metadata,
            originalFilename: session.fileName,
            fileSize: session.fileSize,
            mimeType: session.mimeType,
            folderPath: session.relativePath,
            uploadedAt: new Date().toISOString(),
            minioEtag: minioResult.etag,
            minioBucket: minioResult.bucket,
            minioKey: minioResult.key,
            uploadSessionId: session.id,
          }),
          storagePath,
          session.fileSize,
          session.mimeType,
          session.userId,
        ]
      );

      logger.info('[Upload] File stored in MinIO', {
        sessionId: session.id,
        documentId,
        bucket: minioResult.bucket,
        key: minioResult.key,
      });
    }

    // Mark session as completed
    await uploadService.setDocumentId(session.id, documentId);

    // Cleanup temp files
    await uploadService.cleanupAssembledFile(session.id);

    logger.info('[Upload] Processing complete', {
      sessionId: session.id,
      documentId,
      storageType,
    });
  } catch (error: any) {
    logger.error('[Upload] Processing failed', {
      sessionId: session.id,
      error: error.message,
      stack: error.stack,
    });
    await uploadService.updateStatus(session.id, 'failed', error.message);
    // Cleanup temp files even on failure
    await uploadService.cleanupAssembledFile(session.id).catch(() => {});
  }
}
