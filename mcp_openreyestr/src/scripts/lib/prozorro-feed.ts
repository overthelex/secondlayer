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

// ---------------------------------------------------------------------------
// Contracts and winners (LEXAI-2227)
//
// Feed facts (measured 2026-11-14):
// - Up to ~2024 the contract inside GET /tenders/<id> carries suppliers,
//   dateSigned and period. Since the move to the separate contracting module
//   (≈2025) it is a stub: id, awardID, contractID, status, value, no suppliers.
//   The supplier is then only on the award the contract points to (awardID),
//   so the supplier is resolved contract.suppliers -> award.suppliers.
// - ~7.1M of the 8M tenders have dateModified in 2025-2026 (bulk touch during
//   that migration), so for almost all history the stub form applies.
// ---------------------------------------------------------------------------

export const CONTRACT_COLUMNS = [
  'contract_id',
  'tender_id',
  'contract_number',
  'contract_ua_id',
  'award_id',
  'lot_id',
  'status',
  'supplier_edrpou',
  'supplier_scheme',
  'supplier_name',
  'supplier_scale',
  'supplier_region',
  'supplier_locality',
  'supplier_address',
  'supplier_email',
  'supplier_phone',
  'supplier_count',
  'amount',
  'amount_net',
  'currency',
  'vat_included',
  'date_signed',
  'period_start',
  'period_end',
  'contract_date',
  'tender_date_modified',
] as const;

export type ContractColumn = (typeof CONTRACT_COLUMNS)[number];
export type ContractRecord = Record<ContractColumn, string | number | boolean | null>;

function cleanAmount(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) >= MAX_AMOUNT) return null;
  return v;
}

/**
 * Phones come in any format ("+380 97 700-92-63", "0977009263"). Keep digits,
 * and give a 10-digit national number the 38 prefix, so one phone matches
 * across suppliers. Returns null for anything that is not 9-15 digits and for
 * placeholder numbers whose last 9 digits are one repeated digit.
 */
export function normalizePhone(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let d = v.replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('0')) d = `38${d}`;
  if (d.length < 9 || d.length > 15) return null;
  // Placeholders ("+380000000000", "000000000", "0999999999") would make
  // dozens of unrelated suppliers look like they share a phone.
  if (/^(\d)\1+$/.test(d.slice(-9))) return null;
  return d;
}

function str(v: unknown, max = 1000): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.substring(0, max) : null;
}

/** One row per contract of the tender; the supplier falls back to the contract's award. */
export function extractContracts(data: any): ContractRecord[] {
  if (!data || typeof data.id !== 'string' || !Array.isArray(data.contracts)) return [];
  const awards = new Map<string, any>();
  for (const a of Array.isArray(data.awards) ? data.awards : []) if (a?.id) awards.set(a.id, a);

  const out: ContractRecord[] = [];
  for (const c of data.contracts) {
    if (!c || typeof c.id !== 'string' || !c.id) continue;
    const award = c.awardID ? awards.get(c.awardID) : undefined;
    const suppliers: any[] =
      (Array.isArray(c.suppliers) && c.suppliers.length ? c.suppliers : null) ||
      (Array.isArray(award?.suppliers) ? award.suppliers : []);
    const s = suppliers[0] || {};
    const addr = s.address || {};
    const cp = s.contactPoint || {};
    const value = c.value || {};
    const period = c.period || {};
    out.push({
      contract_id: c.id,
      tender_id: data.id,
      contract_number: str(c.contractNumber, 200),
      contract_ua_id: str(c.contractID, 100),
      award_id: str(c.awardID, 64),
      lot_id: str(award?.lotID, 64),
      status: str(c.status, 50),
      supplier_edrpou: str(s.identifier?.id, 50),
      supplier_scheme: str(s.identifier?.scheme, 50),
      supplier_name: str(s.identifier?.legalName) || str(s.name),
      supplier_scale: str(s.scale, 20),
      supplier_region: str(addr.region, 200),
      supplier_locality: str(addr.locality, 200),
      supplier_address: str(addr.streetAddress, 500),
      supplier_email: str(cp.email, 200)?.toLowerCase() ?? null,
      supplier_phone: normalizePhone(cp.telephone),
      supplier_count: suppliers.length,
      amount: cleanAmount(value.amount),
      amount_net: cleanAmount(value.amountNet),
      currency: str(value.currency, 10) || 'UAH',
      vat_included: typeof value.valueAddedTaxIncluded === 'boolean' ? value.valueAddedTaxIncluded : null,
      date_signed: str(c.dateSigned, 40),
      period_start: period.startDate ? String(period.startDate).substring(0, 10) : null,
      period_end: period.endDate ? String(period.endDate).substring(0, 10) : null,
      contract_date: str(c.date, 40),
      tender_date_modified: str(data.dateModified, 40),
    });
  }
  return out;
}

/**
 * Upsert keyed on contract_id. A row is only overwritten by a version from the
 * same or a newer tender dateModified. Fields the stub form lacks (dateSigned,
 * period, contract number) are kept from an older, fuller version via COALESCE.
 */
export function buildContractsUpsert(records: ContractRecord[]): { text: string; values: unknown[] } | null {
  const byId = new Map<string, ContractRecord>();
  for (const r of records) {
    const id = String(r.contract_id);
    const prev = byId.get(id);
    if (!prev || String(r.tender_date_modified ?? '') >= String(prev.tender_date_modified ?? '')) byId.set(id, r);
  }
  const rows = [...byId.values()];
  if (rows.length === 0) return null;

  const values: unknown[] = [];
  const tuples = rows.map((r) => {
    const ph = CONTRACT_COLUMNS.map((c) => {
      values.push(r[c]);
      return `$${values.length}`;
    });
    return `(${ph.join(',')})`;
  });

  const sticky = new Set<ContractColumn>([
    'contract_number', 'date_signed', 'period_start', 'period_end',
    'supplier_edrpou', 'supplier_scheme', 'supplier_name', 'supplier_scale', 'supplier_region',
    'supplier_locality', 'supplier_address', 'supplier_email', 'supplier_phone', 'lot_id',
  ]);
  const set = CONTRACT_COLUMNS.filter((c) => c !== 'contract_id').map((c) =>
    sticky.has(c) ? `${c} = COALESCE(EXCLUDED.${c}, prozorro_contracts.${c})` : `${c} = EXCLUDED.${c}`,
  );
  const text =
    `INSERT INTO prozorro_contracts (${CONTRACT_COLUMNS.join(', ')}) VALUES ${tuples.join(',')}\n` +
    `ON CONFLICT (contract_id) DO UPDATE SET ${set.join(', ')}, updated_at = now()\n` +
    `WHERE prozorro_contracts.tender_date_modified IS NULL OR EXCLUDED.tender_date_modified IS NULL ` +
    `OR EXCLUDED.tender_date_modified >= prozorro_contracts.tender_date_modified`;
  return { text, values };
}

/** DDL shared by migration 025 and the importers (migrations do not run on container start). */
export const CONTRACTS_DDL = `
CREATE TABLE IF NOT EXISTS prozorro_contracts (
  contract_id          TEXT PRIMARY KEY,
  tender_id            TEXT NOT NULL,
  contract_number      TEXT,
  contract_ua_id       TEXT,
  award_id             TEXT,
  lot_id               TEXT,
  status               TEXT,
  supplier_edrpou      TEXT,
  supplier_scheme      TEXT,
  supplier_name        TEXT,
  supplier_scale       TEXT,
  supplier_region      TEXT,
  supplier_locality    TEXT,
  supplier_address     TEXT,
  supplier_email       TEXT,
  supplier_phone       TEXT,
  supplier_count       SMALLINT,
  amount               NUMERIC(15,2),
  amount_net           NUMERIC(15,2),
  currency             TEXT,
  vat_included         BOOLEAN,
  date_signed          TIMESTAMPTZ,
  period_start         DATE,
  period_end           DATE,
  contract_date        TIMESTAMPTZ,
  tender_date_modified TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prozorro_contracts_tender   ON prozorro_contracts (tender_id);
CREATE INDEX IF NOT EXISTS idx_prozorro_contracts_supplier ON prozorro_contracts (supplier_edrpou) WHERE supplier_edrpou IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prozorro_contracts_email    ON prozorro_contracts (supplier_email) WHERE supplier_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prozorro_contracts_phone    ON prozorro_contracts (supplier_phone) WHERE supplier_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prozorro_contracts_signed   ON prozorro_contracts (date_signed);
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_prozorro_contracts_name_trgm ON prozorro_contracts USING gin (supplier_name gin_trgm_ops);
`;
