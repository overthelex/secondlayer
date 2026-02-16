#!/usr/bin/env node
/**
 * Index legislation articles into Qdrant vector search.
 * Usage: node scripts/index-legislation-vectors.js [rada_id1] [rada_id2] ...
 * If no args, indexes all legislation that has 0 chunks.
 */

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Find which legislation needs indexing
async function findUnindexed() {
  const result = await pool.query(`
    SELECT l.rada_id, l.short_title, COUNT(la.id) as articles, COUNT(lc.id) as chunks
    FROM legislation l
    JOIN legislation_articles la ON la.legislation_id = l.id AND la.is_current = true
    LEFT JOIN legislation_chunks lc ON lc.legislation_id = l.id
    GROUP BY l.id, l.rada_id, l.short_title
    HAVING COUNT(lc.id) = 0
    ORDER BY l.id
  `);
  return result.rows;
}

// Dynamically import the built backend modules
async function runIndexing(radaIds) {
  // Import from built dist
  const { LegislationService } = await import('../mcp_backend/dist/services/legislation-service.js');
  const { EmbeddingService } = await import('../mcp_backend/dist/services/embedding-service.js');

  const embeddingService = new EmbeddingService();
  const service = new LegislationService(pool, embeddingService);

  for (const radaId of radaIds) {
    console.log(`\n=== Indexing ${radaId} ===`);
    const start = Date.now();
    try {
      await service.indexArticlesForVectorSearch(radaId);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`✓ ${radaId} indexed in ${elapsed}s`);
    } catch (err) {
      console.error(`✗ ${radaId} failed:`, err.message);
    }
  }
}

async function main() {
  try {
    let radaIds = process.argv.slice(2);

    if (radaIds.length === 0) {
      console.log('Finding unindexed legislation...');
      const unindexed = await findUnindexed();
      if (unindexed.length === 0) {
        console.log('All legislation is already indexed!');
        process.exit(0);
      }
      console.log(`Found ${unindexed.length} unindexed codes:`);
      for (const row of unindexed) {
        console.log(`  ${row.rada_id} (${row.short_title}) - ${row.articles} articles, ${row.chunks} chunks`);
      }
      radaIds = unindexed.map(r => r.rada_id);
    }

    await runIndexing(radaIds);
    console.log('\nDone!');
  } catch (err) {
    console.error('Fatal error:', err);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

main();
