#!/usr/bin/env node
/**
 * Rebuild Qdrant `legal_sections` collection from PostgreSQL with voyage-3.5
 *
 * Reads all document_sections from PG, joins with documents for metadata,
 * embeds every section with voyage-3.5, and upserts into Qdrant.
 *
 * Usage (from repo root):
 *   VOYAGEAI_API_KEY=pa-... QDRANT_URL=http://localhost:6333 \
 *   DATABASE_URL=postgresql://secondlayer:...@localhost:5432/secondlayer_local \
 *   node scripts/rebuild-embeddings-voyage35.js
 *
 * Or source from .env first:
 *   set -a && source mcp_backend/.env && set +a
 *   QDRANT_URL=http://localhost:6333 node scripts/rebuild-embeddings-voyage35.js
 */

import pg from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import { v4 as uuidv4 } from 'uuid';

// ─── Config ──────────────────────────────────────────────────────────────────

const NEW_MODEL = process.env.VOYAGEAI_EMBEDDING_MODEL || 'voyage-3.5';
const EMBEDDING_DIMENSION = 1024;
const COLLECTION_NAME = 'legal_sections';
const EMBED_BATCH_SIZE = 50;    // VoyageAI batch (max 128)
const PG_FETCH_SIZE = 500;       // Rows per PG query page
const RATE_LIMIT_DELAY = 200;   // ms between embedding API calls
const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';

// Section types to embed (most semantically useful for legal search)
// Remove AMOUNTS and LAW_REFERENCES if you want a smaller index
const SECTION_TYPES = ['FACTS', 'CLAIMS', 'LAW_REFERENCES', 'COURT_REASONING', 'DECISION', 'AMOUNTS'];

const voyageApiKey = process.env.VOYAGEAI_API_KEY;
const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL ||
  `postgresql://${process.env.POSTGRES_USER || 'secondlayer'}:${process.env.POSTGRES_PASSWORD || ''}@${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || '5432'}/${process.env.POSTGRES_DB || 'secondlayer_local'}`;

if (!voyageApiKey) {
  console.error('ERROR: VOYAGEAI_API_KEY is required');
  process.exit(1);
}

const qdrant = new QdrantClient({ url: qdrantUrl });
const pool = new pg.Pool({ connectionString: dbUrl, max: 3 });

// ─── VoyageAI ─────────────────────────────────────────────────────────────────

async function embedBatch(texts, attempt = 0) {
  const res = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${voyageApiKey}`,
    },
    body: JSON.stringify({ input: texts, model: NEW_MODEL }),
  });

  if (res.status === 429) {
    const delay = Math.pow(2, attempt + 1) * 1000;
    console.warn(`\n  Rate limited, retrying in ${delay}ms...`);
    await sleep(delay);
    return embedBatch(texts, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`VoyageAI ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function progressBar(done, total, width = 45) {
  const pct = total ? done / total : 0;
  const filled = Math.round(pct * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `[${bar}] ${done}/${total} (${(pct * 100).toFixed(1)}%)`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Rebuild legal_sections → ${NEW_MODEL} ===`);
  console.log(`    Qdrant: ${qdrantUrl}`);
  console.log(`    DB:     ${dbUrl.replace(/:\/\/[^@]+@/, '://***@')}\n`);

  // 1. Count total sections to process
  const typePlaceholders = SECTION_TYPES.map((_, i) => `$${i + 1}`).join(',');
  const countRes = await pool.query(
    `SELECT COUNT(*) FROM document_sections ds
     JOIN documents d ON ds.document_id = d.id
     WHERE ds.section_type IN (${typePlaceholders})
       AND ds.text IS NOT NULL AND LENGTH(TRIM(ds.text)) > 10`,
    SECTION_TYPES
  );
  const total = parseInt(countRes.rows[0].count, 10);
  console.log(`Sections to embed: ${total} (types: ${SECTION_TYPES.join(', ')})`);

  // 2. Ensure collection exists and is empty
  const { collections } = await qdrant.getCollections();
  if (collections.some((c) => c.name === COLLECTION_NAME)) {
    console.log(`Deleting existing collection "${COLLECTION_NAME}"...`);
    await qdrant.deleteCollection(COLLECTION_NAME);
  }
  console.log(`Creating collection with ${EMBEDDING_DIMENSION}-dim Cosine vectors...`);
  await qdrant.createCollection(COLLECTION_NAME, {
    vectors: { size: EMBEDDING_DIMENSION, distance: 'Cosine' },
  });

  // 3. Stream sections from PG in pages, embed, store
  let offset = 0;
  let done = 0;
  let errors = 0;
  const startTime = Date.now();

  console.log(`\nEmbedding in batches of ${EMBED_BATCH_SIZE} (VoyageAI) / pages of ${PG_FETCH_SIZE} (PG)...\n`);

  while (offset < total) {
    // Fetch a page of sections from PG
    const rows = await pool.query(
      `SELECT
         ds.id            AS section_id,
         ds.document_id   AS doc_id,
         ds.section_type,
         ds.text,
         d.date::text     AS date,
         d.court,
         d.case_number,
         d.chamber,
         d.dispute_category,
         d.outcome,
         d.deviation_flag,
         d.matter_id,
         d.metadata->>'precedent_status'  AS precedent_status,
         d.metadata->'law_articles'       AS law_articles_json
       FROM document_sections ds
       JOIN documents d ON ds.document_id = d.id
       WHERE ds.section_type IN (${typePlaceholders})
         AND ds.text IS NOT NULL AND LENGTH(TRIM(ds.text)) > 10
       ORDER BY d.date DESC NULLS LAST, ds.id
       LIMIT $${SECTION_TYPES.length + 1} OFFSET $${SECTION_TYPES.length + 2}`,
      [...SECTION_TYPES, PG_FETCH_SIZE, offset]
    );

    if (rows.rows.length === 0) break;

    // Process this page in embed-batches
    for (let i = 0; i < rows.rows.length; i += EMBED_BATCH_SIZE) {
      const batch = rows.rows.slice(i, i + EMBED_BATCH_SIZE);
      const texts = batch.map((r) => r.text);

      try {
        const embeddings = await embedBatch(texts);

        const points = batch.map((r, idx) => {
          let lawArticles = [];
          try {
            const la = r.law_articles_json;
            if (Array.isArray(la)) lawArticles = la;
            else if (typeof la === 'string') lawArticles = JSON.parse(la);
          } catch { /* ignore */ }

          const payload = {
            doc_id: r.doc_id,
            section_type: r.section_type,
            text: r.text,
            date: r.date || null,
            court: r.court || null,
            case_number: r.case_number || null,
            chamber: r.chamber || null,
            dispute_category: r.dispute_category || null,
            outcome: r.outcome || null,
            deviation_flag: r.deviation_flag ?? null,
            precedent_status: r.precedent_status || null,
            law_articles: lawArticles,
          };
          if (r.matter_id) payload.matter_id = r.matter_id;

          return { id: uuidv4(), vector: embeddings[idx], payload };
        });

        await qdrant.upsert(COLLECTION_NAME, { wait: true, points });
        done += batch.length;

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const rate = done / ((Date.now() - startTime) / 1000);
        const eta = total > done ? Math.round((total - done) / rate) : 0;
        process.stdout.write(
          `\r  ${progressBar(done, total)}  ${elapsed}s elapsed, ETA ~${eta}s  `
        );

        if (i + EMBED_BATCH_SIZE < rows.rows.length) {
          await sleep(RATE_LIMIT_DELAY);
        }
      } catch (err) {
        errors++;
        console.error(`\n  ERROR embedding batch at offset ${offset + i}: ${err.message}`);
        await sleep(2000); // back off on error
      }
    }

    offset += rows.rows.length;
  }

  await pool.end();

  // 4. Final report
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const info = await qdrant.getCollection(COLLECTION_NAME);
  const finalCount = info.points_count ?? '?';

  process.stdout.write('\n');
  console.log(`\n✓ Done in ${elapsed}s`);
  console.log(`  Model:   ${NEW_MODEL}`);
  console.log(`  Points:  ${finalCount} stored in "${COLLECTION_NAME}"`);
  console.log(`  Errors:  ${errors} batches failed`);
  if (errors > 0) console.warn('  WARNING: Some batches failed — re-run script to fill gaps (upsert is idempotent once points have IDs from PG)');
}

main().catch((err) => {
  console.error('\nFATAL:', err.message);
  pool.end();
  process.exit(1);
});
