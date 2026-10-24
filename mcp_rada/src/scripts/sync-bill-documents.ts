/**
 * Sync bill documents (супровідні документи законопроектів) into rada.bill_documents.
 *
 * Pulls the FULL Rada bill-info dataset (with documents + passings) — which our normal
 * bill sync does NOT fetch — and stores every workflow/source document per bill:
 * ГНЕУ conclusions (kind_id=100 «Науково-експертний висновок»), committee conclusions,
 * budget / EU-integration / anti-corruption / linguistic expert reviews, ГЮУ remarks, etc.
 *
 * The verdict summary (short_review / formal_review) and the PDF links live directly in the
 * JSON, so this pass needs NO per-document requests. Extracting PDF full text is a later phase.
 *
 * Usage:
 *   npm run sync:bill-documents            # convocation 9 (default)
 *   CONVOCATIONS=9,8 npm run sync:bill-documents
 *   node --max-old-space-size=4096 dist/scripts/sync-bill-documents.js 9
 *
 * Env:
 *   DATABASE_URL or POSTGRES_HOST/PORT/USER/PASSWORD/DB
 *   CONVOCATIONS   comma-separated skl numbers (overrides argv), default "9"
 */

import { Pool } from 'pg';
import { fetchBillFeed, extractInitiators as extractInitiatorList, nz } from '../services/bill-feed';

const BATCH_SIZE = 200;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  user: process.env.POSTGRES_USER || 'rada_mcp',
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB || 'secondlayer_prod',
  options: '-c search_path=rada',
  max: 5,
});

// ── Helpers ─────────────────────────────────────────────────────────────────
// The legacy feeds contain source-typo dates (year 0006, 3013, …). Drop anything whose
// year is outside a sane window so they don't pollute registration_date / its index.
const MAX_DATE_YEAR = new Date().getFullYear() + 2;
function nzDate(v: any): any {
  const s = nz(v);
  if (s === null) return null;
  const year = parseInt(String(s).slice(0, 4), 10);
  if (Number.isNaN(year) || year < 1990 || year > MAX_DATE_YEAR) return null;
  return s;
}

// Initiators as a readable "; "-joined name list plus the deputy person-ids
// (for linking to rada.deputies). See bill-feed.ts for the per-feed shapes.
function extractInitiators(bill: any): { names: string | null; ids: number[] } {
  const { names, ids } = extractInitiatorList(bill);
  return { names: names.length ? names.join('; ') : null, ids };
}

// Map one workflow/source document to a bill_documents row (array in column order).
function toRow(doc: any, bill: any, conv: number, group: 'workflow' | 'source'): any[] {
  const files = Array.isArray(doc.docFiles) ? doc.docFiles : [];
  const f0 = files[0] || {};
  const bi = extractInitiators(bill);
  return [
    doc.id, // doc_id (PK)
    bill.id, // rada_bill_id
    nz(bill.registrationNumber), // bill_number
    conv, // convocation
    group, // doc_group
    nz(doc.kindId), // kind_id
    nz(doc.kind), // kind
    nz(doc.registrationNum), // registration_num
    nzDate(doc.registrationDate), // registration_date
    nz(doc.outcomingNum), // outcoming_num
    nzDate(doc.outcomingDate), // outcoming_date
    nzDate(doc.publishDate), // publish_date
    nzDate(doc.meetingDate), // meeting_date
    nz(doc.short_review), // short_review
    nz(doc.formal_review), // formal_review
    nz(doc.mainSpeaker), // main_speaker
    nz(f0.url), // file_url
    nz(f0.archiveWithSignsUrl), // file_zip_url
    files.length ? JSON.stringify(files) : null, // doc_files
    JSON.stringify(doc), // raw
    nz(bill.title || bill.name), // bill_title (modern feed uses `name`)
    nz(bill.subject), // bill_subject
    bi.names, // bill_initiators
    bi.ids.length ? bi.ids : null, // bill_initiator_ids
  ];
}

// Legacy `bills-sklN.json`: each doc is {date, type, uri}. The document id lives in the
// uri's pf35401 param; there is no kindId / verdict / direct PDF.
function toOldRow(id: number, doc: any, bill: any, conv: number, group: 'workflow' | 'source'): any[] {
  const bi = extractInitiators(bill);
  return [
    id, // doc_id (PK) — pf35401 from uri
    bill.id, // rada_bill_id
    nz(bill.number || bill.registrationNumber), // bill_number
    conv, // convocation
    group, // doc_group
    null, // kind_id (legacy has none)
    nz(doc.type), // kind — the document type name
    null, // registration_num
    nzDate(doc.date), // registration_date
    null, // outcoming_num
    null, // outcoming_date
    null, // publish_date
    null, // meeting_date
    null, // short_review (legacy has no verdict summary)
    null, // formal_review
    null, // main_speaker
    nz(doc.uri), // file_url — legacy webproc34 portal link
    null, // file_zip_url
    null, // doc_files
    JSON.stringify(doc), // raw
    nz(bill.title || bill.name), // bill_title
    nz(bill.subject), // bill_subject
    bi.names, // bill_initiators
    bi.ids.length ? bi.ids : null, // bill_initiator_ids
  ];
}

const COLS = [
  'doc_id', 'rada_bill_id', 'bill_number', 'convocation', 'doc_group', 'kind_id', 'kind',
  'registration_num', 'registration_date', 'outcoming_num', 'outcoming_date', 'publish_date',
  'meeting_date', 'short_review', 'formal_review', 'main_speaker', 'file_url', 'file_zip_url',
  'doc_files', 'raw', 'bill_title', 'bill_subject', 'bill_initiators', 'bill_initiator_ids',
];

async function upsertBatch(rows: any[][]): Promise<number> {
  if (rows.length === 0) return 0;
  const values: any[] = [];
  const tuples: string[] = [];
  let i = 1;
  for (const r of rows) {
    tuples.push(`(${r.map(() => `$${i++}`).join(',')})`);
    values.push(...r);
  }
  const updates = COLS.filter((c) => c !== 'doc_id')
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ');
  const sql = `
    INSERT INTO rada.bill_documents (${COLS.join(', ')})
    VALUES ${tuples.join(',')}
    ON CONFLICT (doc_id, convocation) DO UPDATE SET ${updates}, updated_at = now()
  `;
  const res = await pool.query(sql, values);
  return res.rowCount || 0;
}

async function syncConvocation(conv: number): Promise<{ docs: number; gneu: number }> {
  const { bills, modern } = await fetchBillFeed(conv);

  // A document id can appear more than once in the feed (same doc listed under both
  // `workflow` and `source`, or attached to more than one bill). Postgres rejects a
  // duplicate constrained value inside one ON CONFLICT statement, so dedupe by doc_id
  // up front. `workflow` is iterated first and wins — it carries the review verdict.
  const byId = new Map<number, any[]>();
  let gneu = 0;
  let skipped = 0;
  for (const bill of bills) {
    const docs = bill.documents || {};
    for (const group of ['workflow', 'source'] as const) {
      if (modern) {
        const arr = Array.isArray(docs[group]) ? docs[group] : [];
        for (const doc of arr) {
          if (doc?.id == null || byId.has(doc.id)) continue;
          if (doc.kindId === 100) gneu++;
          byId.set(doc.id, toRow(doc, bill, conv, group));
        }
      } else {
        // legacy: docs[group] = { document: [{date,type,uri}, …] }
        const grp = docs[group];
        const arr = grp && Array.isArray(grp.document) ? grp.document : [];
        for (const doc of arr) {
          if (!doc || typeof doc !== 'object') continue;
          const m = /pf35401=(\d+)/.exec(doc.uri || '');
          if (!m) { skipped++; continue; } // no stable doc id → skip (procedural docs)
          const id = parseInt(m[1], 10);
          if (byId.has(id)) continue;
          if ((doc.type || '').toLowerCase().includes('науково-експертн')) gneu++;
          byId.set(id, toOldRow(id, doc, bill, conv, group));
        }
      }
    }
  }
  if (skipped) console.log(`   (skipped ${skipped.toLocaleString()} legacy docs without a pf35401 id)`);

  const rows = [...byId.values()];
  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    total += await upsertBatch(rows.slice(i, i + BATCH_SIZE));
    if (i % (BATCH_SIZE * 20) === 0 && i > 0) {
      console.log(`   …${i.toLocaleString()}/${rows.length.toLocaleString()} docs upserted`);
    }
  }

  console.log(`✅ skl${conv}: ${total.toLocaleString()} documents upserted (${gneu.toLocaleString()} ГНЕУ conclusions)`);
  return { docs: total, gneu };
}

async function main(): Promise<void> {
  const convs = (process.env.CONVOCATIONS || process.argv[2] || '9')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🏛️  Rada Bill Documents Sync (ГНЕУ + супровідні документи)');
  console.log(`   Convocations: ${convs.join(', ')}`);
  console.log('═══════════════════════════════════════════════════════════════');

  try {
    await pool.query('SELECT 1');
    console.log('✅ Database connected');

    let docs = 0;
    let gneu = 0;
    for (const c of convs) {
      const r = await syncConvocation(c);
      docs += r.docs;
      gneu += r.gneu;
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(`🎉 Done: ${docs.toLocaleString()} documents (${gneu.toLocaleString()} ГНЕУ) across ${convs.length} convocation(s)`);
    console.log('═══════════════════════════════════════════════════════════════');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
