#!/usr/bin/env node
/**
 * Batch Document Processor for Cursor IDE
 *
 * Processes thousands of documents (PDF, images, DOCX) with real-time progress
 * using SecondLayer MCP backend with SSE streaming.
 *
 * Usage:
 *   npm run batch-process -- --input ./documents --operations parse,summarize
 *   npm run batch-process -- --input ./pdfs --operations parse,extract_clauses --concurrency 10
 *
 * Features:
 *   - Real-time progress updates via SSE
 *   - Automatic chunking for large batches
 *   - Cost estimation and tracking
 *   - Retry logic for failed files
 *   - Resume support for interrupted batches
 */

import fs from 'fs';
import path from 'path';
import { program } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import dotenv from 'dotenv';

dotenv.config();

interface ProcessingStats {
  total: number;
  completed: number;
  failed: number;
  startTime: number;
  estimatedCostUsd: number;
  processedFiles: Set<string>;
  failedFiles: Array<{ filename: string; error: string }>;
}

interface BatchConfig {
  apiUrl: string;
  apiKey: string;
  inputDir: string;
  outputDir: string;
  operations: {
    parse?: boolean;
    extract_clauses?: boolean;
    summarize?: boolean;
    summarize_level?: 'quick' | 'standard' | 'deep';
  };
  concurrency: number;
  chunkSize: number;
  retryAttempts: number;
  resumeFile?: string;
}

class BatchDocumentProcessor {
  private config: BatchConfig;
  private stats: ProcessingStats;
  private spinner: any;

  constructor(config: BatchConfig) {
    this.config = config;
    this.stats = {
      total: 0,
      completed: 0,
      failed: 0,
      startTime: Date.now(),
      estimatedCostUsd: 0,
      processedFiles: new Set(),
      failedFiles: [],
    };
  }

  async run() {
    console.log(chalk.cyan.bold('\n📦 SecondLayer Batch Document Processor\n'));

    // 1. Scan files
    this.spinner = ora('Scanning files...').start();
    const allFiles = await this.scanFiles(this.config.inputDir);

    // Filter out already processed files (if resuming)
    const files = await this.filterProcessedFiles(allFiles);

    this.stats.total = files.length;
    this.spinner.succeed(`Found ${chalk.green(files.length)} files to process`);

    if (files.length === 0) {
      console.log(chalk.yellow('✨ All files already processed!'));
      return;
    }

    // 2. Show configuration
    this.printConfiguration();

    // 3. Estimate costs
    await this.estimateCosts(files);

    // 4. Confirm start
    console.log(chalk.yellow('\n⚠️  Press CTRL+C to cancel, or wait 3 seconds to start...\n'));
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 5. Process in chunks
    const chunks = this.chunkArray(files, this.config.chunkSize);
    console.log(chalk.cyan(`\n🔄 Processing ${files.length} files in ${chunks.length} chunks\n`));

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(chalk.blue(`\n📦 Chunk ${i + 1}/${chunks.length} (${chunk.length} files)`));

      try {
        await this.processChunk(chunk, i + 1, chunks.length);
      } catch (error: any) {
        console.error(chalk.red(`\n❌ Chunk ${i + 1} failed: ${error.message}`));
        // Continue with next chunk
      }

      // Save progress after each chunk
      await this.saveProgress();
    }

    // 6. Show final report
    this.printFinalReport();
  }

  private async processChunk(files: string[], chunkNum: number, totalChunks: number) {
    // Convert files to base64
    const filesData = await Promise.all(
      files.map(async (filePath) => {
        const fileBuffer = await fs.promises.readFile(filePath);
        return {
          id: path.relative(this.config.inputDir, filePath),
          filename: path.basename(filePath),
          fileBase64: fileBuffer.toString('base64'),
          mimeType: this.getMimeType(filePath),
        };
      })
    );

    // Send to backend with SSE streaming
    await this.processWithSSE(filesData, chunkNum, totalChunks);
  }

  private async processWithSSE(
    files: any[],
    chunkNum: number,
    totalChunks: number
  ): Promise<void> {
    const url = `${this.config.apiUrl}/api/tools/batch_process_documents/stream`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        arguments: {
          files,
          operations: this.config.operations,
          concurrency: this.config.concurrency,
          retryAttempts: this.config.retryAttempts,
          skipErrors: true,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Parse SSE stream
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let event: any = {};
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          event.type = line.substring(7);
        } else if (line.startsWith('data: ')) {
          try {
            event.data = JSON.parse(line.substring(6));
          } catch {
            event.data = line.substring(6);
          }
        } else if (line === '' && event.type) {
          this.handleSSEEvent(event, chunkNum, totalChunks);
          event = {};
        }
      }
    }
  }

  private handleSSEEvent(event: any, chunkNum: number, totalChunks: number) {
    switch (event.type) {
      case 'connected':
        console.log(chalk.gray(`   Connected to backend (chunk ${chunkNum}/${totalChunks})`));
        break;

      case 'progress':
        if (event.data.fileId) {
          // File completed/failed
          const filename = event.data.filename || event.data.fileId;

          if (event.data.status === 'completed') {
            this.stats.completed++;
            this.stats.processedFiles.add(event.data.fileId);
            this.stats.estimatedCostUsd += event.data.costUsd || 0;

            const percent = ((this.stats.completed + this.stats.failed) / this.stats.total * 100).toFixed(1);
            const costStr = event.data.costUsd ? chalk.gray(` ($${event.data.costUsd.toFixed(4)})`) : '';
            const timeStr = event.data.executionTimeMs ? chalk.gray(` ${(event.data.executionTimeMs / 1000).toFixed(1)}s`) : '';

            console.log(chalk.green(`   ✓ [${percent}%] ${filename}${costStr}${timeStr}`));
          } else if (event.data.status === 'failed') {
            this.stats.failed++;
            this.stats.failedFiles.push({
              filename,
              error: event.data.error || 'Unknown error',
            });

            const percent = ((this.stats.completed + this.stats.failed) / this.stats.total * 100).toFixed(1);
            console.log(chalk.red(`   ✗ [${percent}%] ${filename}: ${event.data.error}`));
          } else if (event.data.status === 'retrying') {
            console.log(chalk.yellow(`   ⟳ Retrying ${filename} (attempt ${event.data.attempt}/${event.data.maxAttempts})`));
          }
        } else if (event.data.message) {
          // Batch progress
          console.log(chalk.gray(`   ${event.data.message}`));
        }
        break;

      case 'complete':
        const elapsed = ((Date.now() - this.stats.startTime) / 1000).toFixed(1);
        console.log(chalk.green(`\n   ✨ Chunk completed in ${elapsed}s`));
        console.log(chalk.gray(`      Total cost: $${event.data.totalCostUsd?.toFixed(4) || '0.0000'}`));
        break;

      case 'error':
        console.error(chalk.red(`\n   ❌ Error: ${event.data.message}`));
        break;
    }
  }

  private async scanFiles(dir: string): Promise<string[]> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          return this.scanFiles(fullPath);
        } else if (/\.(pdf|png|jpg|jpeg|docx|doc)$/i.test(entry.name)) {
          return [fullPath];
        }
        return [];
      })
    );
    return files.flat();
  }

  private async filterProcessedFiles(files: string[]): Promise<string[]> {
    if (!this.config.resumeFile || !fs.existsSync(this.config.resumeFile)) {
      return files;
    }

    const progressData = JSON.parse(await fs.promises.readFile(this.config.resumeFile, 'utf-8'));
    this.stats.completed = progressData.completed || 0;
    this.stats.failed = progressData.failed || 0;
    this.stats.processedFiles = new Set(progressData.processedFiles || []);
    this.stats.estimatedCostUsd = progressData.estimatedCostUsd || 0;

    const remainingFiles = files.filter(file => {
      const relPath = path.relative(this.config.inputDir, file);
      return !this.stats.processedFiles.has(relPath);
    });

    if (this.stats.processedFiles.size > 0) {
      console.log(chalk.yellow(`\n📝 Resuming from previous run (${this.stats.processedFiles.size} files already processed)`));
    }

    return remainingFiles;
  }

  private async saveProgress() {
    if (!this.config.resumeFile) return;

    const progressData = {
      completed: this.stats.completed,
      failed: this.stats.failed,
      processedFiles: Array.from(this.stats.processedFiles),
      failedFiles: this.stats.failedFiles,
      estimatedCostUsd: this.stats.estimatedCostUsd,
      lastUpdate: new Date().toISOString(),
    };

    await fs.promises.writeFile(
      this.config.resumeFile,
      JSON.stringify(progressData, null, 2)
    );
  }

  private printConfiguration() {
    console.log(chalk.cyan('\n⚙️  Configuration:'));
    console.log(`   API URL:       ${this.config.apiUrl}`);
    console.log(`   Input dir:     ${this.config.inputDir}`);
    console.log(`   Output dir:    ${this.config.outputDir}`);
    console.log(`   Operations:    ${Object.entries(this.config.operations).filter(([_, v]) => v).map(([k]) => k).join(', ')}`);
    console.log(`   Concurrency:   ${this.config.concurrency}`);
    console.log(`   Chunk size:    ${this.config.chunkSize}`);
    console.log(`   Retry:         ${this.config.retryAttempts}`);
  }

  private async estimateCosts(files: string[]) {
    // Rough cost estimation
    const hasOCR = this.config.operations.parse;
    const hasAI = this.config.operations.extract_clauses || this.config.operations.summarize;

    let estimatedCostPerFile = 0;
    if (hasOCR) estimatedCostPerFile += 0.0015; // $1.50 per 1000 images (avg 1 page)
    if (hasAI) estimatedCostPerFile += 0.0003; // $0.30 per 1000 AI requests

    const totalEstimatedCost = files.length * estimatedCostPerFile;

    console.log(chalk.cyan('\n💰 Cost Estimation:'));
    console.log(`   Per file:      ~$${estimatedCostPerFile.toFixed(4)}`);
    console.log(`   Total:         ~$${totalEstimatedCost.toFixed(2)}`);

    // Estimated time (very rough)
    const avgTimePerFile = hasOCR ? 0.5 : 0.1; // seconds
    const totalTimeSeconds = (files.length * avgTimePerFile) / this.config.concurrency;
    const hours = Math.floor(totalTimeSeconds / 3600);
    const minutes = Math.floor((totalTimeSeconds % 3600) / 60);

    console.log(chalk.cyan('\n⏱️  Time Estimation:'));
    console.log(`   Per file:      ~${avgTimePerFile}s`);
    console.log(`   Total:         ~${hours}h ${minutes}m (with concurrency ${this.config.concurrency})`);
  }

  private printFinalReport() {
    const elapsed = ((Date.now() - this.stats.startTime) / 1000).toFixed(1);
    const elapsedMinutes = (parseFloat(elapsed) / 60).toFixed(1);

    console.log(chalk.cyan.bold('\n\n📊 Final Report\n'));

    const table = new Table({
      head: [chalk.white('Metric'), chalk.white('Value')],
      colWidths: [30, 20],
    });

    table.push(
      ['Total files', this.stats.total.toString()],
      [chalk.green('✓ Completed'), chalk.green(this.stats.completed.toString())],
      [chalk.red('✗ Failed'), chalk.red(this.stats.failed.toString())],
      ['Success rate', `${(this.stats.completed / this.stats.total * 100).toFixed(1)}%`],
      ['Time elapsed', `${elapsedMinutes} min`],
      ['Avg time per file', `${(parseFloat(elapsed) / this.stats.total).toFixed(2)}s`],
      [chalk.yellow('💰 Total cost'), chalk.yellow(`$${this.stats.estimatedCostUsd.toFixed(4)}`)],
    );

    console.log(table.toString());

    // Failed files
    if (this.stats.failedFiles.length > 0) {
      console.log(chalk.red.bold('\n❌ Failed Files:\n'));
      this.stats.failedFiles.forEach((file, i) => {
        console.log(chalk.red(`   ${i + 1}. ${file.filename}`));
        console.log(chalk.gray(`      Error: ${file.error}\n`));
      });
    }

    console.log(chalk.green.bold('\n✨ Processing complete!\n'));
  }

  private getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.doc': 'application/msword',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    return Array.from(
      { length: Math.ceil(array.length / size) },
      (_, i) => array.slice(i * size, i * size + size)
    );
  }
}

// CLI setup
program
  .name('batch-process-documents')
  .description('Batch process documents (PDF, images, DOCX) using SecondLayer MCP')
  .requiredOption('-i, --input <dir>', 'Input directory with documents')
  .option('-o, --output <dir>', 'Output directory for results', './tests/batch-results')
  .option('--operations <ops>', 'Operations: parse,extract_clauses,summarize', 'parse,summarize')
  .option('--summarize-level <level>', 'Summarization level: quick|standard|deep', 'standard')
  .option('--concurrency <num>', 'Parallel processing (1-20)', '5')
  .option('--chunk-size <num>', 'Files per chunk (max 200)', '100')
  .option('--retry <num>', 'Retry attempts (0-5)', '2')
  .option('--api-url <url>', 'SecondLayer API URL', process.env.SECONDLAYER_API_URL || 'http://localhost:3000')
  .option('--api-key <key>', 'SecondLayer API key', process.env.SECONDLAYER_API_KEY)
  .option('--resume', 'Resume from previous run', false)
  .parse();

const options = program.opts();

// Validate API key
if (!options.apiKey) {
  console.error(chalk.red('❌ Error: API key is required'));
  console.error(chalk.yellow('   Set SECONDLAYER_API_KEY env var or use --api-key option'));
  process.exit(1);
}

// Parse operations
const operations: any = {
  parse: false,
  extract_clauses: false,
  summarize: false,
};

options.operations.split(',').forEach((op: string) => {
  const trimmed = op.trim();
  if (trimmed === 'parse') operations.parse = true;
  if (trimmed === 'extract_clauses') operations.extract_clauses = true;
  if (trimmed === 'summarize') {
    operations.summarize = true;
    operations.summarize_level = options.summarizeLevel;
  }
});

// Create config
const config: BatchConfig = {
  apiUrl: options.apiUrl,
  apiKey: options.apiKey,
  inputDir: path.resolve(options.input),
  outputDir: path.resolve(options.output),
  operations,
  concurrency: parseInt(options.concurrency),
  chunkSize: parseInt(options.chunkSize),
  retryAttempts: parseInt(options.retry),
  resumeFile: options.resume ? path.join(options.output, '.batch-progress.json') : undefined,
};

// Main async function
(async () => {
  try {
    // Ensure output dir exists
    await fs.promises.mkdir(config.outputDir, { recursive: true });

    // Run processor
    const processor = new BatchDocumentProcessor(config);
    await processor.run();
  } catch (error: any) {
    console.error(chalk.red('\n❌ Fatal error:'), error.message);
    process.exit(1);
  }
})();
