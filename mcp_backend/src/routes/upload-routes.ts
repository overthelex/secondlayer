import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger.js';
import { UploadService } from '../services/upload-service.js';
import { MinioService } from '../services/minio-service.js';
import { VaultTools } from '../api/vault-tools.js';
import { processUploadFile, ProcessorDeps } from '../services/upload-processor.js';
import { AuthenticatedRequest as DualAuthRequest } from '../middleware/dual-auth.js';
import { Pool } from 'pg';

// Multer configured for disk storage of chunks
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 6 * 1024 * 1024, // 6MB per chunk (slightly over 5MB chunk size for overhead)
  },
});

// Semaphore to limit concurrent file processing (DB pool, OpenAI rate limits)
const MAX_CONCURRENT_PROCESSING = 10;
let activeProcessing = 0;
const processingQueue: Array<() => void> = [];

function acquireProcessingSlot(): Promise<void> {
  if (activeProcessing < MAX_CONCURRENT_PROCESSING) {
    activeProcessing++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    processingQueue.push(resolve);
  });
}

function releaseProcessingSlot(): void {
  if (processingQueue.length > 0) {
    const next = processingQueue.shift()!;
    next();
  } else {
    activeProcessing--;
  }
}

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

      const { fileName, fileSize, mimeType, docType, relativePath, metadata, matterId } = req.body;

      if (!fileName || !fileSize || !mimeType) {
        return res.status(400).json({
          error: 'Missing required fields: fileName, fileSize, mimeType',
        });
      }

      const session = await uploadService.createSession(userId, fileName, fileSize, mimeType, {
        docType,
        relativePath,
        metadata,
        matterId,
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
   * POST /:uploadId/retry - Manually retry a stuck/failed session
   */
  router.post('/:uploadId/retry', (async (req: DualAuthRequest, res: Response): Promise<any> => {
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
      if (!['failed', 'assembling', 'processing'].includes(session.status)) {
        return res.status(400).json({
          error: `Session is in status ${session.status}, cannot retry`,
        });
      }
      if (session.retryCount >= 3) {
        return res.status(400).json({ error: 'Maximum retry count (3) reached' });
      }

      res.status(202).json({ uploadId: session.id, status: 'retrying' });

      // Process in background
      processUpload(session, uploadService, minioService, vaultTools, pool, { manualRetry: true }).catch((error) => {
        logger.error('[Upload] Manual retry failed', {
          uploadId: session.id,
          error: error.message,
        });
      });
    } catch (error: any) {
      logger.error('[Upload] Retry failed', { error: error.message });
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
  pool: Pool,
  extraMetadata?: Record<string, any>
): Promise<void> {
  const deps: ProcessorDeps = { uploadService, minioService, vaultTools, pool };

  await acquireProcessingSlot();
  try {
    // Check if document was already created (crash between DB write and status update)
    const existingDocId = await uploadService.findDocumentBySessionId(session.id);
    if (existingDocId) {
      logger.info('[Upload] Document already exists, linking session', {
        sessionId: session.id,
        documentId: existingDocId,
      });
      await uploadService.setDocumentId(session.id, existingDocId);
      await uploadService.cleanupAssembledFile(session.id);
      return;
    }

    if (extraMetadata) {
      await uploadService.incrementRetryCount(session.id);
    }

    await uploadService.updateStatus(session.id, 'processing');

    // Assemble file
    const assembledPath = await uploadService.assembleFile(session.id);

    const documentId = await processUploadFile(session, assembledPath, deps, extraMetadata);

    // Mark session as completed
    await uploadService.setDocumentId(session.id, documentId);

    // Cleanup temp files
    await uploadService.cleanupAssembledFile(session.id);

    logger.info('[Upload] Processing complete', {
      sessionId: session.id,
      documentId,
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
  } finally {
    releaseProcessingSlot();
  }
}
