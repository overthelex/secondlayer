/**
 * Rada bill feeds on data.rada.gov.ua (/ogd/zpr/sklN/).
 *
 * - `billinfo_list-sklN.json` (~9 MB): id, name, number, date, session, subject.
 *   No status, stage, committee or URL. This is what RadaAPIAdapter.fetchBills reads.
 * - `billinfo-sklN.json` (~140 MB): the full card per bill, including `url`
 *   (itd.rada.gov.ua card), `currentPhase.status`, `passings` (procedural events),
 *   `rubric`, `type`, `mainExecutives` (lead committee), `initiators`, documents.
 *
 * LEXAI-2099: rada.bills was only ever filled from the light list, so status,
 * stage and url were NULL for every bill. The full feed is mapped here.
 */

const API_BASE = 'https://data.rada.gov.ua/ogd/zpr';
const FETCH_TIMEOUT_MS = 180_000;

/** Bill card on the Rada legislative portal; the id is the feed's `id` (billinfo id). */
export function billCardUrl(billId: unknown): string | null {
  const n = Number(billId);
  if (!Number.isInteger(n) || n <= 0) return null;
  return `https://itd.rada.gov.ua/billInfo/Bills/Card/${n}`;
}

export function nz(v: any): any {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  return v;
}

function clip(v: any, max: number): string | null {
  const s = nz(v);
  if (s === null) return null;
  const t = String(s).trim();
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * Parse a bill feed body. The Rada feed embeds raw control characters inside string
 * values, which strict JSON.parse rejects. Escaped sequences (\\n) are two chars and
 * untouched; only raw bytes 0x00–0x1F get flattened to spaces. A leading BOM is dropped.
 */
export function parseBillFeed(text: string): any[] {
  const data = JSON.parse(text.replace(/^\uFEFF/, '').replace(/[\x00-\x1F]/g, ' '));
  return Array.isArray(data)
    ? data
    : (Object.values(data).find((v) => Array.isArray(v)) as any[]) || [];
}

/**
 * Current convocations expose the rich `billinfo-sklN.json`; past convocations only
 * the legacy `bills-sklN.json`. Auto-detects and returns which one was read.
 */
export async function fetchBillFeed(conv: number): Promise<{ bills: any[]; modern: boolean }> {
  const candidates: [string, boolean][] = [
    [`${API_BASE}/skl${conv}/billinfo-skl${conv}.json`, true],
    [`${API_BASE}/skl${conv}/bills-skl${conv}.json`, false],
  ];
  for (const [url, modern] of candidates) {
    console.log(`\n📥 Trying ${url} …`);
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'SecondLayer-Legal-Platform/1.0' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (resp.status === 404) {
      console.log('   404 — trying next candidate…');
      continue;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    const text = await resp.text();
    console.log(`   Downloaded ${(text.length / 1_048_576).toFixed(1)} MB (${modern ? 'modern' : 'legacy'} format), parsing…`);
    const bills = parseBillFeed(text);
    console.log(`   ${bills.length.toLocaleString()} bills in feed`);
    return { bills, modern };
  }
  throw new Error(`No bill feed found for skl${conv} (billinfo/bills both 404)`);
}

/**
 * Extract the bill's initiators (co-sponsors) as names plus deputy person-ids.
 * Modern feed wraps each initiator in mp/inner/outter, legacy in `official`; all carry
 * person {surname,firstname,patronymic,id}. Bodies (President/Cabinet/committee)
 * without a person fall back to the post/organization/department label.
 */
export function extractInitiators(bill: any): { names: string[]; ids: number[] } {
  const arr = Array.isArray(bill.initiators)
    ? bill.initiators
    : Array.isArray(bill.authors)
      ? bill.authors
      : [];
  const names: string[] = [];
  const ids: number[] = [];
  for (const ini of arr) {
    if (typeof ini === 'string') {
      const s = ini.trim();
      if (s) names.push(s);
      continue;
    }
    const slot = ini?.mp || ini?.inner || ini?.outter || ini?.official || ini || {};
    const p = slot.person || null;
    let nm = '';
    if (p) {
      nm = [p.surname, p.firstname, p.patronymic].filter(Boolean).join(' ').trim();
      const pid = Number(p.id);
      if (Number.isFinite(pid) && pid > 0) ids.push(pid);
    }
    if (!nm) nm = (slot.post || slot.organization || slot.department || '').trim();
    if (nm) names.push(nm);
  }
  return { names, ids };
}

/** A rada.bills row built from one `billinfo-sklN.json` card. */
export interface BillFeedRow {
  bill_number: string;
  title: string;
  registration_date: string | null;
  status: string | null;
  stage: string | null;
  initiator_type: string | null;
  initiator_names: string[];
  main_committee_name: string | null;
  subject_area: string | null;
  url: string | null;
  metadata: Record<string, any>;
}

/**
 * Map a modern-feed card to a rada.bills row. Returns null for cards without a
 * registration number or title (nothing to key or show).
 *
 * - status = currentPhase.status («Опрацьовується в комітеті», «Закон підписано», …)
 * - stage  = the latest procedural event (passings[].title, newest by date)
 * - url    = feed url, else the itd.rada.gov.ua card derived from the id
 */
export function billInfoToRow(raw: any, conv: number): BillFeedRow | null {
  const number = clip(raw?.registrationNumber ?? raw?.number, 50);
  const title = nz(raw?.name ?? raw?.title);
  if (!number || !title) return null;

  const passings: any[] = Array.isArray(raw.passings) ? raw.passings.filter(Boolean) : [];
  const latest = passings
    .slice()
    .sort((a, b) => String(b?.date || '').localeCompare(String(a?.date || '')))[0];

  const committee = Array.isArray(raw.mainExecutives)
    ? raw.mainExecutives.map((m: any) => nz(m?.department)).find(Boolean)
    : null;

  const regDate = nz(raw.registrationDate);
  const ini = extractInitiators(raw);

  return {
    bill_number: number,
    title: String(title).trim(),
    registration_date: regDate ? String(regDate).slice(0, 10) : null,
    status: clip(raw.currentPhase?.status ?? raw.currentPhase?.title, 100),
    stage: clip(latest?.title, 100),
    initiator_type: clip(raw.subject, 50),
    initiator_names: ini.names,
    main_committee_name: clip(committee, 255),
    subject_area: clip(raw.rubric, 255),
    url: nz(raw.url) || billCardUrl(raw.id),
    metadata: {
      bill_id: raw.id ?? null,
      convocation: conv,
      type: nz(raw.type),
      redaction: nz(raw.redaction),
      rubric: nz(raw.rubric),
      registrationSession: nz(raw.registrationSession),
      registrationConvocation: nz(raw.registrationConvocation),
      currentPhase: raw.currentPhase ?? null,
      stage_date: nz(latest?.date),
      actNumber: nz(raw.actNumber),
      actDate: nz(raw.actDate),
      isUrgent: raw.isUrgent ?? null,
      isEuro: raw.isEuro ?? null,
      initiator_ids: ini.ids,
    },
  };
}
