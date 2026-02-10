import path from 'path';
import { logger } from '../utils/logger.js';
import { UploadService, UploadSession } from './upload-service.js';
import { MinioService } from './minio-service.js';
import { VaultTools } from '../api/vault-tools.js';
import { processUploadFile, ProcessorDeps } from './upload-processor.js';
import { Pool } from 'pg';

const MAX_RETRIES = 3;
const STUCK_THRESHOLD_MINUTES = 10;
const PERIODIC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STARTUP_DELAY_MS = 30 * 1000; // 30 seconds

export class UploadRecoveryService {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;
  private deps: ProcessorDeps;
  private running = false;

  constructor(
    private uploadService: UploadService,
    minioService: MinioService,
    vaultTools: VaultTools,
    pool: Pool
  ) {
    this.deps = { uploadService, minioService, vaultTools, pool };
  }

  start(): void {
    logger.info('[UploadRecovery] Starting recovery service');

    // Startup recovery pass after 30s (let other services initialize first)
    this.startupTimeout = setTimeout(async () => {
      await this.runRecoveryPass('startup');

      // Then periodic passes every 5 minutes
      this.intervalHandle = setInterval(async () => {
        await this.runRecoveryPass('periodic');
      }, PERIODIC_INTERVAL_MS);
    }, STARTUP_DELAY_MS);
  }

  stop(): void {
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    logger.info('[UploadRecovery] Recovery service stopped');
  }

  async runRecoveryPass(trigger: 'startup' | 'periodic'): Promise<void> {
    if (this.running) {
      logger.debug('[UploadRecovery] Recovery pass already in progress, skipping');
      return;
    }

    this.running = true;
    try {
      const sessions = trigger === 'startup'
        ? await this.uploadService.getRecoverableOnStartup()
        : await this.uploadService.getStuckSessions(STUCK_THRESHOLD_MINUTES);

      if (sessions.length === 0) {
        logger.debug(`[UploadRecovery] ${trigger} pass: no stuck sessions found`);
        return;
      }

      logger.info(`[UploadRecovery] ${trigger} pass: found ${sessions.length} stuck session(s)`, {
        sessionIds: sessions.map(s => s.id),
      });

      for (const session of sessions) {
        try {
          await this.recoverSession(session, trigger);
        } catch (error: any) {
          logger.error('[UploadRecovery] Session recovery failed', {
            sessionId: session.id,
            error: error.message,
          });
        }
      }
    } catch (error: any) {
      logger.error(`[UploadRecovery] ${trigger} pass failed`, { error: error.message });
    } finally {
      this.running = false;
    }
  }

  private async recoverSession(session: UploadSession, trigger: string): Promise<void> {
    logger.info('[UploadRecovery] Attempting recovery', {
      sessionId: session.id,
      fileName: session.fileName,
      status: session.status,
      retryCount: session.retryCount,
      trigger,
    });

    // 1. Check if document was already created (crash between DB write and status update)
    const existingDocId = session.documentId || await this.uploadService.findDocumentBySessionId(session.id);
    if (existingDocId) {
      logger.info('[UploadRecovery] Document already exists, marking completed', {
        sessionId: session.id,
        documentId: existingDocId,
      });
      await this.uploadService.setDocumentId(session.id, existingDocId);
      await this.uploadService.cleanupAssembledFile(session.id);
      return;
    }

    // 2. Check disk state
    const diskState = await this.uploadService.checkFilesOnDisk(session.id);

    // 3. Increment retry count
    if (session.retryCount >= MAX_RETRIES) {
      await this.uploadService.updateStatus(
        session.id, 'failed', `Max retries (${MAX_RETRIES}) exceeded during recovery`
      );
      return;
    }
    await this.uploadService.incrementRetryCount(session.id);

    const recoveryMeta = {
      recoveredAt: new Date().toISOString(),
      recoveryTrigger: trigger,
      retryCount: session.retryCount + 1,
    };

    if (diskState.hasAssembled && diskState.assembledFileName) {
      // Assembled file exists — retry processing
      const assembledPath = path.join(this.uploadService.tempDirectory, session.id, diskState.assembledFileName);
      logger.info('[UploadRecovery] Found assembled file, retrying processing', {
        sessionId: session.id,
        assembledPath,
      });

      try {
        await this.uploadService.updateStatus(session.id, 'processing');
        const documentId = await processUploadFile(session, assembledPath, this.deps, recoveryMeta);
        await this.uploadService.setDocumentId(session.id, documentId);
        await this.uploadService.cleanupAssembledFile(session.id);
        logger.info('[UploadRecovery] Session recovered via assembled file', {
          sessionId: session.id,
          documentId,
        });
      } catch (error: any) {
        logger.error('[UploadRecovery] Processing retry failed', {
          sessionId: session.id,
          error: error.message,
        });
        await this.uploadService.updateStatus(session.id, 'failed', `Recovery failed: ${error.message}`);
        await this.uploadService.cleanupAssembledFile(session.id).catch(() => {});
      }
    } else if (diskState.hasChunks && diskState.chunkCount === session.totalChunks) {
      // All chunks present — re-assemble then process
      logger.info('[UploadRecovery] Found all chunks, re-assembling', {
        sessionId: session.id,
        chunkCount: diskState.chunkCount,
      });

      try {
        await this.uploadService.updateStatus(session.id, 'assembling');
        const assembledPath = await this.uploadService.assembleFile(session.id);
        await this.uploadService.updateStatus(session.id, 'processing');
        const documentId = await processUploadFile(session, assembledPath, this.deps, recoveryMeta);
        await this.uploadService.setDocumentId(session.id, documentId);
        await this.uploadService.cleanupAssembledFile(session.id);
        logger.info('[UploadRecovery] Session recovered via chunk re-assembly', {
          sessionId: session.id,
          documentId,
        });
      } catch (error: any) {
        logger.error('[UploadRecovery] Re-assembly/processing failed', {
          sessionId: session.id,
          error: error.message,
        });
        await this.uploadService.updateStatus(session.id, 'failed', `Recovery failed: ${error.message}`);
        await this.uploadService.cleanupAssembledFile(session.id).catch(() => {});
      }
    } else {
      // Partial or no files on disk — cannot recover
      const reason = diskState.hasChunks
        ? `Only ${diskState.chunkCount}/${session.totalChunks} chunks on disk`
        : 'No files on disk (lost after restart)';

      logger.warn('[UploadRecovery] Cannot recover session, marking failed', {
        sessionId: session.id,
        reason,
      });
      await this.uploadService.updateStatus(session.id, 'failed', `Unrecoverable: ${reason}`);
      await this.uploadService.cleanupAssembledFile(session.id).catch(() => {});
    }
  }
}
