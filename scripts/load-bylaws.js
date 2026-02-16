#!/usr/bin/env node
/**
 * Load key bylaws (підзаконні акти) for TCC/military disputes.
 *
 * Documents loaded:
 *  1. ПКМ №154 від 23.02.2022 — Положення про ТЦК (154-2022-п)
 *  2. ПКМ №560 від 16.05.2024 — Порядок призову під час мобілізації (560-2024-п)
 *  3. ПКМ №1487 від 30.12.2022 — Порядок військового обліку (1487-2022-п)
 *  4. Наказ МОУ №402 від 14.08.2008 — Положення про ВЛК (z1109-08)
 *
 * Run on stage (inside app container):
 *   docker exec -w /app/mcp_backend secondlayer-app-stage node ../scripts/load-bylaws.js --skip-vectors
 *
 * Env vars used: DATABASE_URL, POSTGRES_*, OPENAI_API_KEY, QDRANT_URL
 */

const { Pool } = require('pg');
const axios = require('axios');
const cheerio = require('cheerio');

// ─── Configuration ───────────────────────────────────────────────
const BYLAWS = [
  {
    rada_id: '154-2022-\u043F',
    short: 'Положення про ТЦК',
    title: 'Положення про територіальні центри комплектування та соціальної підтримки',
    type: 'regulation',
    issuer: 'КМУ',
    number: '154',
    date: '2022-02-23',
  },
  {
    rada_id: '560-2024-\u043F',
    short: 'Порядок призову (мобілізація)',
    title: 'Питання проведення призову громадян на військову службу під час мобілізації, на особливий період',
    type: 'regulation',
    issuer: 'КМУ',
    number: '560',
    date: '2024-05-16',
  },
  {
    rada_id: '1487-2022-\u043F',
    short: 'Порядок військового обліку',
    title: 'Порядок організації та ведення військового обліку призовників, військовозобов\'язаних та резервістів',
    type: 'regulation',
    issuer: 'КМУ',
    number: '1487',
    date: '2022-12-30',
  },
  {
    rada_id: 'z1109-08',
    short: 'Положення про ВЛК',
    title: 'Положення про військово-лікарську експертизу в Збройних Силах України',
    type: 'order',
    issuer: 'Міноборони',
    number: '402',
    date: '2008-08-14',
  },
];

const BASE_URL = 'https://zakon.rada.gov.ua';

const skipVectors = process.argv.includes('--skip-vectors');
const explicitIds = process.argv.slice(2).filter(a => !a.startsWith('--'));

const DATABASE_URL = process.env.DATABASE_URL ||
  `postgresql://${process.env.POSTGRES_USER || 'secondlayer'}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || '5432'}/${process.env.POSTGRES_DB || 'secondlayer_stage'}`;

const pool = new Pool({ connectionString: DATABASE_URL });

const httpClient = axios.create({
  timeout: 120000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; SecondLayer/1.0)',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'uk,en;q=0.9',
  },
  decompress: true,
});

// ─── HTML Parsing for bylaws (пункт-based, not стаття-based) ────
function parseParagraphsFromHtml(html) {
  const $ = cheerio.load(html);

  const ogTitle = $('meta[property="og:title"]').attr('content') || '';
  const titleEl = $('title').text().split('|')[0].trim();
  const title = ogTitle || titleEl;

  $('script, style').remove();

  const bodyText = $('body').text();
  const rawLines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Find where the regulation body starts
  let startIdx = 0;
  for (let i = 0; i < rawLines.length; i++) {
    if (/^(ПОЛОЖЕННЯ|ПОРЯДОК|Загальні питання|Загальна частина|I\.\s|1\.)/i.test(rawLines[i])) {
      startIdx = i;
      break;
    }
  }

  const fullBody = rawLines.slice(startIdx).join('\n');

  // Parse numbered paragraphs (пункти): "1.", "2.", "1-1." etc.
  const paragraphs = [];
  const pRegex = /(?:^|\n)\s*(\d+(?:-\d+)?)\.\s+/g;
  const matches = [...fullBody.matchAll(pRegex)];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const paraNum = m[1];
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : fullBody.length;

    let text = fullBody.substring(start, end).trim();
    text = text.replace(/\{[^}]*\}/g, '').trim();
    text = text.replace(/\s+/g, ' ').trim();

    if (text.length < 10) continue;

    let paraTitle;
    const firstSentence = text.split(/[.;]/)[0];
    if (firstSentence && firstSentence.length < 250) {
      paraTitle = firstSentence.trim();
    }

    paragraphs.push({
      article_number: paraNum,
      title: paraTitle,
      full_text: paraNum + '. ' + text,
      byte_size: Buffer.byteLength(text, 'utf8'),
    });
  }

  // Parse sections
  const sections = [];
  const sectionRegex = /(?:^|\n)\s*(Розділ\s+[IVXLCDM]+[.\s]+[^\n]+)/gi;
  const sectionMatches = [...fullBody.matchAll(sectionRegex)];
  for (const sm of sectionMatches) {
    sections.push(sm[1].trim());
  }

  return { title, paragraphs, sections };
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

async function saveBylaw(bylaw, parsedTitle, paragraphs) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const legResult = await client.query(
      `INSERT INTO legislation (rada_id, type, title, short_title, full_url, adoption_date, status, total_articles, structure_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (rada_id) DO UPDATE SET
         title = EXCLUDED.title,
         short_title = EXCLUDED.short_title,
         total_articles = EXCLUDED.total_articles,
         structure_metadata = EXCLUDED.structure_metadata,
         updated_at = NOW()
       RETURNING id`,
      [
        bylaw.rada_id,
        bylaw.type,
        parsedTitle || bylaw.title,
        bylaw.short,
        BASE_URL + '/laws/show/' + bylaw.rada_id + '/print',
        bylaw.date,
        'active',
        paragraphs.length,
        JSON.stringify({ issuer: bylaw.issuer, number: bylaw.number, unit: 'пункт' }),
      ]
    );

    const legislationId = legResult.rows[0].id;
    let saved = 0;

    for (const para of paragraphs) {
      await client.query(
        `INSERT INTO legislation_articles
         (legislation_id, article_number, title, full_text, is_current, byte_size, version_date, metadata)
         VALUES ($1, $2, $3, $4, true, $5, NOW(), $6)
         ON CONFLICT (legislation_id, article_number, version_date) DO UPDATE SET
           full_text = EXCLUDED.full_text,
           byte_size = EXCLUDED.byte_size,
           title = EXCLUDED.title,
           updated_at = NOW()`,
        [
          legislationId,
          para.article_number,
          para.title,
          para.full_text,
          para.byte_size,
          JSON.stringify({ rada_id: bylaw.rada_id, unit: 'пункт', extraction_date: new Date().toISOString() }),
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

// ─── Main ────────────────────────────────────────────────────────
async function loadBylaw(bylaw) {
  console.log('\n' + '='.repeat(60));
  console.log('  ' + bylaw.short + ' (' + bylaw.rada_id + ')');
  console.log('  ' + bylaw.title);
  console.log('  ' + bylaw.issuer + ' №' + bylaw.number + ' від ' + bylaw.date);
  console.log('='.repeat(60));

  const existing = await checkExisting(bylaw.rada_id);
  if (existing && Number(existing.articles_count) > 0) {
    console.log('  Already loaded: ' + existing.articles_count + ' paragraphs, ' + existing.chunks_count + ' chunks');
    if (Number(existing.chunks_count) === 0 && !skipVectors) {
      console.log('  No vector chunks — will index...');
    } else {
      return { status: 'exists', paragraphs: Number(existing.articles_count), chunks: Number(existing.chunks_count) };
    }
  }

  if (!existing || Number(existing.articles_count) === 0) {
    const url = BASE_URL + '/laws/show/' + encodeURIComponent(bylaw.rada_id) + '/print';
    console.log('  Fetching ' + url + ' ...');
    const start = Date.now();

    try {
      const resp = await httpClient.get(url);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const { title: parsedTitle, paragraphs, sections } = parseParagraphsFromHtml(resp.data);
      console.log('  Parsed ' + paragraphs.length + ' paragraphs in ' + elapsed + 's');
      if (sections.length > 0) {
        console.log('  Sections: ' + sections.length + ' (' + sections.slice(0, 3).join(', ') + (sections.length > 3 ? '...' : '') + ')');
      }

      if (paragraphs.length === 0) {
        console.log('  WARNING: No paragraphs parsed!');
        return { status: 'error', paragraphs: 0, chunks: 0 };
      }

      const sample = paragraphs[0];
      console.log('  Sample p.' + sample.article_number + ': ' + (sample.title || '').substring(0, 80) + '...');

      console.log('  Saving to database...');
      const { legislationId, saved } = await saveBylaw(bylaw, parsedTitle, paragraphs);
      console.log('  Saved: legislation_id=' + legislationId + ', ' + saved + ' paragraphs');
    } catch (err) {
      console.error('  ERROR fetching ' + bylaw.rada_id + ':', err.message);
      return { status: 'error', paragraphs: 0, chunks: 0 };
    }
  }

  if (!skipVectors) {
    try {
      console.log('  Indexing vectors...');
      const start = Date.now();
      const { LegislationService } = require('../mcp_backend/dist/services/legislation-service.js');
      const { EmbeddingService } = require('../mcp_backend/dist/services/embedding-service.js');
      const embeddingService = new EmbeddingService();
      const service = new LegislationService(pool, embeddingService);
      await service.indexArticlesForVectorSearch(bylaw.rada_id);
      console.log('  Vector indexing done in ' + ((Date.now() - start) / 1000).toFixed(1) + 's');
    } catch (err) {
      console.error('  Vector indexing failed:', err.message);
    }
  }

  const after = await checkExisting(bylaw.rada_id);
  return {
    status: 'loaded',
    paragraphs: Number(after?.articles_count || 0),
    chunks: Number(after?.chunks_count || 0),
  };
}

async function main() {
  console.log('Loading bylaws for TCC/military disputes');
  console.log('  Vectors: ' + (skipVectors ? 'SKIP' : 'enabled'));
  console.log('  DB: ' + DATABASE_URL.replace(/:[^@]+@/, ':***@'));

  const bylawsToLoad = explicitIds.length > 0
    ? BYLAWS.filter(b => explicitIds.includes(b.rada_id))
    : BYLAWS;

  if (bylawsToLoad.length === 0) {
    console.error('No matching bylaws for: ' + explicitIds.join(', '));
    console.error('Available: ' + BYLAWS.map(b => b.rada_id + ' (' + b.short + ')').join(', '));
    process.exit(1);
  }

  const results = [];
  for (const bylaw of bylawsToLoad) {
    results.push(Object.assign({}, bylaw, await loadBylaw(bylaw)));
  }

  console.log('\n' + '='.repeat(60));
  console.log('Summary:');
  console.log('='.repeat(60));
  for (const r of results) {
    const icon = r.status === 'error' ? 'FAIL' : 'OK';
    console.log('  [' + icon + '] ' + r.short.padEnd(30) + ' ' + String(r.paragraphs || 0).padStart(5) + ' paragraphs  ' + String(r.chunks || 0).padStart(6) + ' chunks');
  }
  const total = results.reduce((s, r) => s + (r.paragraphs || 0), 0);
  console.log('\n  Total: ' + total + ' paragraphs');
}

main()
  .catch(err => console.error('Fatal:', err))
  .finally(() => pool.end().then(() => process.exit(0)));
