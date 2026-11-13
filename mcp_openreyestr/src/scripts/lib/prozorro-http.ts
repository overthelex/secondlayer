/**
 * HTTP client for the ProZorro public API shared by import-prozorro.ts and
 * backfill-prozorro-contracts.ts: keep-alive agent, retries, and one back-off
 * gate so a 429/503 on any worker pauses all of them.
 */
import https from 'https';
import { ContractRecord, extractContracts, extractTenderData, retryDelayMs, TenderRecord } from './prozorro-feed';

export const API_BASE = process.env.PROZORRO_API_BASE || 'https://public-api.prozorro.gov.ua/api/2.5';
const MAX_ATTEMPTS = 8;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

interface HttpResult { status: number; retryAfter: string | null; body: string }

export interface TenderDetails { records: TenderRecord[]; contracts: ContractRecord[]; missing: number }

export function createProzorroClient(concurrency: number, delayMs = 0) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: concurrency + 2 });
  let pausedUntil = 0;

  function httpGet(url: string): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { agent, timeout: 60_000, headers: { 'User-Agent': 'legal.org.ua openreyestr importer' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          const ra = res.headers['retry-after'];
          resolve({ status: res.statusCode || 0, retryAfter: Array.isArray(ra) ? ra[0] : ra || null, body });
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
  }

  /** GET JSON with retries. Returns null on 404/410 (gone). Throws after MAX_ATTEMPTS. */
  async function fetchJson(url: string): Promise<any | null> {
    let lastErr = '';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const wait = pausedUntil - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        const res = await httpGet(url);
        if (res.status === 200) return JSON.parse(res.body);
        if (res.status === 404 || res.status === 410) return null;
        lastErr = `HTTP ${res.status}`;
        if (res.status === 429 || res.status === 503) {
          const delay = retryDelayMs(attempt, res.retryAfter);
          pausedUntil = Math.max(pausedUntil, Date.now() + delay);
          log(`  ${res.status} from API, all workers pause ${Math.round(delay / 1000)}s`);
          continue;
        }
      } catch (e) {
        lastErr = (e as Error).message;
      }
      await sleep(retryDelayMs(attempt, null));
    }
    throw new Error(`${lastErr} after ${MAX_ATTEMPTS} attempts: ${url}`);
  }

  /** GET /tenders/<id> for every id; tender rows plus their contracts with the winner. */
  async function fetchDetails(ids: string[]): Promise<TenderDetails> {
    const records: TenderRecord[] = [];
    const contracts: ContractRecord[] = [];
    let missing = 0;
    let idx = 0;
    let failure: Error | null = null;
    async function worker(): Promise<void> {
      while (idx < ids.length && !failure) {
        const id = ids[idx++];
        try {
          const json = await fetchJson(`${API_BASE}/tenders/${id}`);
          const rec = json ? extractTenderData(json.data) : null;
          if (rec) {
            records.push(rec);
            contracts.push(...extractContracts(json.data));
          } else missing++;
        } catch (e) {
          failure = e as Error;
        }
        if (delayMs) await sleep(delayMs);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
    if (failure) throw failure;
    return { records, contracts, missing };
  }

  return { fetchJson, fetchDetails, destroy: () => agent.destroy() };
}
