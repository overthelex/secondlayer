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
import { uploadInitRateLimit, uploadBatchInitRateLimit, uploadChunkRateLimit } from '../middleware/upload-rate-limit.js';
import { UploadQueueService } from '../services/upload-queue-service.js';
import { Pool } from 'pg';

// Multer configured for disk storage — avoids holding 6MB buffers in memory per chunk
const UPLOAD_TEMP_DIR = process.env.UPLOAD_TEMP_DIR || '/tmp/uploads';
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      // Use a shared multer-tmp dir to avoid conflicts with session dirs
      const multerDir = path.join(UPLOAD_TEMP_DIR, 'multer-tmp');
      fs.mkdir(multerDir, { recursive: true }).then(() => cb(null, multerDir)).catch(cb as any);
    },
    filename: (_req, _file, cb) => {
      cb(null, `chunk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    },
  }),
  limits: {
    fileSize: 6 * 1024 * 1024, // 6MB per chunk (slightly over 5MB chunk size for overhead)
  },
});

// Per-user concurrent session quota (raised from 50: folders can have 1000+ files)
const MAX_USER_SESSIONS = parseInt(process.env.MAX_USER_SESSIONS || '500', 10);

// Semaphore to limit concurrent file processing (DB pool, OpenAI rate limits)
const MAX_CONCURRENT_PROCESSING = parseInt(process.env.MAX_CONCURRENT_PROCESSING || '50', 10);
let activeProcessing = 0;

// Fair processing queue: round-robin per user instead of global FIFO
const userQueues: Map<string, Array<{ resolve: () => void; userId: string }>> = new Map();
let userQueueOrder: string[] = []; // Round-robin rotation order
let currentUserIndex = 0;

function getQueueDepth(): number {
  let total = 0;
  for (const q of userQueues.values()) {
    total += q.length;
  }
  return total;
}

function getProcessingUtilization(): number {
  return MAX_CONCURRENT_PROCESSING > 0 ? activeProcessing / MAX_CONCURRENT_PROCESSING : 0;
}

function acquireProcessingSlot(userId: string): Promise<void> {
  if (activeProcessing < MAX_CONCURRENT_PROCESSING) {
    activeProcessing++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    if (!userQueues.has(userId)) {
      userQueues.set(userId, []);
      userQueueOrder.push(userId);
    }
    userQueues.get(userId)!.push({ resolve, userId });
  });
}

function releaseProcessingSlot(): void {
  // Find the next user with pending work (round-robin)
  if (userQueueOrder.length === 0) {
    activeProcessing--;
    return;
  }

  // Try each user in round-robin order
  for (let i = 0; i < userQueueOrder.length; i++) {
    const idx = (currentUserIndex + i) % userQueueOrder.length;
    const userId = userQueueOrder[idx];
    const queue = userQueues.get(userId);

    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      currentUserIndex = (idx + 1) % userQueueOrder.length;
      // Clean up empty queues
      if (queue.length === 0) {
        userQueues.delete(userId);
        userQueueOrder = userQueueOrder.filter((u) => u !== userId);
        if (currentUserIndex >= userQueueOrder.length) {
          currentUserIndex = 0;
        }
      }
      next.resolve();
      return;
    }
  }

  // No pending work found
  activeProcessing--;
}

/** Add backpressure headers to a response */
function addBackpressureHeaders(res: Response): void {
  const utilization = getProcessingUtilization();
  const queueDepth = getQueueDepth();
  res.setHeader('X-Upload-Queue-Depth', queueDepth.toString());
  res.setHeader('X-Upload-Throttle', utilization >= 0.9 ? '1' : '0');
  if (utilization >= 0.9) {
    res.setHeader('Retry-After', '5');
  }
}

export function createUploadRouter(
  uploadService: UploadService,
  minioService: MinioService,
  vaultTools: VaultTools,
  pool: Pool,
  uploadQueueService?: UploadQueueService
): Router {
  const router = Router();

  /**
   * POST /init - Create a new upload session
   */
  router.post('/init', uploadInitRateLimit as any, (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // Per-user concurrent session quota
      const activeCount = await uploadService.getActiveSessionCount(userId);
      if (activeCount >= MAX_USER_SESSIONS) {
        res.setHeader('Retry-After', '30');
        return res.status(429).json({
          error: 'Too many active upload sessions',
          message: `You have ${activeCount} active sessions (limit: ${MAX_USER_SESSIONS}). Wait for existing uploads to complete.`,
          code: 'SESSION_QUOTA_EXCEEDED',
          retryAfter: 30,
          activeCount,
          maxSessions: MAX_USER_SESSIONS,
        });
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

      addBackpressureHeaders(res);
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
   * POST /init-batch - Create multiple upload sessions at once
   */
  router.post('/init-batch', uploadBatchInitRateLimit as any, (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // Robust body parsing: if Express JSON parser didn't populate req.body, try raw body fallback
      let body = req.body;
      if (!body || (typeof body === 'object' && Object.keys(body).length === 0)) {
        const rawBody = (req as any).rawBody;
        if (rawBody && typeof rawBody === 'string') {
          try {
            body = JSON.parse(rawBody);
          } catch {
            logger.warn('[Upload] Batch init: failed to parse rawBody', {
              contentType: req.headers['content-type'],
              rawBodyLength: rawBody.length,
            });
          }
        }
      }

      const files = body?.files;
      if (!Array.isArray(files) || files.length === 0) {
        logger.warn('[Upload] Batch init: missing or empty files array', {
          contentType: req.headers['content-type'],
          bodyType: typeof body,
          bodyKeys: Object.keys(body || {}),
        });
        return res.status(400).json({ error: 'Missing or empty files array. Ensure Content-Type is application/json.' });
      }

      const maxBatchFiles = parseInt(process.env.MAX_BATCH_INIT_FILES || '2000', 10);
      if (files.length > maxBatchFiles) {
        logger.warn('[Upload] Batch init: too many files', {
          requested: files.length,
          max: maxBatchFiles,
        });
        return res.status(400).json({ error: `Maximum ${maxBatchFiles} files per batch init` });
      }

      // Check session quota for the entire batch
      const activeCount = await uploadService.getActiveSessionCount(userId);
      if (activeCount + files.length > MAX_USER_SESSIONS) {
        res.setHeader('Retry-After', '30');
        return res.status(429).json({
          error: 'Too many active upload sessions',
          message: `You have ${activeCount} active sessions and requested ${files.length} new ones (limit: ${MAX_USER_SESSIONS}).`,
          code: 'SESSION_QUOTA_EXCEEDED',
          retryAfter: 30,
          activeCount,
          maxSessions: MAX_USER_SESSIONS,
        });
      }

      const sessions = [];
      for (const f of files) {
        if (!f.fileName || !f.fileSize || !f.mimeType) {
          sessions.push({ error: 'Missing required fields: fileName, fileSize, mimeType', fileName: f.fileName });
          continue;
        }
        try {
          const session = await uploadService.createSession(userId, f.fileName, f.fileSize, f.mimeType, {
            docType: f.docType,
            relativePath: f.relativePath,
            metadata: f.metadata,
            matterId: f.matterId,
          });
          sessions.push({
            uploadId: session.id,
            chunkSize: session.chunkSize,
            totalChunks: session.totalChunks,
            uploadedChunks: session.uploadedChunks,
            expiresAt: session.expiresAt,
          });
        } catch (err: any) {
          sessions.push({ error: err.message, fileName: f.fileName });
        }
      }

      addBackpressureHeaders(res);
      res.status(201).json({ sessions });
    } catch (error: any) {
      logger.error('[Upload] Batch init failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }) as any);

  /**
   * POST /:uploadId/chunk - Upload a chunk
   */
  router.post('/:uploadId/chunk', uploadChunkRateLimit as any, upload.single('chunk'), (async (req: DualAuthRequest, res: Response): Promise<any> => {
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

      // Read chunk from disk (multer diskStorage) and clean up temp file
      const chunkBuffer = await fs.readFile(req.file.path);
      const result = await uploadService.saveChunk(
        uploadId as string,
        chunkIndex,
        chunkBuffer
      );
      // Remove multer temp file after saving to session dir
      await fs.unlink(req.file.path).catch(() => {});

      addBackpressureHeaders(res);
      res.json(result);
    } catch (error: any) {
      // Clean up multer temp file on error
      if (req.file?.path) {
        await fs.unlink(req.file.path).catch(() => {});
      }
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
      addBackpressureHeaders(res);
      res.status(202).json({
        uploadId: session.id,
        status: 'processing',
      });

      // Enqueue to BullMQ if available, otherwise fall back to in-memory processing
      if (uploadQueueService) {
        uploadQueueService.enqueueProcessing(session).catch((error) => {
          logger.error('[Upload] Failed to enqueue processing', {
            uploadId: session.id,
            error: error.message,
          });
          // Fallback to in-memory processing
          processUpload(session, uploadService, minioService, vaultTools, pool).catch((err) => {
            logger.error('[Upload] Fallback processing failed', {
              uploadId: session.id,
              error: err.message,
            });
          });
        });
      } else {
        processUpload(session, uploadService, minioService, vaultTools, pool).catch((error) => {
          logger.error('[Upload] Background processing failed', {
            uploadId: session.id,
            error: error.message,
          });
        });
      }
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

      addBackpressureHeaders(res);
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

      // Enqueue to BullMQ if available, otherwise fall back to in-memory processing
      if (uploadQueueService) {
        uploadQueueService.enqueueProcessing(session, { manualRetry: true }).catch((error) => {
          logger.error('[Upload] Failed to enqueue retry', {
            uploadId: session.id,
            error: error.message,
          });
        });
      } else {
        processUpload(session, uploadService, minioService, vaultTools, pool, { manualRetry: true }).catch((error) => {
          logger.error('[Upload] Manual retry failed', {
            uploadId: session.id,
            error: error.message,
          });
        });
      }
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

  /**
   * POST /clear-stale - Cancel stale sessions for the current user
   */
  router.post('/clear-stale', (async (req: DualAuthRequest, res: Response): Promise<any> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const cancelled = await uploadService.cancelUserStaleSessions(userId);
      const activeCount = await uploadService.getActiveSessionCount(userId);

      res.json({
        cancelled,
        activeCount,
        maxSessions: MAX_USER_SESSIONS,
      });
    } catch (error: any) {
      logger.error('[Upload] Clear stale failed', { error: error.message });
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

  await acquireProcessingSlot(session.userId);
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

// Export for metrics endpoint
export function getUploadProcessingMetrics() {
  return {
    activeProcessing,
    maxConcurrentProcessing: MAX_CONCURRENT_PROCESSING,
    queueDepth: getQueueDepth(),
    utilization: getProcessingUtilization(),
    uniqueUsersInQueue: userQueueOrder.length,
  };
}
