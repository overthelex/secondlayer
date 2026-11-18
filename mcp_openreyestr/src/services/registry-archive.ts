/**
 * Archive handling shared by the NAIS registry sync paths: the CLI
 * (scripts/sync-all-registries.ts) and the admin endpoint opendata-sync calls
 * (POST /api/admin/sync-registry/:name in http-server.ts).
 *
 * Some data.gov.ua archives hold further archives: 25-edrnpa.zip contains
 * 25.1-edrnpa_cards.zip and 25.2-edrnpa_text.zip. The endpoint used to unzip one
 * level only, so the innerFileName match "edrnpa_cards" picked the nested
 * 25.1-edrnpa_cards.zip and fed its bytes to the XML parser, which failed with
 * "Maximum nested tags exceeded" every week.
 */

import * as fs from 'fs';
import * as path from 'path';
import unzipper from 'unzipper';
import { RegistryConfig } from '../config/registries';

export async function extractZip(zipPath: string, extractDir: string, depth: number = 0): Promise<string[]> {
  if (depth > 2) {
    console.warn(`  Skipping nested ZIP extraction at depth ${depth} (max 2)`);
    return [];
  }
  const { execFileSync } = require('child_process');

  // Try system unzip first — handles ZIP64 and large files better than Node.js unzipper
  try {
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', extractDir], {
      timeout: 10 * 60 * 1000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // Fallback to Node.js unzipper for environments without unzip
    const writePromises: Promise<string>[] = [];
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(zipPath)
        .pipe(unzipper.Parse())
        .on('entry', (entry: any) => {
          const filePath = entry.path as string;
          const type = entry.type as string;
          if (type === 'File') {
            const outPath = path.resolve(extractDir, filePath);
            // Prevent Zip Slip: ensure extracted path stays within extractDir
            if (!outPath.startsWith(path.resolve(extractDir) + path.sep)) {
              entry.autodrain();
              return;
            }
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            const writePromise = new Promise<string>((res) => {
              entry.pipe(fs.createWriteStream(outPath))
                .on('finish', () => res(filePath));
            });
            writePromises.push(writePromise);
          } else {
            entry.autodrain();
          }
        })
        .on('close', () => resolve())
        .on('error', (err: Error) => reject(err));
    });
    await Promise.all(writePromises);
  }

  // List all extracted files (non-directories)
  const extracted = listFilesRecursive(extractDir, extractDir);

  // Recursively extract any nested .zip files found inside (max depth 2)
  const nestedZips = extracted.filter(f => f.toLowerCase().endsWith('.zip'));
  const processedZips = new Set<string>();
  for (const nested of nestedZips) {
    const baseName = path.basename(nested);
    if (processedZips.has(baseName)) {
      console.log(`  Skipping duplicate nested ZIP: ${nested}`);
      continue;
    }
    processedZips.add(baseName);
    const nestedPath = path.join(extractDir, nested);
    if (!fs.existsSync(nestedPath)) continue;
    console.log(`  Extracting nested ZIP: ${nested} (depth ${depth + 1})`);
    try {
      const innerFiles = await extractZip(nestedPath, extractDir, depth + 1);
      extracted.push(...innerFiles);
      try { fs.unlinkSync(nestedPath); } catch { /* ignore */ }
    } catch (err: any) {
      console.error(`  Failed to extract nested ZIP ${nested}: ${err.message}`);
    }
  }

  // The nested call lists the whole extractDir again, so files repeat; dedupe.
  return [...new Set(extracted)].filter(f => !f.toLowerCase().endsWith('.zip'));
}

/** Recursively list files relative to baseDir */
export function listFilesRecursive(dir: string, baseDir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(fullPath, baseDir));
    } else {
      results.push(path.relative(baseDir, fullPath));
    }
  }
  return results;
}

/**
 * The data file to import from the extracted list: the configured innerFileName
 * when set, otherwise the first file with the registry's extension. Archives are
 * never returned, even if their name matches.
 */
export function findDataFile(extracted: string[], config: Pick<RegistryConfig, 'format' | 'innerFileName'>): string | undefined {
  const ext = config.format === 'csv' ? '.csv' : '.xml';
  const files = extracted.filter(f => !f.toLowerCase().endsWith('.zip'));
  const byName = config.innerFileName
    ? files.find(f => f === config.innerFileName || f.endsWith(config.innerFileName) || f.includes(config.innerFileName))
    : undefined;
  return byName ?? files.find(f => f.toLowerCase().endsWith(ext));
}
