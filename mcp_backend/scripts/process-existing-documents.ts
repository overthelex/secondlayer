#!/usr/bin/env node
/**
 * Script to process existing documents in the database
 * Extracts sections from documents that have full_text but no sections yet
 */

import { Database } from '../src/database/database';
import { DocumentService } from '../src/services/document-service';
import { SemanticSectionizer } from '../src/services/semantic-sectionizer';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

interface ProcessingStats {
  total_docs: number;
  already_processed: number;
  to_process: number;
  processed: number;
  failed: number;
  sections_created: number;
  start_time: Date;
}

async function main() {
  const stats: ProcessingStats = {
    total_docs: 0,
    already_processed: 0,
    to_process: 0,
    processed: 0,
    failed: 0,
    sections_created: 0,
    start_time: new Date(),
  };

  console.log('🚀 Starting batch processing of existing documents...\n');

  // Initialize services
  const db = new Database();
  await db.connect();

  const documentService = new DocumentService(db);
  const sectionizer = new SemanticSectionizer();

  try {
    // Get documents that need processing (have full_text but no sections)
    const result = await db.query(`
      SELECT
        d.id,
        d.zakononline_id,
        d.full_text,
        COUNT(ds.id) as section_count
      FROM documents d
      LEFT JOIN document_sections ds ON d.id = ds.document_id
      WHERE d.full_text IS NOT NULL
        AND LENGTH(d.full_text) > 100
      GROUP BY d.id, d.zakononline_id, d.full_text
      HAVING COUNT(ds.id) = 0
      ORDER BY d.created_at DESC
      LIMIT 50
    `);

    const documentsToProcess = result.rows;
    stats.total_docs = (await db.query('SELECT COUNT(*) as count FROM documents')).rows[0].count;
    stats.already_processed = stats.total_docs - documentsToProcess.length;
    stats.to_process = documentsToProcess.length;

    console.log(`📊 Statistics:`);
    console.log(`   Total documents in DB: ${stats.total_docs}`);
    console.log(`   Already processed: ${stats.already_processed}`);
    console.log(`   To process: ${stats.to_process}\n`);

    if (stats.to_process === 0) {
      console.log('✅ All documents already processed!');
      return;
    }

    console.log(`🔄 Processing ${stats.to_process} documents...\n`);

    // Process documents in batches
    const BATCH_SIZE = 10;
    const USE_LLM = false; // Set to false for faster regex-only extraction (TESTING MODE)

    for (let i = 0; i < documentsToProcess.length; i += BATCH_SIZE) {
      const batch = documentsToProcess.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(documentsToProcess.length / BATCH_SIZE);

      console.log(`📦 Batch ${batchNum}/${totalBatches} (${batch.length} documents)`);

      // Process batch in parallel
      const batchPromises = batch.map(async (doc) => {
        try {
          // Extract sections
          const sections = await sectionizer.extractSections(doc.full_text, USE_LLM);

          if (sections && sections.length > 0) {
            // Save sections to database
            await documentService.saveSections(doc.id, sections);

            stats.processed++;
            stats.sections_created += sections.length;

            console.log(`   ✅ ${doc.zakononline_id}: ${sections.length} sections`);
          } else {
            console.log(`   ⚠️  ${doc.zakononline_id}: no sections extracted`);
            stats.processed++;
          }
        } catch (error: any) {
          console.error(`   ❌ ${doc.zakononline_id}: ${error.message}`);
          stats.failed++;
        }
      });

      await Promise.all(batchPromises);

      // Progress update
      const progress = Math.round((stats.processed + stats.failed) / stats.to_process * 100);
      const elapsed = Math.round((Date.now() - stats.start_time.getTime()) / 1000);
      const rate = (stats.processed + stats.failed) / elapsed;
      const eta = Math.round((stats.to_process - stats.processed - stats.failed) / rate);

      console.log(`   📈 Progress: ${progress}% | ${stats.processed}/${stats.to_process} | ${stats.sections_created} sections | ETA: ${eta}s\n`);

      // Small delay between batches to avoid overloading
      if (i + BATCH_SIZE < documentsToProcess.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Final statistics
    const totalTime = Math.round((Date.now() - stats.start_time.getTime()) / 1000);
    console.log('\n✅ Processing complete!\n');
    console.log('📊 Final Statistics:');
    console.log(`   Processed: ${stats.processed}`);
    console.log(`   Failed: ${stats.failed}`);
    console.log(`   Sections created: ${stats.sections_created}`);
    console.log(`   Total time: ${totalTime}s`);
    console.log(`   Rate: ${(stats.processed / totalTime).toFixed(2)} docs/sec\n`);

  } catch (error) {
    console.error('❌ Error during processing:', error);
    throw error;
  } finally {
    await db.close();
  }
}

// Run the script
main()
  .then(() => {
    console.log('✅ Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Script failed:', error);
    process.exit(1);
  });
