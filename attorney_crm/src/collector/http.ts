// Polite HTTP client: one request at a time, per-host minimum spacing, back-off on 429/5xx,
// hard stop after N consecutive failures, optional HTTP proxy (the pl-egress sidecar).
import { fetch as undiciFetch, ProxyAgent } from 'undici';

/** undici's own fetch: the only one guaranteed to accept npm undici's ProxyAgent as `dispatcher`. */
export const defaultFetch = undiciFetch as unknown as typeof fetch;

export class CollectorStopped extends Error {}
export class HttpStatusError extends Error {
  constructor(public readonly status: number, public readonly url: string) {
    super(`HTTP ${status} for ${url}`);
  }
}

export interface CollectorOptions {
  userAgent: string;
  /** host → minimum milliseconds between two requests to that host */
  minDelayMs: Record<string, number>;
  maxConsecutiveFailures: number;
  proxyUrl?: string | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

const BACKOFF_MS = [10_000, 30_000, 60_000, 120_000, 300_000];

export class Collector {
  private lastAt = new Map<string, number>();
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly dispatcher: ProxyAgent | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  failures = 0;
  requests = 0;

  constructor(private readonly o: CollectorOptions) {
    this.fetchImpl = o.fetchImpl ?? defaultFetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
    this.dispatcher = o.proxyUrl ? new ProxyAgent(o.proxyUrl) : undefined;
  }

  get(url: string): Promise<string> {
    return this.request(url, { method: 'GET' });
  }

  /** One attempt, no retry, no failure accounting: the health probe. */
  async probe(url: string): Promise<{ status: number; ms: number }> {
    const started = Date.now();
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { 'user-agent': this.o.userAgent, accept: 'text/html,*/*' },
        dispatcher: this.dispatcher,
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      } as RequestInit);
      await res.arrayBuffer();
      return { status: res.status, ms: Date.now() - started };
    } catch {
      return { status: 0, ms: Date.now() - started };
    }
  }

  post(url: string, form: Record<string, string>): Promise<string> {
    return this.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  }

  /** Serialised: the next request waits for the previous one, so per-host spacing is exact. */
  private request(url: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<string> {
    const run = this.chain.then(() => this.doRequest(url, init));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doRequest(url: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<string> {
    const host = new URL(url).host.replace(/^www\./, '');
    const minDelay = this.o.minDelayMs[host] ?? 2000;
    for (let attempt = 0; ; attempt++) {
      const last = this.lastAt.get(host);
      if (last !== undefined) {
        const wait = last + minDelay - this.now();
        if (wait > 0) await this.sleep(wait);
      }
      this.lastAt.set(host, this.now());
      this.requests++;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          ...init,
          headers: { 'user-agent': this.o.userAgent, accept: 'text/html,*/*', 'accept-language': 'pl,en;q=0.5', ...(init.headers ?? {}) },
          dispatcher: this.dispatcher,
          redirect: 'follow',
          signal: AbortSignal.timeout(60_000),
        } as RequestInit);
      } catch (e) {
        await this.failed(`${init.method} ${url}: ${(e as Error).message}`, attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        await this.failed(`${init.method} ${url}: HTTP ${res.status}`, attempt);
        continue;
      }
      if (res.status >= 400) {
        // 403 from a WAF is a block, not a soft miss: count it; 404/410 are the target's answer
        if (res.status === 403) await this.failed(`${init.method} ${url}: HTTP 403`, attempt);
        else {
          this.failures = 0;
          throw new HttpStatusError(res.status, url);
        }
        continue;
      }
      this.failures = 0;
      return await res.text();
    }
  }

  private async failed(what: string, attempt: number): Promise<void> {
    this.failures++;
    this.o.log?.(`[collector] ${what} (consecutive failures ${this.failures})`);
    if (this.failures >= this.o.maxConsecutiveFailures) throw new CollectorStopped(`stopped after ${this.failures} consecutive failures: ${what}`);
    await this.sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
  }
}
