import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import { UploadService, UploadSession } from './upload-service.js';
import { MinioService } from './minio-service.js';
import { VaultTools } from '../api/vault-tools.js';
import { Pool } from 'pg';

export interface ProcessorDeps {
  uploadService: UploadService;
  minioService: MinioService;
  vaultTools: VaultTools;
  pool: Pool;
}

/**
 * Process an assembled upload file — routes to VaultTools or MinIO.
 * Shared by the upload route handler and the recovery service.
 */
export async function processUploadFile(
  session: UploadSession,
  assembledPath: string,
  deps: ProcessorDeps,
  extraMetadata?: Record<string, any>
): Promise<string> {
  const { uploadService, minioService, vaultTools, pool } = deps;

  let documentId: string;

  if (UploadService.isDocumentType(session.mimeType)) {
    // Route to VaultTools for parsing, embedding, etc.
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
        ...extraMetadata,
      },
    });

    documentId = result.id;

    logger.info('[Upload] Document processed via VaultTools', {
      sessionId: session.id,
      documentId,
    });
  } else {
    // Route to MinIO for binary storage
    const objectKey = MinioService.generateObjectKey(session.fileName);

    const minioResult = await minioService.uploadFile(
      session.userId,
      objectKey,
      assembledPath,
      session.mimeType
    );

    const storagePath = `${minioResult.bucket}/${minioResult.key}`;
    documentId = uuidv4();

    // Save metadata record in documents table
    await pool.query(
      `INSERT INTO documents
        (id, zakononline_id, type, title, metadata, storage_type, storage_path, file_size, mime_type, user_id, matter_id)
       VALUES ($1, $2, $3, $4, $5, 'minio', $6, $7, $8, $9, $10)`,
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
          ...extraMetadata,
        }),
        storagePath,
        session.fileSize,
        session.mimeType,
        session.userId,
        session.matterId || null,
      ]
    );

    logger.info('[Upload] File stored in MinIO', {
      sessionId: session.id,
      documentId,
      bucket: minioResult.bucket,
      key: minioResult.key,
    });
  }

  return documentId;
}
