#!/usr/bin/env node
/**
 * Load legislation needed for TCC (ТЦК) disputes into the database.
 *
 * Laws loaded:
 *  1. КУпАП — Кодекс про адміністративні правопорушення (80731-10)
 *     Key articles: 210, 210-1, 211
 *  2. Закон «Про військовий обов'язок і військову службу» (2232-12)
 *  3. Закон «Про мобілізаційну підготовку та мобілізацію» (3543-12)
 *
 * Run on stage (inside app container):
 *   docker exec -it mcp-backend-app-stage node scripts/load-tck-legislation.js
 *   docker exec -it mcp-backend-app-stage node scripts/load-tck-legislation.js --skip-vectors
 *
 * Run locally:
 *   DATABASE_URL=postgresql://secondlayer:pass@localhost:5432/secondlayer_local \
 *     node scripts/load-tck-legislation.js --skip-vectors
 *
 * Env vars used: DATABASE_URL, POSTGRES_*, OPENAI_API_KEY, QDRANT_URL
 */

import pg from 'pg';
import axios from 'axios';
import * as cheerio from 'cheerio';

const { Pool } = pg;

// ─── Configuration ───────────────────────────────────────────────
const LAWS = [
  {
    rada_id: '80731-10',
    short: 'КУпАП',
    title: 'Кодекс України про адміністративні правопорушення',
    type: 'code',
    key_articles: ['210', '210-1', '211'],
  },
  {
    rada_id: '2232-12',
    short: 'Про військовий обов\'язок',
    title: 'Закон України «Про військовий обов\'язок і військову службу»',
    type: 'law',
    key_articles: [],
  },
  {
    rada_id: '3543-12',
    short: 'Про мобілізацію',
    title: 'Закон України «Про мобілізаційну підготовку та мобілізацію»',
    type: 'law',
    key_articles: [],
  },
];

const BASE_URL = 'https://zakon.rada.gov.ua';

const skipVectors = process.argv.includes('--skip-vectors');
const explicitIds = process.argv.slice(2).filter(a => !a.startsWith('--'));

// Build DATABASE_URL from individual vars or use the env directly
const DATABASE_URL = process.env.DATABASE_URL ||
  `postgresql://${process.env.POSTGRES_USER || 'secondlayer'}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || '5432'}/${process.env.POSTGRES_DB || 'secondlayer_stage'}`;

const pool = new Pool({ connectionString: DATABASE_URL });

const httpClient = axios.create({
  timeout: 60000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; SecondLayer/1.0)',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'uk,en;q=0.9',
  },
  decompress: true,
});

// ─── HTML Parsing (self-contained, no backend import needed) ─────
function parseArticlesFromHtml(html, radaId) {
  const $ = cheerio.load(html);
  const articles = [];

  // Extract title
  const titleEl = $('.title, .doc-title, h1').first();
  const title = titleEl.text().trim();

  // Parse articles from /print format: <span class=rvts9>Стаття N.</span>
  const bodyHtml = $('body').html() || '';
  const articleRegex = /<span\s+class=["']?rvts9["']?>Стаття\s+(\d+(?:-\d+)?)\.?\s*<\/span>\s*(.*?)(?=<span\s+class=["']?rvts9|$)/gs;

  let match;
  while ((match = articleRegex.exec(bodyHtml)) !== null) {
    const articleNumber = match[1];
    const articleHtml = match[2];

    const $a = cheerio.load(`<div>${articleHtml}</div>`);
    $a('script, style, em').remove();
    const fullText = $a.text().trim().replace(/\s+/g, ' ').replace(/\{[^}]+\}/g, '').trim();

    if (fullText.length < 10) continue;

    let articleTitle;
    const firstSentence = fullText.split(/[.;]/)[0];
    if (firstSentence && firstSentence.length < 200) {
      articleTitle = firstSentence.trim();
    }

    articles.push({
      article_number: articleNumber,
      title: articleTitle,
      full_text: fullText,
      full_text_html: articleHtml.substring(0, 10000),
      byte_size: Buffer.byteLength(fullText, 'utf8'),
    });
  }

  // Fallback: plain text regex
  if (articles.length === 0) {
    console.log('  Using fallback parser...');
    const bodyText = $('body').text();
    const pattern = /Стаття\s+(\d+(?:-\d+)?)\.\s*/gi;
    const matches = [...bodyText.matchAll(pattern)];

    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const articleNumber = m[1];
      const start = m.index;
      const end = i + 1 < matches.length ? matches[i + 1].index : bodyText.length;
      const fullText = bodyText.substring(start, end).trim().replace(/\s+/g, ' ');

      if (fullText.length < 20) continue;

      const firstSentence = fullText.replace(/^Стаття\s+\d+(?:-\d+)?\.\s*/, '').split(/[.;]/)[0];

      articles.push({
        article_number: articleNumber,
        title: firstSentence?.length < 200 ? firstSentence.trim() : undefined,
        full_text: fullText,
        byte_size: Buffer.byteLength(fullText, 'utf8'),
      });
    }
  }

  return { title, articles };
}

// ─── Database Operations ─────────────────────────────────────────
async function checkExisting(radaId) {
  const res = await pool.query(
    `SELECT l.id, l.title, l.total_articles,
            (SELECT COUNT(*) FROM legislation_articles la WHERE la.legislation_id = l.id AND la.is_current = true) as articles_count,
            (SELECT COUNT(*) FROM legislation_chunks lc WHERE lc.legislation_id = l.id) as chunks_count
     FROM legislation l WHERE l.rada_id = $1`,
    [radaId]
  );
  return res.rows[0] || null;
}

async function saveLegislation(law, parsedTitle, articles) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const legResult = await client.query(
      `INSERT INTO legislation (rada_id, type, title, short_title, full_url, status, total_articles, structure_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (rada_id) DO UPDATE SET
         title = EXCLUDED.title,
         short_title = EXCLUDED.short_title,
         total_articles = EXCLUDED.total_articles,
         updated_at = NOW()
       RETURNING id`,
      [
        law.rada_id,
        law.type,
        parsedTitle || law.title,
        law.short,
        `${BASE_URL}/laws/show/${law.rada_id}/print`,
        'active',
        articles.length,
        {},
      ]
    );

    const legislationId = legResult.rows[0].id;
    let saved = 0;

    for (const article of articles) {
      await client.query(
        `INSERT INTO legislation_articles
         (legislation_id, article_number, title, full_text, full_text_html, is_current, byte_size, version_date, metadata)
         VALUES ($1, $2, $3, $4, $5, true, $6, NOW(), $7)
         ON CONFLICT (legislation_id, article_number, version_date) DO UPDATE SET
           full_text = EXCLUDED.full_text,
           full_text_html = EXCLUDED.full_text_html,
           byte_size = EXCLUDED.byte_size,
           title = EXCLUDED.title,
           updated_at = NOW()`,
        [
          legislationId,
          article.article_number,
          article.title,
          article.full_text,
          article.full_text_html || null,
          article.byte_size,
          { rada_id: law.rada_id, extraction_date: new Date().toISOString() },
        ]
      );
      saved++;
    }

    await client.query('COMMIT');
    return { legislationId, saved };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Vector Indexing (optional, needs built backend) ─────────────
async function indexVectors(radaId) {
  const { LegislationService } = await import('../mcp_backend/dist/services/legislation-service.js');
  const { EmbeddingService } = await import('../mcp_backend/dist/services/embedding-service.js');

  const embeddingService = new EmbeddingService();
  const service = new LegislationService(pool, embeddingService);
  await service.indexArticlesForVectorSearch(radaId);
}

// ─── Main ────────────────────────────────────────────────────────
async function loadLaw(law) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${law.short} (${law.rada_id})`);
  console.log(`  ${law.title}`);
  console.log('='.repeat(60));

  // Check existing
  const existing = await checkExisting(law.rada_id);
  if (existing && Number(existing.articles_count) > 0) {
    console.log(`  Already loaded: ${existing.articles_count} articles, ${existing.chunks_count} chunks`);
    if (Number(existing.chunks_count) === 0 && !skipVectors) {
      console.log('  No vector chunks — indexing...');
    } else {
      if (law.key_articles.length > 0) {
        await showKeyArticles(law.rada_id, law.key_articles);
      }
      return { status: 'exists', articles: Number(existing.articles_count), chunks: Number(existing.chunks_count) };
    }
  }

  // Fetch & parse
  if (!existing || Number(existing.articles_count) === 0) {
    const url = `${BASE_URL}/laws/show/${law.rada_id}/print`;
    console.log(`  Fetching ${url} ...`);
    const start = Date.now();

    try {
      const resp = await httpClient.get(url);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const { title: parsedTitle, articles } = parseArticlesFromHtml(resp.data, law.rada_id);
      console.log(`  Parsed ${articles.length} articles in ${elapsed}s`);

      if (articles.length === 0) {
        console.log('  WARNING: No articles parsed! HTML format may have changed.');
        return { status: 'error', articles: 0, chunks: 0 };
      }

      console.log('  Saving to database...');
      const { legislationId, saved } = await saveLegislation(law, parsedTitle, articles);
      console.log(`  Saved: legislation_id=${legislationId}, ${saved} articles`);
    } catch (err) {
      console.error(`  ERROR fetching ${law.rada_id}:`, err.message);
      return { status: 'error', articles: 0, chunks: 0 };
    }
  }

  // Vector indexing
  if (!skipVectors) {
    try {
      console.log('  Indexing vectors (may take a while)...');
      const start = Date.now();
      await indexVectors(law.rada_id);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`  Vector indexing done in ${elapsed}s`);
    } catch (err) {
      console.error(`  Vector indexing failed (articles still saved):`, err.message);
    }
  }

  // Show key articles
  if (law.key_articles.length > 0) {
    await showKeyArticles(law.rada_id, law.key_articles);
  }

  const after = await checkExisting(law.rada_id);
  return {
    status: 'loaded',
    articles: Number(after?.articles_count || 0),
    chunks: Number(after?.chunks_count || 0),
  };
}

async function showKeyArticles(radaId, articleNumbers) {
  console.log('  Key articles for TCC disputes:');
  for (const num of articleNumbers) {
    const res = await pool.query(
      `SELECT article_number, title, byte_size
       FROM legislation_articles la JOIN legislation l ON la.legislation_id = l.id
       WHERE l.rada_id = $1 AND la.article_number = $2 AND la.is_current = true`,
      [radaId, num]
    );
    if (res.rows[0]) {
      const a = res.rows[0];
      console.log(`    st. ${a.article_number}: ${a.title || '(no title)'} [${a.byte_size} bytes]`);
    } else {
      console.log(`    st. ${num}: NOT FOUND in parsed articles`);
    }
  }
}

async function main() {
  console.log('Loading TCC dispute legislation');
  console.log(`  Vectors: ${skipVectors ? 'SKIP' : 'enabled'}`);
  console.log(`  DB: ${DATABASE_URL.replace(/:[^@]+@/, ':***@')}`);

  const lawsToLoad = explicitIds.length > 0
    ? LAWS.filter(l => explicitIds.includes(l.rada_id))
    : LAWS;

  if (lawsToLoad.length === 0) {
    console.error(`No matching laws for: ${explicitIds.join(', ')}`);
    console.error(`Available: ${LAWS.map(l => `${l.rada_id} (${l.short})`).join(', ')}`);
    process.exit(1);
  }

  const results = [];
  for (const law of lawsToLoad) {
    results.push({ ...law, ...(await loadLaw(law)) });
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Summary:');
  console.log('='.repeat(60));
  for (const r of results) {
    const icon = r.status === 'error' ? 'FAIL' : 'OK';
    console.log(`  [${icon}] ${r.short.padEnd(25)} ${String(r.articles || 0).padStart(5)} articles  ${String(r.chunks || 0).padStart(6)} chunks`);
  }
  const total = results.reduce((s, r) => s + (r.articles || 0), 0);
  console.log(`\n  Total: ${total} articles`);
}

main()
  .catch(err => console.error('Fatal:', err))
  .finally(() => pool.end().then(() => process.exit(0)));
