import type { Response } from 'express';

// Server-sent events to every signed-in browser tab: an inbound call pops the
// advocate's card, an outbound call reports ringing / answered / ended. One hub per
// process; nothing is stored, a tab that reconnects simply gets the next event.

export interface PbxBrowserEvent {
  type: 'inbound' | 'call';
  [key: string]: unknown;
}

export class EventHub {
  private readonly clients = new Set<Response>();
  private keepalive: NodeJS.Timeout | null = null;

  constructor(private readonly keepaliveMs = 25_000) {}

  get size(): number {
    return this.clients.size;
  }

  /** Takes over the response: SSE headers, a first comment, and the keepalive. */
  subscribe(res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // nginx honours this and streams instead of buffering the response
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
    if (!this.keepalive) {
      this.keepalive = setInterval(() => this.broadcast(': ping\n\n'), this.keepaliveMs);
      this.keepalive.unref();
    }
  }

  publish(event: PbxBrowserEvent): void {
    this.broadcast(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  private broadcast(chunk: string): void {
    for (const res of this.clients) {
      try {
        res.write(chunk);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  close(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}
