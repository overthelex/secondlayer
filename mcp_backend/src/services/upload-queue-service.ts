import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { logger } from '../utils/logger.js';
import { UploadService, UploadSession } from './upload-service.js';
import { MinioService } from './minio-service.js';
import { VaultTools } from '../api/vault-tools.js';
import { processUploadFile, ProcessorDeps } from './upload-processor.js';
import { Pool } from 'pg';

export interface UploadJobData {
  sessionId: string;
  userId: string;
  fileName: string;
  mimeType: string;
  docType: string;
  matterId?: string;
  extraMetadata?: Record<string, any>;
}

export interface UploadQueueMetrics {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

const QUEUE_NAME = 'upload-processing';
const DEFAULT_CONCURRENCY = parseInt(process.env.MAX_CONCURRENT_PROCESSING || '50', 10);

export class UploadQueueService {
  private queue: Queue;
  private worker: Worker | null = null;
  private queueEvents: QueueEvents | null = null;
  private deps: ProcessorDeps;

  constructor(
    private uploadService: UploadService,
    minioService: MinioService,
    vaultTools: VaultTools,
    pool: Pool
  ) {
    this.deps = { uploadService, minioService, vaultTools, pool };

    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);

    const connection = { host: redisHost, port: redisPort };

    this.queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000, // 5s, 10s, 20s
        },
        removeOnComplete: {
          age: 24 * 3600, // Keep completed jobs for 24h
          count: 10000,
        },
        removeOnFail: {
          age: 7 * 24 * 3600, // Keep failed jobs for 7 days
        },
      },
    });

    logger.info('[UploadQueue] Queue initialized', { queue: QUEUE_NAME, redisHost, redisPort });
  }

  /**
   * Start the worker that processes upload jobs
   */
  startWorker(): void {
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
    const connection = { host: redisHost, port: redisPort };
    const concurrency = DEFAULT_CONCURRENCY;

    this.worker = new Worker(
      QUEUE_NAME,
      async (job: Job<UploadJobData>) => {
        return this.processJob(job);
      },
      {
        connection,
        concurrency,
        limiter: {
          max: 10,
          duration: 5000, // Max 10 jobs started per 5 seconds — prevents OpenAI API burst
        },
      }
    );

    this.worker.on('completed', (job: Job<UploadJobData>) => {
      logger.info('[UploadQueue] Job completed', {
        jobId: job.id,
        sessionId: job.data.sessionId,
      });
    });

    this.worker.on('failed', (job: Job<UploadJobData> | undefined, err: Error) => {
      logger.error('[UploadQueue] Job failed', {
        jobId: job?.id,
        sessionId: job?.data?.sessionId,
        error: err.message,
        attemptsMade: job?.attemptsMade,
      });
    });

    this.worker.on('error', (err: Error) => {
      logger.error('[UploadQueue] Worker error', { error: err.message });
    });

    // Queue events for monitoring
    this.queueEvents = new QueueEvents(QUEUE_NAME, { connection });

    logger.info('[UploadQueue] Worker started', { concurrency });
  }

  /**
   * Enqueue a completed upload for processing
   */
  async enqueueProcessing(session: UploadSession, extraMetadata?: Record<string, any>): Promise<string> {
    const jobData: UploadJobData = {
      sessionId: session.id,
      userId: session.userId,
      fileName: session.fileName,
      mimeType: session.mimeType,
      docType: session.docType,
      matterId: session.matterId,
      extraMetadata,
    };

    const job = await this.queue.add('process-upload', jobData, {
      jobId: `upload-${session.id}`, // Prevent duplicate jobs for same session
    });

    logger.info('[UploadQueue] Job enqueued', {
      jobId: job.id,
      sessionId: session.id,
    });

    return job.id!;
  }

  /**
   * Re-enqueue stuck sessions (for startup recovery)
   */
  async enqueueRecovery(sessions: UploadSession[]): Promise<number> {
    let enqueued = 0;
    for (const session of sessions) {
      try {
        await this.enqueueProcessing(session, {
          recoveredAt: new Date().toISOString(),
          recoveryTrigger: 'startup',
        });
        enqueued++;
      } catch (err: any) {
        // Job already exists for this session — skip
        if (err.message?.includes('already exists')) {
          logger.debug('[UploadQueue] Job already exists for session', { sessionId: session.id });
        } else {
          logger.error('[UploadQueue] Failed to enqueue recovery', {
            sessionId: session.id,
            error: err.message,
          });
        }
      }
    }
    return enqueued;
  }

  /**
   * Get queue metrics
   */
  async getMetrics(): Promise<UploadQueueMetrics> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
    return {
      waiting: counts.waiting || 0,
      active: counts.active || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      delayed: counts.delayed || 0,
    };
  }

  /**
   * Stop the worker and close connections
   */
  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    if (this.queueEvents) {
      await this.queueEvents.close();
      this.queueEvents = null;
    }
    await this.queue.close();
    logger.info('[UploadQueue] Queue service stopped');
  }

  /**
   * Process a single upload job
   */
  private async processJob(job: Job<UploadJobData>): Promise<string> {
    const { sessionId, extraMetadata } = job.data;

    const session = await this.uploadService.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Check if document was already created (crash between DB write and status update)
    const existingDocId = await this.uploadService.findDocumentBySessionId(session.id);
    if (existingDocId) {
      logger.info('[UploadQueue] Document already exists, linking session', {
        sessionId: session.id,
        documentId: existingDocId,
      });
      await this.uploadService.setDocumentId(session.id, existingDocId);
      await this.uploadService.cleanupAssembledFile(session.id);
      return existingDocId;
    }

    if (extraMetadata) {
      await this.uploadService.incrementRetryCount(session.id);
    }

    await this.uploadService.updateStatus(session.id, 'processing');

    try {
      // Assemble file
      const assembledPath = await this.uploadService.assembleFile(session.id);

      const documentId = await processUploadFile(session, assembledPath, this.deps, extraMetadata);

      // Mark session as completed
      await this.uploadService.setDocumentId(session.id, documentId);

      // Cleanup temp files
      await this.uploadService.cleanupAssembledFile(session.id);

      logger.info('[UploadQueue] Processing complete', {
        sessionId: session.id,
        documentId,
      });

      return documentId;
    } catch (error: any) {
      logger.error('[UploadQueue] Processing failed', {
        sessionId: session.id,
        error: error.message,
        attempt: job.attemptsMade,
      });

      // Only mark as failed on final attempt
      if (job.attemptsMade >= (job.opts.attempts || 3)) {
        await this.uploadService.updateStatus(session.id, 'failed', error.message);
        await this.uploadService.cleanupAssembledFile(session.id).catch(() => {});
      }

      throw error; // Re-throw for BullMQ retry logic
    }
  }
}
