import { EventEmitter } from 'events';
import { resolveChatTimeoutMs, createChatInlineRoutes } from '../chat-inline-routes';

describe('resolveChatTimeoutMs', () => {
  // ChatService auto-escalates effectiveBudget up to maxBudget (default: deep),
  // so the wall-clock backstop must cover the escalation ceiling, not the
  // requested budget. Repro: chat-f6e736b9 (2026-07-03) — standard request
  // auto-escalated to deep (plan >= 8 steps) was aborted mid-VERIFY at 240s.

  // Raised 360s -> 600s on 2026-08-19: three of that day's twelve prod runs died
  // on the backstop (361s, 457s, 497s) and returned the "не завершена" stub, while
  // every run that finished did so within 315s. 360s was landing inside the spread
  // of a normal heavy run, not outside it.

  it('gives the deep timeout when no maxBudget caps escalation', () => {
    expect(resolveChatTimeoutMs('standard', undefined)).toBe(600_000);
    expect(resolveChatTimeoutMs('quick', undefined)).toBe(600_000);
    expect(resolveChatTimeoutMs(undefined, undefined)).toBe(600_000);
    expect(resolveChatTimeoutMs('deep', undefined)).toBe(600_000);
  });

  it('gives the deep timeout when maxBudget is deep', () => {
    expect(resolveChatTimeoutMs('standard', 'deep')).toBe(600_000);
  });

  it('gives the standard timeout when maxBudget caps escalation below deep', () => {
    expect(resolveChatTimeoutMs('standard', 'standard')).toBe(240_000);
    expect(resolveChatTimeoutMs('quick', 'quick')).toBe(240_000);
  });

  // Tunable without a deploy: the backstop is a runaway guard whose right value is
  // only learnable from production, and the last retune cost three paid-for answers.
  describe('env overrides', () => {
    const saved = { deep: process.env.CHAT_DEEP_TIMEOUT_MS, capped: process.env.CHAT_CAPPED_TIMEOUT_MS };
    afterEach(() => {
      process.env.CHAT_DEEP_TIMEOUT_MS = saved.deep;
      process.env.CHAT_CAPPED_TIMEOUT_MS = saved.capped;
      if (saved.deep === undefined) delete process.env.CHAT_DEEP_TIMEOUT_MS;
      if (saved.capped === undefined) delete process.env.CHAT_CAPPED_TIMEOUT_MS;
    });

    it('honours CHAT_DEEP_TIMEOUT_MS', () => {
      process.env.CHAT_DEEP_TIMEOUT_MS = '900000';
      expect(resolveChatTimeoutMs('standard', undefined)).toBe(900_000);
    });

    it('honours CHAT_CAPPED_TIMEOUT_MS', () => {
      process.env.CHAT_CAPPED_TIMEOUT_MS = '180000';
      expect(resolveChatTimeoutMs('standard', 'standard')).toBe(180_000);
    });

    it('ignores junk and zero, so a typo cannot abort every run instantly', () => {
      process.env.CHAT_DEEP_TIMEOUT_MS = 'нісенітниця';
      expect(resolveChatTimeoutMs('standard', undefined)).toBe(600_000);
      process.env.CHAT_DEEP_TIMEOUT_MS = '0';
      expect(resolveChatTimeoutMs('standard', undefined)).toBe(600_000);
      process.env.CHAT_DEEP_TIMEOUT_MS = '-5000';
      expect(resolveChatTimeoutMs('standard', undefined)).toBe(600_000);
    });
  });
});

/**
 * The SSE consumer must never break out of the for-await while the pipeline is
 * still winding down: `break` calls generator.return(), which skips the
 * persistence + cost-record closure that ChatService does on its way out.
 * Repro: chat-e26df847 (2026-07-20) — answer streamed to the user, then the
 * 360s backstop aborted the run mid citation-repair. The turn was never saved
 * (conversation had 0 messages), cost_tracking stayed `pending`, and the client
 * got neither `complete` nor `cost_summary`, so the UI showed no chat id and no
 * cost and the chat was unreachable from the sidebar.
 */
describe('chat SSE consumption on abort', () => {
  type Harness = {
    handler: (req: any, res: any) => Promise<void>;
    events: Array<{ type: string; data: any }>;
    finalized: () => boolean;
    req: any;
  };

  function makeHarness(opts: { onIteration?: (i: number, req: any) => void } = {}): Harness {
    let didFinalize = false;
    const written: string[] = [];

    // Stands in for ChatService.chat(): streams a few events, then does its
    // persistence in a `finally` — exactly like the real pipeline.
    async function* fakeChat(request: any) {
      try {
        yield { type: 'conversation', data: { conversationId: 'conv-1' } };
        yield { type: 'answer_delta', data: { text: 'частина відповіді' } };
        opts.onIteration?.(1, request);
        yield { type: 'answer', data: { text: 'повна відповідь' } };
        yield { type: 'complete', data: { iterations: 3, elapsed_ms: 10, total_cost_usd: 1.44 } };
      } finally {
        didFinalize = true;
      }
    }

    const router = createChatInlineRoutes({
      chatService: { chat: fakeChat } as any,
      billingService: {
        getOrCreateUserBilling: async () => ({ billing_enabled: false }),
        getBillingSummary: async () => ({ balance_usd: 10 }),
      } as any,
      costTracker: { estimateCost: async () => ({ total_estimated_cost_usd: 0 }) } as any,
      db: { query: async () => ({ rows: [{ total_cost_usd: '1.60', markup_percentage: 10 }] }) } as any,
    });

    const layer = (router as any).stack.find(
      (l: any) => l.route?.path === '/' && l.route?.methods?.post
    );
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;

    const req: any = new EventEmitter();
    req.body = { query: 'позов до ТЦК', budget: 'standard' };
    req.user = { id: 'user-1' };

    const res: any = {
      writableEnded: false,
      setHeader: () => {},
      write: (chunk: string) => { written.push(chunk); return true; },
      end: () => { res.writableEnded = true; },
      status: () => res,
      json: () => res,
      headersSent: true,
    };

    const events = {
      get list() {
        const out: Array<{ type: string; data: any }> = [];
        for (let i = 0; i < written.length; i++) {
          const m = /^event: (.+)\n$/.exec(written[i]);
          if (m) {
            const d = /^data: (.*)\n\n$/s.exec(written[i + 1] || '');
            out.push({ type: m[1], data: d ? JSON.parse(d[1]) : null });
          }
        }
        return out;
      },
    };

    return {
      handler: () => handler(req, res),
      get events() { return events.list; },
      finalized: () => didFinalize,
      req,
    } as any;
  }

  it('lets the pipeline finalize and still reports chat id, complete and cost when the client stays connected', async () => {
    const h = makeHarness();
    await h.handler(h.req, null);

    const types = h.events.map(e => e.type);
    expect(h.finalized()).toBe(true);
    expect(types).toContain('conversation');
    expect(types).toContain('complete');
    expect(types).toContain('cost_summary');
    expect(h.events.find(e => e.type === 'conversation')?.data.conversationId).toBe('conv-1');
    expect(h.events.find(e => e.type === 'cost_summary')?.data.charged_usd).toBe(1.6);
  });

  it('emits the conversation id before the answer, so a run that dies late is still reachable', async () => {
    const h = makeHarness();
    await h.handler(h.req, null);

    const types = h.events.map(e => e.type);
    expect(types.indexOf('conversation')).toBeLessThan(types.indexOf('answer'));
    // response_id is the very first event — traceability before anything else.
    expect(types[0]).toBe('response_id');
  });

  it('drains the generator to completion after the client disconnects, but stops writing', async () => {
    // Disconnect mid-stream, from inside the generator — by then the route has
    // registered its 'close' listener, so the ordering is deterministic.
    const h = makeHarness({ onIteration: () => { h.req.emit('close'); } });
    await h.handler(h.req, null);

    // The pipeline must still have reached its `finally` — that is where the turn
    // is persisted and the billing record closed.
    expect(h.finalized()).toBe(true);
    // Nothing written past the disconnect.
    const types = h.events.map(e => e.type);
    expect(types).not.toContain('cost_summary');
  });
});
