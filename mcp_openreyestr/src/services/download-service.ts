import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';

export interface DownloadOptions {
  maxRetries?: number;
  timeoutMs?: number;
  onProgress?: (downloadedMB: number, totalMB: number | null) => void;
}

export interface DownloadResult {
  filePath: string;
  sizeBytes: number;
  resumed: boolean;
  attempts: number;
}

const BACKOFF_BASE_MS = 5000;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export class DownloadService {
  /**
   * Download a file with resume support via HTTP Range headers.
   * If the file already exists on disk, attempts to resume from where it left off.
   */
  async download(url: string, destPath: string, options: DownloadOptions = {}): Promise<DownloadResult> {
    const { maxRetries = 3, timeoutMs = 45 * 60 * 1000, onProgress } = options;

    // Ensure dest directory exists
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let attempts = 0;
    let resumed = false;

    while (attempts < maxRetries) {
      attempts++;
      try {
        const existingSize = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
        const result = await this.attemptDownload(url, destPath, existingSize, timeoutMs, onProgress);
        resumed = result.resumed;
        break;
      } catch (err) {
        const backoff = BACKOFF_BASE_MS * Math.pow(3, attempts - 1);
        console.error(`Download attempt ${attempts}/${maxRetries} failed: ${(err as Error).message}`);
        if (attempts < maxRetries) {
          console.log(`Retrying in ${backoff / 1000}s...`);
          await new Promise(r => setTimeout(r, backoff));
        } else {
          throw new Error(`Download failed after ${maxRetries} attempts: ${(err as Error).message}`);
        }
      }
    }

    // Validate downloaded file
    const finalSize = fs.statSync(destPath).size;
    if (finalSize === 0) {
      throw new Error('Downloaded file is empty');
    }

    // ZIP magic bytes check
    const header = Buffer.alloc(4);
    const fd = fs.openSync(destPath, 'r');
    fs.readSync(fd, header, 0, 4, 0);
    fs.closeSync(fd);
    if (!header.subarray(0, 4).equals(ZIP_MAGIC)) {
      console.warn('Warning: Downloaded file does not have ZIP magic bytes — may not be a valid ZIP');
    }

    return { filePath: destPath, sizeBytes: finalSize, resumed, attempts };
  }

  private attemptDownload(
    url: string,
    destPath: string,
    existingSize: number,
    timeoutMs: number,
    onProgress?: (downloadedMB: number, totalMB: number | null) => void
  ): Promise<{ resumed: boolean }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (existingSize > 0) {
        headers['Range'] = `bytes=${existingSize}-`;
      }

      const followRedirects = (targetUrl: string, depth = 0) => {
        if (depth > 5) {
          reject(new Error('Too many redirects'));
          return;
        }

        const reqClient = targetUrl.startsWith('https') ? https : http;
        const req = reqClient.get(targetUrl, { headers, timeout: timeoutMs }, (res) => {
          // Follow redirects
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            followRedirects(res.headers.location, depth + 1);
            return;
          }

          const resumed = res.statusCode === 206;
          if (res.statusCode === 200 && existingSize > 0) {
            // Server doesn't support Range — restart from scratch
            console.log('Server does not support resume, restarting download from scratch');
          } else if (res.statusCode !== 200 && res.statusCode !== 206) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }

          const totalBytes = res.headers['content-length']
            ? parseInt(res.headers['content-length'], 10) + (resumed ? existingSize : 0)
            : null;

          const flags = resumed ? 'a' : 'w';
          const file = fs.createWriteStream(destPath, { flags });
          let downloaded = resumed ? existingSize : 0;
          let lastReportedMB = 0;

          res.on('data', (chunk: Buffer) => {
            downloaded += chunk.length;
            const mb = Math.floor(downloaded / (1024 * 1024));
            if (onProgress && mb >= lastReportedMB + 10) {
              lastReportedMB = mb;
              onProgress(mb, totalBytes ? Math.round(totalBytes / (1024 * 1024)) : null);
            }
          });

          res.pipe(file);

          file.on('finish', () => {
            file.close(() => resolve({ resumed }));
          });

          file.on('error', (err) => {
            fs.unlink(destPath, () => {}); // Clean up partial file on write error
            reject(err);
          });
        });

        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Download timeout'));
        });
      };

      followRedirects(url);
    });
  }
}
