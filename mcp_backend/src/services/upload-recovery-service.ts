import path from 'path';
import { logger } from '../utils/logger.js';
import { UploadService, UploadSession } from './upload-service.js';
import { MinioService } from './minio-service.js';
import { VaultTools } from '../api/vault-tools.js';
import { processUploadFile, ProcessorDeps } from './upload-processor.js';
import { UploadQueueService } from './upload-queue-service.js';
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
  private uploadQueueService: UploadQueueService | null = null;

  constructor(
    private uploadService: UploadService,
    minioService: MinioService,
    vaultTools: VaultTools,
    pool: Pool
  ) {
    this.deps = { uploadService, minioService, vaultTools, pool };
  }

  /**
   * Set BullMQ queue service for persistent job enqueuing
   */
  setQueueService(queueService: UploadQueueService): void {
    this.uploadQueueService = queueService;
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
      // First pass: recover stuck assembling/processing sessions
      const sessions = trigger === 'startup'
        ? await this.uploadService.getRecoverableOnStartup()
        : await this.uploadService.getStuckSessions(STUCK_THRESHOLD_MINUTES);

      if (sessions.length > 0) {
        logger.info(`[UploadRecovery] ${trigger} pass: found ${sessions.length} stuck session(s)`, {
          sessionIds: sessions.map(s => s.id),
        });

        // Partition: force-fail sessions that exceeded max retries, recover the rest
        const recoverable: typeof sessions = [];
        for (const session of sessions) {
          if (session.retryCount >= MAX_RETRIES) {
            await this.uploadService.updateStatus(
              session.id, 'failed', `Max retries (${MAX_RETRIES}) exceeded during recovery`
            );
            logger.info('[UploadRecovery] Force-failed max-retry session', {
              sessionId: session.id,
              retryCount: session.retryCount,
            });
          } else {
            recoverable.push(session);
          }
        }

        // If BullMQ is available, re-enqueue recoverable sessions
        if (this.uploadQueueService) {
          if (recoverable.length > 0) {
            const enqueued = await this.uploadQueueService.enqueueRecovery(recoverable);
            logger.info(`[UploadRecovery] ${trigger} pass: enqueued ${enqueued} sessions to BullMQ`);
          }
        } else {
          // Fallback: in-memory recovery (original behavior)
          for (const session of recoverable) {
            try {
              await this.recoverSession(session, trigger);
            } catch (error: any) {
              logger.error('[UploadRecovery] Session recovery failed', {
                sessionId: session.id,
                error: error.message,
              });
            }
          }
        }
      } else {
        logger.debug(`[UploadRecovery] ${trigger} pass: no stuck sessions found`);
      }

      // Second pass: auto-complete fully-uploaded sessions that never got /complete called
      await this.recoverFullyUploadedSessions(trigger);
    } catch (error: any) {
      logger.error(`[UploadRecovery] ${trigger} pass failed`, { error: error.message });
    } finally {
      this.running = false;
    }
  }

  private async recoverFullyUploadedSessions(trigger: string): Promise<void> {
    const staleSessions = await this.uploadService.getFullyUploadedStale(STUCK_THRESHOLD_MINUTES);

    if (staleSessions.length === 0) {
      return;
    }

    logger.info(`[UploadRecovery] Auto-completing ${staleSessions.length} fully-uploaded session(s)`, {
      sessionIds: staleSessions.map(s => s.id),
      trigger,
    });

    // Transition to 'assembling' so cleanupStale() won't cancel them
    for (const session of staleSessions) {
      await this.uploadService.updateStatus(session.id, 'assembling');
    }

    if (this.uploadQueueService) {
      const enqueued = await this.uploadQueueService.enqueueRecovery(staleSessions);
      logger.info(`[UploadRecovery] Auto-complete: enqueued ${enqueued} fully-uploaded sessions to BullMQ`);
      return;
    }

    // Fallback: in-memory recovery
    for (const session of staleSessions) {
      try {
        logger.info('[UploadRecovery] Auto-completing fully-uploaded session', {
          sessionId: session.id,
          fileName: session.fileName,
          totalChunks: session.totalChunks,
        });
        await this.recoverSession(session, trigger);
      } catch (error: any) {
        logger.error('[UploadRecovery] Auto-complete failed for fully-uploaded session', {
          sessionId: session.id,
          error: error.message,
        });
      }
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
