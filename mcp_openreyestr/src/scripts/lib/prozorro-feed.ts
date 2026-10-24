/**
 * Pure helpers for the ProZorro incremental importer (import-prozorro.ts).
 * Kept free of I/O so they can be unit-tested.
 *
 * Feed facts (measured 2026-10-24 against public-api.prozorro.gov.ua/api/2.5):
 * - GET /tenders?offset=<unix seconds>&limit=<=1000 lists {id, dateModified}
 *   ascending by dateModified; next_page.offset is an opaque cursor
 *   ("1736877368.104.1.<hash>") that resumes exactly after the last item.
 * - An ISO offset without a zone is read as UTC; a numeric unix offset is exact.
 * - opt_fields on the list cannot return title/value/items/awardCriteria, so
 *   every tender needs one GET /tenders/<id>. ~1s latency per call, no 429 up
 *   to 40 concurrent requests from one IP.
 */

export const TENDER_COLUMNS = [
  'tender_id',
  'tender_number',
  'title',
  'status',
  'procurement_method',
  'procurement_method_type',
  'buyer_name',
  'buyer_edrpou',
  'buyer_region',
  'amount',
  'currency',
  'cpv_code',
  'cpv_description',
  'date_created',
  'date_modified',
  'tender_start',
  'tender_end',
  'award_criteria',
] as const;

export type TenderColumn = (typeof TENDER_COLUMNS)[number];
export type TenderRecord = Record<TenderColumn, string | number | null>;

/** NUMERIC(15,2) holds < 1e13; anything larger is garbage input, store NULL. */
const MAX_AMOUNT = 1e13;

/**
 * Timestamps are kept as the API's local wall time (Europe/Kyiv): the column is
 * `timestamp without time zone`, and Postgres drops the "+02:00" suffix on
 * cast. The 1.03M rows imported before LEXAI-2089 follow that convention, so
 * the strings are passed through unchanged.
 */
export function extractTenderData(data: any): TenderRecord | null {
  if (!data || typeof data.id !== 'string' || !data.id) return null;

  const buyer = data.procuringEntity || {};
  const value = data.value || {};
  const firstItem = (Array.isArray(data.items) && data.items[0]) || {};
  const tenderPeriod = data.tenderPeriod || {};

  let amount: number | null = typeof value.amount === 'number' ? value.amount : null;
  if (amount !== null && (!Number.isFinite(amount) || Math.abs(amount) >= MAX_AMOUNT)) amount = null;

  return {
    tender_id: data.id,
    tender_number: data.tenderID || null,
    title: typeof data.title === 'string' ? data.title.substring(0, 1000) : null,
    status: data.status || null,
    procurement_method: data.procurementMethod || null,
    procurement_method_type: data.procurementMethodType || null,
    buyer_name: buyer.name || buyer.identifier?.legalName || null,
    buyer_edrpou: buyer.identifier?.id || null,
    buyer_region: buyer.address?.region || null,
    amount,
    currency: value.currency || 'UAH',
    cpv_code: firstItem.classification?.id || null,
    cpv_description: firstItem.classification?.description || null,
    date_created: data.dateCreated || null,
    date_modified: data.dateModified || null,
    tender_start: tenderPeriod.startDate ? String(tenderPeriod.startDate).substring(0, 10) : null,
    tender_end: tenderPeriod.endDate ? String(tenderPeriod.endDate).substring(0, 10) : null,
    award_criteria: data.awardCriteria || null,
  };
}

/**
 * One multi-row upsert keyed on tender_id. Never deletes. A row is only
 * overwritten by a version with the same or a newer date_modified, so a stale
 * replay (overlap window, rerun from an older cursor) cannot regress data.
 * Duplicate tender_ids inside one batch keep the newest version, otherwise
 * Postgres rejects the statement ("cannot affect row a second time").
 */
export function buildUpsert(records: TenderRecord[]): { text: string; values: unknown[] } | null {
  const byId = new Map<string, TenderRecord>();
  for (const r of records) {
    const id = String(r.tender_id);
    const prev = byId.get(id);
    if (!prev || String(r.date_modified ?? '') >= String(prev.date_modified ?? '')) byId.set(id, r);
  }
  const rows = [...byId.values()];
  if (rows.length === 0) return null;

  const values: unknown[] = [];
  const tuples = rows.map((r) => {
    const ph = TENDER_COLUMNS.map((c) => {
      values.push(r[c]);
      return `$${values.length}`;
    });
    return `(${ph.join(',')})`;
  });

  const updatable = TENDER_COLUMNS.filter((c) => c !== 'tender_id');
  const text =
    `INSERT INTO prozorro_tenders (${TENDER_COLUMNS.join(', ')}) VALUES ${tuples.join(',')}\n` +
    `ON CONFLICT (tender_id) DO UPDATE SET ${updatable.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, ` +
    `updated_at = CURRENT_TIMESTAMP\n` +
    `WHERE prozorro_tenders.date_modified IS NULL OR EXCLUDED.date_modified IS NULL ` +
    `OR EXCLUDED.date_modified >= prozorro_tenders.date_modified\n` +
    `RETURNING (xmax = 0) AS is_insert`;
  return { text, values };
}

export interface CliArgs {
  /** Explicit start: ISO date-time (UTC unless it carries a zone) or unix seconds. Ignores the checkpoint. */
  from: string | null;
  /** Stop once the feed passes this ISO date-time / unix seconds. */
  until: string | null;
  limit: number;
  maxMinutes: number;
  dryRun: boolean;
  /** Ignore the saved cursor and start from max(date_modified) in the table. */
  resetCursor: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    from: null,
    until: null,
    limit: Infinity,
    maxMinutes: Infinity,
    dryRun: false,
    resetCursor: false,
  };
  for (const arg of argv) {
    const [k, v] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, ''];
    switch (k) {
      case '--from': args.from = v || null; break;
      case '--year': args.from = v ? `${parseInt(v, 10)}-01-01T00:00:00Z` : null; break; // legacy flag
      case '--until': args.until = v || null; break;
      case '--limit': args.limit = parseInt(v, 10) > 0 ? parseInt(v, 10) : Infinity; break;
      case '--max-minutes': args.maxMinutes = parseFloat(v) > 0 ? parseFloat(v) : Infinity; break;
      case '--dry-run': args.dryRun = true; break;
      case '--reset-cursor': args.resetCursor = true; break;
      case '--resume': break; // legacy flag: resuming is now the default
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

/** ISO (zone-less = UTC) or unix seconds -> unix seconds. */
export function toUnixSeconds(input: string): number {
  if (/^\d+(\.\d+)?$/.test(input)) return parseFloat(input);
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(input);
  const ms = Date.parse(hasZone ? input : `${input}Z`);
  if (Number.isNaN(ms)) throw new Error(`Bad date: ${input}`);
  return ms / 1000;
}

/** Wait time for a 429/503: Retry-After (seconds or HTTP date) else exponential backoff, capped. */
export function retryDelayMs(attempt: number, retryAfter: string | null, nowMs = Date.now()): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 300_000);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - nowMs, 1000), 300_000);
  }
  return Math.min(2000 * 2 ** attempt, 120_000);
}
