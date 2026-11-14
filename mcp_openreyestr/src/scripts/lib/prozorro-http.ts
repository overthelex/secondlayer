/**
 * HTTP client for the ProZorro public API shared by import-prozorro.ts and
 * backfill-prozorro-contracts.ts.
 *
 * Egress lanes (LEXAI-2227): ProZorro rate-limits per source IP (~80 req/s), so
 * a long backfill can spread its workers over several egress IPs. A lane is
 * either "direct" or an HTTP proxy that supports CONNECT (tinyproxy on a small
 * VM, reached through an SSH tunnel on 127.0.0.1). Each lane has its own
 * keep-alive agent, its own worker count and its own back-off gate, so a 429 on
 * one IP pauses only that IP's workers.
 *
 * Each lane is also self-tuning (AIMD): the worker count in PROZORRO_EGRESS is
 * a ceiling. A 429/503 cuts the lane's active workers by a quarter (at most once
 * per CUT_COOLDOWN_MS); after QUIET_MS without one the lane gets one worker back
 * every RAISE_EVERY_MS, up to the ceiling. ProZorro's per-IP limit drifts, so a
 * fixed count either leaves speed on the table or keeps hitting 429.
 *
 *   PROZORRO_EGRESS="direct=10,http://127.0.0.1:8201=20,http://127.0.0.1:8202=20"
 *
 * Unset, there is one direct lane with the caller's concurrency (the old
 * behaviour). Responses are requested gzip-compressed (~3x less traffic).
 */
import http from 'http';
import https from 'https';
import tls from 'tls';
import zlib from 'zlib';
import { ContractRecord, extractContracts, extractTenderData, retryDelayMs, TenderRecord } from './prozorro-feed';

export const API_BASE = process.env.PROZORRO_API_BASE || 'https://public-api.prozorro.gov.ua/api/2.5';
const MAX_ATTEMPTS = 8;
export const CUT_COOLDOWN_MS = 5_000;
export const QUIET_MS = 30_000;
export const RAISE_EVERY_MS = 10_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

interface HttpResult { status: number; retryAfter: string | null; body: string }

export interface TenderDetails { records: TenderRecord[]; contracts: ContractRecord[]; missing: number }

export interface LaneSpec { name: string; proxy: string | null; workers: number }

/** "direct=10,http://127.0.0.1:8201=20" → lanes; empty → one direct lane. */
export function parseEgress(spec: string | undefined, defaultWorkers: number): LaneSpec[] {
  if (!spec || !spec.trim()) return [{ name: 'direct', proxy: null, workers: defaultWorkers }];
  return spec.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const eq = part.lastIndexOf('=');
    if (eq <= 0) throw new Error(`PROZORRO_EGRESS: "${part}" needs <direct|http://host:port>=<workers>`);
    const target = part.slice(0, eq);
    const workers = parseInt(part.slice(eq + 1), 10);
    if (!(workers > 0)) throw new Error(`PROZORRO_EGRESS: bad worker count in "${part}"`);
    if (target === 'direct') return { name: 'direct', proxy: null, workers };
    const u = new URL(target);
    if (u.protocol !== 'http:') throw new Error(`PROZORRO_EGRESS: only http:// CONNECT proxies are supported, got "${target}"`);
    return { name: `${u.hostname}:${u.port}`, proxy: target, workers };
  });
}

/** HTTPS through an HTTP CONNECT proxy, with keep-alive (the tunnel is reused per socket). */
export class ConnectProxyAgent extends https.Agent {
  constructor(private proxy: URL, opts: https.AgentOptions) {
    super(opts);
  }

  createConnection(options: any, callback?: (err: Error | null, socket?: any) => void): any {
    const host = options.host || options.hostname;
    const port = options.port || 443;
    const req = http.request({
      host: this.proxy.hostname,
      port: Number(this.proxy.port) || 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` },
      timeout: 30_000,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        callback?.(new Error(`proxy CONNECT ${res.statusCode}`));
        return;
      }
      callback?.(null, tls.connect({ socket, servername: options.servername || host }));
    });
    req.once('timeout', () => req.destroy(new Error('proxy CONNECT timeout')));
    req.once('error', (e) => callback?.(e));
    req.end();
    return undefined;
  }
}

export interface Lane extends LaneSpec {
  agent: https.Agent;
  pausedUntil: number;
  /** Workers currently allowed to run (1..workers). */
  active: number;
  lastThrottle: number;
  lastChange: number;
}

/** AIMD step on a throttle: cut a quarter of the active workers, once per cooldown. Returns true if cut. */
export function onThrottle(lane: Lane, now: number): boolean {
  lane.lastThrottle = now;
  if (now - lane.lastChange < CUT_COOLDOWN_MS || lane.active <= 1) return false;
  lane.active = Math.max(1, Math.floor(lane.active * 0.75));
  lane.lastChange = now;
  return true;
}

/** AIMD step on success: after a quiet period, one worker back per RAISE_EVERY_MS. Returns true if raised. */
export function onSuccess(lane: Lane, now: number): boolean {
  if (lane.active >= lane.workers) return false;
  if (now - lane.lastThrottle < QUIET_MS || now - lane.lastChange < RAISE_EVERY_MS) return false;
  lane.active++;
  lane.lastChange = now;
  return true;
}

export function createProzorroClient(concurrency: number, delayMs = 0, lanes: LaneSpec[] = parseEgress(process.env.PROZORRO_EGRESS, concurrency)) {
  const live: Lane[] = lanes.map((l) => ({
    ...l,
    pausedUntil: 0,
    active: l.workers,
    lastThrottle: 0,
    lastChange: 0,
    agent: l.proxy
      ? new ConnectProxyAgent(new URL(l.proxy), { keepAlive: true, maxSockets: l.workers + 2 })
      : new https.Agent({ keepAlive: true, maxSockets: l.workers + 2 }),
  }));
  const totalWorkers = live.reduce((a, l) => a + l.workers, 0);
  const stats = new Map<string, { ok: number; throttled: number }>(live.map((l) => [l.name, { ok: 0, throttled: 0 }]));

  function httpGet(url: string, lane: Lane): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        agent: lane.agent,
        timeout: 60_000,
        headers: { 'User-Agent': 'legal.org.ua openreyestr importer', 'Accept-Encoding': 'gzip' },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const ra = res.headers['retry-after'];
          const raw = Buffer.concat(chunks);
          let body: string;
          try {
            body = res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
          } catch (e) {
            reject(e);
            return;
          }
          resolve({ status: res.statusCode || 0, retryAfter: Array.isArray(ra) ? ra[0] : ra || null, body });
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
  }

  /** GET JSON with retries on one lane. Returns null on 404/410 (gone). Throws after MAX_ATTEMPTS. */
  async function fetchJson(url: string, lane: Lane = live[0]): Promise<any | null> {
    let lastErr = '';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const wait = lane.pausedUntil - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        const res = await httpGet(url, lane);
        if (res.status === 200) {
          stats.get(lane.name)!.ok++;
          if (onSuccess(lane, Date.now())) log(`  lane ${lane.name} quiet, workers ${lane.active}/${lane.workers}`);
          return JSON.parse(res.body);
        }
        if (res.status === 404 || res.status === 410) return null;
        lastErr = `HTTP ${res.status}`;
        if (res.status === 429 || res.status === 503) {
          stats.get(lane.name)!.throttled++;
          if (onThrottle(lane, Date.now())) log(`  lane ${lane.name} throttled, workers ${lane.active}/${lane.workers}`);
          const delay = retryDelayMs(attempt, res.retryAfter);
          if (Date.now() + delay > lane.pausedUntil) {
            lane.pausedUntil = Date.now() + delay;
            log(`  ${res.status} on lane ${lane.name}, its workers pause ${Math.round(delay / 1000)}s`);
          }
          continue;
        }
      } catch (e) {
        lastErr = `${(e as Error).message} (lane ${lane.name})`;
      }
      await sleep(retryDelayMs(attempt, null));
    }
    throw new Error(`${lastErr} after ${MAX_ATTEMPTS} attempts: ${url}`);
  }

  /** GET /tenders/<id> for every id over all lanes; tender rows plus their contracts with the winner. */
  async function fetchDetails(ids: string[]): Promise<TenderDetails> {
    const records: TenderRecord[] = [];
    const contracts: ContractRecord[] = [];
    let missing = 0;
    let idx = 0;
    let failure: Error | null = null;
    async function worker(lane: Lane, slot: number): Promise<void> {
      while (idx < ids.length && !failure) {
        if (slot >= lane.active) { await sleep(500); continue; }
        const id = ids[idx++];
        try {
          const json = await fetchJson(`${API_BASE}/tenders/${id}`, lane);
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
    const workers: Promise<void>[] = [];
    for (const lane of live) for (let i = 0; i < lane.workers; i++) workers.push(worker(lane, i));
    await Promise.all(workers);
    if (failure) throw failure;
    return { records, contracts, missing };
  }

  return {
    fetchJson: (url: string) => fetchJson(url, live[0]),
    fetchDetails,
    lanes: live.map(({ name, proxy, workers }) => ({ name, proxy, workers })),
    totalWorkers,
    /** Per-lane ok/throttled counters since start. */
    laneStats: () => Object.fromEntries(live.map((l) => [l.name, { ...stats.get(l.name)!, active: l.active, max: l.workers }])),
    destroy: () => live.forEach((l) => l.agent.destroy()),
  };
}
