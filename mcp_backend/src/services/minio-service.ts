import * as Minio from 'minio';
import { logger } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';

export interface MinioUploadResult {
  bucket: string;
  key: string;
  etag: string;
  size: number;
}

export class MinioService {
  private client: Minio.Client;
  private initialized = false;

  constructor() {
    this.client = new Minio.Client({
      endPoint: process.env.MINIO_ENDPOINT || 'localhost',
      port: parseInt(process.env.MINIO_PORT || '9000', 10),
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
      secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
    });
    logger.info('[MinIO] Client initialized', {
      endpoint: process.env.MINIO_ENDPOINT || 'localhost',
      port: process.env.MINIO_PORT || '9000',
    });
  }

  private getBucketName(userId: string): string {
    // MinIO bucket names must be 3-63 chars, lowercase, no underscores
    return `user-${userId}`.toLowerCase().replace(/_/g, '-');
  }

  async ensureBucket(userId: string): Promise<string> {
    const bucket = this.getBucketName(userId);
    try {
      const exists = await this.client.bucketExists(bucket);
      if (!exists) {
        await this.client.makeBucket(bucket);
        logger.info('[MinIO] Bucket created', { bucket });
      }
      return bucket;
    } catch (error: any) {
      logger.error('[MinIO] Failed to ensure bucket', { bucket, error: error.message });
      throw error;
    }
  }

  async uploadFile(
    userId: string,
    objectKey: string,
    filePath: string,
    mimeType: string
  ): Promise<MinioUploadResult> {
    const bucket = await this.ensureBucket(userId);
    const stat = fs.statSync(filePath);

    try {
      const result = await this.client.fPutObject(bucket, objectKey, filePath, {
        'Content-Type': mimeType,
      });

      logger.info('[MinIO] File uploaded', {
        bucket,
        key: objectKey,
        size: stat.size,
        etag: result.etag,
      });

      return {
        bucket,
        key: objectKey,
        etag: result.etag,
        size: stat.size,
      };
    } catch (error: any) {
      logger.error('[MinIO] Upload failed', {
        bucket,
        key: objectKey,
        error: error.message,
      });
      throw error;
    }
  }

  async getFileUrl(
    userId: string,
    objectKey: string,
    expirySeconds: number = 3600
  ): Promise<string> {
    const bucket = this.getBucketName(userId);
    try {
      return await this.client.presignedGetObject(bucket, objectKey, expirySeconds);
    } catch (error: any) {
      logger.error('[MinIO] Failed to generate presigned URL', {
        bucket,
        key: objectKey,
        error: error.message,
      });
      throw error;
    }
  }

  async deleteFile(userId: string, objectKey: string): Promise<void> {
    const bucket = this.getBucketName(userId);
    try {
      await this.client.removeObject(bucket, objectKey);
      logger.info('[MinIO] File deleted', { bucket, key: objectKey });
    } catch (error: any) {
      logger.error('[MinIO] Delete failed', {
        bucket,
        key: objectKey,
        error: error.message,
      });
      throw error;
    }
  }

  async listFiles(
    userId: string,
    prefix?: string
  ): Promise<Array<{ name: string; size: number; lastModified: Date }>> {
    const bucket = this.getBucketName(userId);
    const files: Array<{ name: string; size: number; lastModified: Date }> = [];

    return new Promise((resolve, reject) => {
      const stream = this.client.listObjects(bucket, prefix || '', true);
      stream.on('data', (obj) => {
        if (obj.name) {
          files.push({
            name: obj.name,
            size: obj.size || 0,
            lastModified: obj.lastModified || new Date(),
          });
        }
      });
      stream.on('error', (err) => {
        logger.error('[MinIO] List failed', { bucket, prefix, error: err.message });
        reject(err);
      });
      stream.on('end', () => resolve(files));
    });
  }

  async deleteBucket(bucketName: string): Promise<void> {
    try {
      const exists = await this.client.bucketExists(bucketName);
      if (!exists) return;

      // Remove all objects first
      const objects: string[] = [];
      await new Promise<void>((resolve, reject) => {
        const stream = this.client.listObjects(bucketName, '', true);
        stream.on('data', (obj) => { if (obj.name) objects.push(obj.name); });
        stream.on('error', reject);
        stream.on('end', () => resolve());
      });

      if (objects.length > 0) {
        await this.client.removeObjects(bucketName, objects);
      }

      await this.client.removeBucket(bucketName);
      logger.info('[MinIO] Bucket deleted', { bucket: bucketName });
    } catch (error: any) {
      logger.error('[MinIO] Delete bucket failed', { bucket: bucketName, error: error.message });
      throw error;
    }
  }

  /**
   * Generate object key for a file
   * Format: YYYY/MM/original-filename
   */
  static generateObjectKey(fileName: string): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    // Sanitize filename - keep only safe chars
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `${year}/${month}/${safeName}`;
  }

  /**
   * Health check — verifies MinIO connectivity.
   */
  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      // listBuckets is the lightest admin-level check
      await this.client.listBuckets();
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  }
}
