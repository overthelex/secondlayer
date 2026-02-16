#!/usr/bin/env node
/**
 * Re-embed all vectors in Qdrant legal_sections collection
 * using text-embedding-3-small model.
 *
 * Usage: OPENAI_API_KEY=... QDRANT_URL=... node scripts/reembed-qdrant.js
 */

const { QdrantClient } = require('@qdrant/js-client-rest');
const OpenAI = require('openai');

const COLLECTION = 'legal_sections';
const MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 100; // points per scroll
const EMBED_BATCH = 50; // texts per embedding API call
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY is required');
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey });
  const qdrant = new QdrantClient({ url: QDRANT_URL });

  // Get collection info
  const info = await qdrant.getCollection(COLLECTION);
  const totalPoints = info.points_count;
  console.log(`Collection: ${COLLECTION}, points: ${totalPoints}, model: ${MODEL}`);
  console.log(`Qdrant: ${QDRANT_URL}`);

  let offset = null;
  let processed = 0;
  let totalTokens = 0;
  const startTime = Date.now();

  while (true) {
    // Scroll batch of points
    const scrollResult = await qdrant.scroll(COLLECTION, {
      limit: BATCH_SIZE,
      offset: offset,
      with_payload: true,
      with_vector: false,
    });

    const points = scrollResult.points;
    if (points.length === 0) break;

    // Extract texts
    const texts = points.map(p => p.payload.text || '');

    // Generate embeddings in sub-batches
    const allEmbeddings = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      const resp = await openai.embeddings.create({
        model: MODEL,
        input: batch,
      });
      totalTokens += resp.usage?.total_tokens || 0;
      for (const item of resp.data) {
        allEmbeddings.push(item.embedding);
      }
    }

    // Upsert back with new vectors, same payload
    const upsertPoints = points.map((p, idx) => ({
      id: p.id,
      vector: allEmbeddings[idx],
      payload: p.payload,
    }));

    await qdrant.upsert(COLLECTION, {
      wait: true,
      points: upsertPoints,
    });

    processed += points.length;
    offset = scrollResult.next_page_offset;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const pct = ((processed / totalPoints) * 100).toFixed(1);
    const cost = (totalTokens / 1_000_000 * 0.02).toFixed(4);
    process.stdout.write(`\r  ${processed}/${totalPoints} (${pct}%) | ${totalTokens} tokens | $${cost} | ${elapsed}s`);

    if (!offset) break;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const cost = (totalTokens / 1_000_000 * 0.02).toFixed(4);
  console.log(`\n\nDone! ${processed} points re-embedded in ${elapsed}s`);
  console.log(`Total tokens: ${totalTokens}, cost: $${cost}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
