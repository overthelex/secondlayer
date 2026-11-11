// A small client for the Asterisk REST Interface (ARI): originate a call, let a
// channel continue in the dialplan, and a WebSocket that delivers the events.
// The PBX is one VM with a self-signed certificate, so the TLS peer is checked by
// its SHA-256 fingerprint (ATTORNEY_CRM_ARI_CERT_SHA256) rather than a CA chain.
import type { TLSSocket } from 'tls';
import { Agent, buildConnector, fetch as undiciFetch, WebSocket as UndiciWebSocket, type Dispatcher } from 'undici';

export interface AriOptions {
  /** e.g. https://pbx.example:8089/ari */
  url: string;
  user: string;
  password: string;
  /** Stasis application name (ari.conf / the dialplan's Stasis()). */
  app: string;
  /** Pin for the PBX certificate, hex with or without colons; unset = normal CA verification. */
  certSha256?: string | null;
}

export interface OriginateRequest {
  /** PJSIP/vladimir: the leg that rings first (the operator's phone). */
  endpoint: string;
  /** Where the channel goes once that leg answers. */
  context: string;
  extension: string;
  /** Name/number shown on the ringing phone. */
  callerId?: string;
  /** Our own channel id, so the recording file and the events can be matched to the CRM call. */
  channelId: string;
  timeoutSeconds?: number;
  variables?: Record<string, string>;
}

export interface AriChannel {
  id: string;
  name?: string;
  state?: string;
  caller?: { name?: string; number?: string };
  connected?: { name?: string; number?: string };
  dialplan?: { context?: string; exten?: string; priority?: number; app_name?: string; app_data?: string };
}

/** The subset of ARI event fields the CRM reads (see Asterisk's ARI "Events" model). */
export interface AriEvent {
  type: string;
  timestamp?: string;
  application?: string;
  args?: string[];
  channel?: AriChannel;
  /** Dial: the channel that dialled and the one that was dialled. */
  caller?: AriChannel;
  peer?: AriChannel;
  dialstatus?: string;
  /** ChannelDestroyed */
  cause?: number;
  cause_txt?: string;
}

export interface EventSocket {
  onEvent(handler: (event: AriEvent) => void): void;
  /** Called once when the socket is gone (closed by the PBX, network error, or close()). */
  onClose(handler: (reason: string) => void): void;
  close(): void;
}

export class AriError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function normaliseFingerprint(fp: string): string {
  return fp.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

/** A connector that accepts exactly the pinned certificate (any other TLS error still fails). */
export function pinnedConnector(certSha256: string): buildConnector.connector {
  const pin = normaliseFingerprint(certSha256);
  const base = buildConnector({ rejectUnauthorized: false });
  return (opts, cb) => {
    base(opts, (err, socket) => {
      if (err || !socket) return cb(err ?? new Error('connect failed'), null);
      if (opts.protocol === 'https:') {
        const peer = (socket as TLSSocket).getPeerCertificate();
        const got = peer?.fingerprint256 ? normaliseFingerprint(peer.fingerprint256) : '';
        if (got !== pin) {
          socket.destroy();
          return cb(new Error(`ARI certificate fingerprint ${got || 'unknown'} does not match the pinned one`), null);
        }
      }
      cb(null, socket);
    });
  };
}

type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body?: string; dispatcher?: Dispatcher }) => Promise<{ status: number; text(): Promise<string> }>;
type SocketFactory = (url: string, headers: Record<string, string>) => EventSocket;

export class AriClient {
  readonly app: string;
  private readonly base: string;
  private readonly authHeader: string;
  private readonly dispatcher: Dispatcher | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly socketFactory: SocketFactory;

  constructor(opts: AriOptions, deps: { fetch?: FetchLike; socketFactory?: SocketFactory } = {}) {
    this.app = opts.app;
    this.base = opts.url.replace(/\/+$/, '');
    this.authHeader = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString('base64')}`;
    this.dispatcher = opts.certSha256 ? new Agent({ connect: pinnedConnector(opts.certSha256) }) : undefined;
    this.fetchImpl = deps.fetch ?? ((input, init) => undiciFetch(input, init));
    this.socketFactory = deps.socketFactory ?? ((url, headers) => undiciSocket(url, headers, this.dispatcher));
  }

  private async call(method: 'GET' | 'POST' | 'DELETE', path: string, query: Record<string, string | number | undefined> = {}, body?: unknown): Promise<string> {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const url = `${this.base}${path}${qs ? `?${qs}` : ''}`;
    const headers: Record<string, string> = { Authorization: this.authHeader, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), dispatcher: this.dispatcher });
    const text = await res.text();
    if (res.status >= 400) throw new AriError(res.status, `ARI ${method} ${path} → ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`);
    return text;
  }

  /** POST /channels: rings `endpoint`; when it answers, the channel runs context/extension. */
  async originate(req: OriginateRequest): Promise<AriChannel> {
    const text = await this.call('POST', '/channels', {
      endpoint: req.endpoint,
      context: req.context,
      extension: req.extension,
      priority: 1,
      callerId: req.callerId,
      channelId: req.channelId,
      timeout: req.timeoutSeconds ?? 40,
    }, req.variables ? { variables: req.variables } : undefined);
    return JSON.parse(text) as AriChannel;
  }

  /** POST /channels/{id}/continue: leave Stasis and carry on at the next dialplan priority. */
  async continueInDialplan(channelId: string): Promise<void> {
    await this.call('POST', `/channels/${encodeURIComponent(channelId)}/continue`);
  }

  async hangup(channelId: string): Promise<void> {
    await this.call('DELETE', `/channels/${encodeURIComponent(channelId)}`);
  }

  /** GET /asterisk/info as a liveness check; throws on auth or transport failure. */
  async ping(): Promise<void> {
    await this.call('GET', '/asterisk/info', { only: 'status' });
  }

  /**
   * The event WebSocket for the app. subscribeAll makes Asterisk also send events for
   * channels outside Stasis (an outbound call lives in the dialplan the whole time).
   */
  openEvents(): EventSocket {
    const ws = this.base.replace(/^http/, 'ws');
    return this.socketFactory(`${ws}/events?app=${encodeURIComponent(this.app)}&subscribeAll=true`, { Authorization: this.authHeader });
  }
}

function undiciSocket(url: string, headers: Record<string, string>, dispatcher: Dispatcher | undefined): EventSocket {
  const socket = new UndiciWebSocket(url, { headers, dispatcher });
  let closed = false;
  const closeHandlers: ((reason: string) => void)[] = [];
  const emitClose = (reason: string) => {
    if (closed) return;
    closed = true;
    for (const h of closeHandlers) h(reason);
  };
  socket.addEventListener('close', (e) => emitClose(`closed ${e.code}${e.reason ? ` ${e.reason}` : ''}`));
  socket.addEventListener('error', (e) => emitClose(`error ${(e as ErrorEvent).message ?? ''}`.trim()));
  return {
    onEvent(handler) {
      socket.addEventListener('message', (m) => {
        try {
          handler(JSON.parse(String(m.data)) as AriEvent);
        } catch {
          /* not JSON: ignore */
        }
      });
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
    close() {
      socket.close();
    },
  };
}

/**
 * Keeps the event socket open: reconnects with exponential backoff (2 s … 60 s) and
 * hands every event to `onEvent`. A received event resets the backoff.
 */
export function runEventLoop(
  open: () => EventSocket,
  onEvent: (e: AriEvent) => void,
  log: (line: string) => void,
  opts: { minDelayMs?: number; maxDelayMs?: number } = {},
): { stop(): void } {
  const minDelay = opts.minDelayMs ?? 2_000;
  const maxDelay = opts.maxDelayMs ?? 60_000;
  let stopped = false;
  let delay = minDelay;
  let current: EventSocket | null = null;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (reason: string) => {
    current = null;
    if (stopped) return;
    log(`events: ${reason}; reconnect in ${Math.round(delay / 1000)} s`);
    timer = setTimeout(connect, delay);
    delay = Math.min(delay * 2, maxDelay);
  };
  const connect = () => {
    if (stopped) return;
    try {
      const socket = open();
      current = socket;
      socket.onEvent((e) => {
        delay = minDelay;
        onEvent(e);
      });
      socket.onClose(schedule);
    } catch (err) {
      schedule((err as Error).message);
    }
  };
  connect();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      current?.close();
    },
  };
}
