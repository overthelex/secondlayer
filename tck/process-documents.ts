#!/usr/bin/env ts-node

import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

const API_URL = 'http://localhost:3002/api/parse-document';
const OUTPUT_DIR = './parsed-results';

interface ParseResult {
  filename: string;
  success: boolean;
  text?: string;
  metadata?: any;
  error?: string;
  processingTime?: number;
}

function detectMimeType(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();

  const mimeTypes: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.html': 'text/html',
    '.htm': 'text/html',
  };

  return mimeTypes[ext] || null;
}

async function parseDocument(filePath: string): Promise<ParseResult> {
  const filename = path.basename(filePath);
  const startTime = Date.now();

  console.log(`\n📄 Processing: ${filename}`);

  try {
    const mimeType = detectMimeType(filename);

    if (!mimeType) {
      console.log(`⏭️  Skipping unsupported file type: ${filename}`);
      return {
        filename,
        success: false,
        error: 'Unsupported file type',
      };
    }

    // Read file and encode to base64
    const fileBuffer = await fs.readFile(filePath);
    const fileBase64 = fileBuffer.toString('base64');

    console.log(`  Size: ${(fileBuffer.length / 1024).toFixed(2)} KB`);
    console.log(`  Type: ${mimeType}`);
    console.log(`  Sending to document service...`);

    // Send to API using curl
    const payload = JSON.stringify({
      fileBase64,
      mimeType,
      filename,
    });

    // Save payload to temp file to avoid command line length limits
    const tempPayloadFile = `/tmp/payload-${Date.now()}.json`;
    await fs.writeFile(tempPayloadFile, payload);

    const curlCommand = `curl -s -X POST "${API_URL}" \
      -H "Content-Type: application/json" \
      --data @"${tempPayloadFile}" \
      --max-time 300`;

    const { stdout, stderr } = await execAsync(curlCommand);

    // Clean up temp file
    await fs.unlink(tempPayloadFile).catch(() => {});

    if (stderr && !stdout) {
      throw new Error(`API error: ${stderr}`);
    }

    const response = JSON.parse(stdout);

    if (response.error) {
      throw new Error(response.error);
    }

    const processingTime = Date.now() - startTime;

    console.log(`  ✅ Success! Extracted ${response.text?.length || 0} characters`);
    console.log(`  Processing time: ${(processingTime / 1000).toFixed(2)}s`);

    if (response.metadata?.source) {
      console.log(`  Source: ${response.metadata.source}`);
    }
    if (response.metadata?.pageCount) {
      console.log(`  Pages: ${response.metadata.pageCount}`);
    }

    return {
      filename,
      success: true,
      text: response.text,
      metadata: response.metadata,
      processingTime,
    };

  } catch (error: any) {
    const processingTime = Date.now() - startTime;
    console.log(`  ❌ Error: ${error.message}`);

    return {
      filename,
      success: false,
      error: error.message,
      processingTime,
    };
  }
}

async function main() {
  console.log('🚀 Document Processing Script');
  console.log('=============================\n');
  console.log(`API URL: ${API_URL}`);
  console.log(`Output directory: ${OUTPUT_DIR}\n`);

  // Create output directory
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  // Get all files in current directory
  const files = await fs.readdir('.');
  const documentFiles = files.filter(file => {
    const ext = path.extname(file).toLowerCase();
    return ['.pdf', '.docx', '.doc', '.html', '.htm'].includes(ext);
  });

  console.log(`Found ${documentFiles.length} document(s) to process\n`);

  if (documentFiles.length === 0) {
    console.log('No documents found to process.');
    return;
  }

  const results: ParseResult[] = [];

  // Process each file
  for (const file of documentFiles) {
    const result = await parseDocument(file);
    results.push(result);

    // Save parsed text to file
    if (result.success && result.text) {
      const outputFilename = `${path.parse(file).name}.txt`;
      const outputPath = path.join(OUTPUT_DIR, outputFilename);

      await fs.writeFile(outputPath, result.text, 'utf-8');
      console.log(`  💾 Saved to: ${outputPath}`);
    }
  }

  // Save summary report
  const summaryPath = path.join(OUTPUT_DIR, '_summary.json');
  await fs.writeFile(summaryPath, JSON.stringify(results, null, 2), 'utf-8');

  // Print summary
  console.log('\n\n📊 Processing Summary');
  console.log('=====================\n');

  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const totalTime = results.reduce((sum, r) => sum + (r.processingTime || 0), 0);

  console.log(`Total documents: ${results.length}`);
  console.log(`✅ Successful: ${successful}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`⏱️  Total time: ${(totalTime / 1000).toFixed(2)}s`);
  console.log(`📁 Results saved to: ${OUTPUT_DIR}/`);
  console.log(`📋 Summary report: ${summaryPath}\n`);

  if (failed > 0) {
    console.log('\n❌ Failed documents:');
    results
      .filter(r => !r.success)
      .forEach(r => {
        console.log(`  - ${r.filename}: ${r.error}`);
      });
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
