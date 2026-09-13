/**
 * Adapter that wraps the node-redis client behind ICachePort.
 */

import { createClient } from 'redis';
import { logger } from '../../utils/logger.js';
import type { ICachePort } from '../../domain/ports/index.js';

type RedisClient = ReturnType<typeof createClient>;

// node-redis has no per-command timeout: a stale TCP connection makes commands hang until the
// OS read timeout fires (tens of seconds). Because this single client backs the rate limiter
// (in front of every /api/ route) plus many services, one dead socket stalls EVERY in-flight
// request. Bound each op so a hung Redis fails fast and callers degrade (rate limiter → memory)
// instead of holding the request open. The underlying command stays queued and runs on
// reconnect, which is harmless for our cache/counter usage.
//
// Redis itself replies in ~0.1ms, so this budget is NOT about Redis latency — it absorbs
// command-queue + event-loop lag on the single shared connection during heavy work (e.g. the
// chat agentic loop parsing large tool results). At 1000ms that lag produced spurious
// "Redis GET timed out" warnings on the hot path (LEXAI-1795); 2500ms clears them while still
// failing fast on a genuinely dead socket (which keepAlive/pingInterval also detect ~30s).
const REDIS_OP_TIMEOUT_MS = Number(process.env.REDIS_OP_TIMEOUT_MS || 2500);

// How many consecutive timeouts mean the socket is gone rather than busy. Three is past any
// plausible burst of slowness (that is 7.5s of nothing) and still well inside the ~15 minutes
// the kernel used to take to notice — see forceReconnect below.
const RECONNECT_AFTER_TIMEOUTS = Number(process.env.REDIS_RECONNECT_AFTER_TIMEOUTS || 3);

export class CacheAdapter implements ICachePort {
  private client: RedisClient;
  private consecutiveTimeouts = 0;
  private reconnecting = false;

  constructor(client: RedisClient) {
    this.client = client;
  }

  /**
   * Drop the socket ourselves when it stops answering.
   *
   * A TCP connection can die without anyone being told: on 2026-08-01 a deploy step re-attached
   * the running container to the docker network, its IP changed under the live process, and every
   * open socket became a black hole. Writes queued in the kernel (13,728 bytes stuck in tx_queue),
   * no RST or FIN came back, so node-redis never emitted an error, never ran its reconnect
   * strategy, and kept writing into it. Redis was healthy the whole time; a fresh client from the
   * same container answered in 1ms. Recovery only came when TCP keepalive gave up, about 15
   * minutes later, and until then every cache read cost the full timeout above and the rate
   * limiter ran on per-process memory.
   *
   * The deploy no longer does that (aliases are set at container creation), but a client that can
   * only be rescued by a kernel timer is a client with a hole in it. Consecutive timeouts are the
   * one signal available, since the socket itself reports nothing, so past the threshold we
   * destroy it and reconnect. destroy() rather than quit(): a graceful QUIT writes to the same
   * dead socket and waits for a reply that will never come.
   */
  private async forceReconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      logger.warn('[Cache] Redis unresponsive, dropping the socket and reconnecting', {
        consecutiveTimeouts: this.consecutiveTimeouts,
      });
      const client = this.client as unknown as { destroy?: () => void; disconnect?: () => Promise<void> };
      if (typeof client.destroy === 'function') {
        client.destroy();
      } else if (typeof client.disconnect === 'function') {
        await client.disconnect();
      }
      await this.client.connect();
      this.consecutiveTimeouts = 0;
      logger.info('[Cache] Redis reconnected');
    } catch (err) {
      // Leave the counter high so the next timeout tries again rather than waiting for a fresh
      // streak; node-redis reconnectStrategy also keeps retrying once the socket is really closed.
      logger.error('[Cache] Redis reconnect failed', { error: String(err) });
    } finally {
      this.reconnecting = false;
    }
  }

  private async withTimeout<T>(op: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        op,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Redis ${label} timed out after ${REDIS_OP_TIMEOUT_MS}ms`)),
            REDIS_OP_TIMEOUT_MS,
          );
        }),
      ]);
      this.consecutiveTimeouts = 0;
      return result;
    } catch (err) {
      if (err instanceof Error && err.message.includes('timed out after')) {
        this.consecutiveTimeouts += 1;
        if (this.consecutiveTimeouts >= RECONNECT_AFTER_TIMEOUTS) {
          // deliberately not awaited: the caller is already degrading to its fallback and must
          // not wait for a reconnect on top of the timeout it just paid
          void this.forceReconnect();
        }
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async get(key: string): Promise<string | null> {
    return this.withTimeout(this.client.get(key), 'GET');
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds !== undefined) {
      await this.withTimeout(this.client.setEx(key, ttlSeconds, value), 'SETEX');
    } else {
      await this.withTimeout(this.client.set(key, value), 'SET');
    }
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.withTimeout(this.client.del(keys), 'DEL');
  }

  /**
   * Счётчик с фиксированным окном: срок жизни выставляется при СОЗДАНИИ ключа и
   * больше не трогается.
   *
   * До 13.09.2026 здесь был `INCR` + безусловный `EXPIRE`, то есть срок жизни
   * переармировался на каждом запросе. Пока клиент приходит чаще, чем раз в
   * окно, ключ не истекает никогда, счётчик растёт без предела и однажды
   * пересекает лимит — после чего клиент получает 429 навсегда, каким бы низким
   * ни был его реальный темп. Двух запросов в минуту при окне 60 с и лимите 300
   * хватало за два с половиной часа: ровно так `/health` на legal.org.ua
   * заклинило на 489 запросах с TTL 31 с, и деплой перестал проходить
   * собственную проверку через nginx.
   *
   * `SET key 0 EX ttl NX` создаёт ключ со сроком жизни только если его ещё нет,
   * а `INCR` следом возвращает значение в текущем окне. Обе команды идут одной
   * транзакцией, так что параллельные запросы не могут проскочить между ними.
   * Версия Redis роли не играет, в отличие от `EXPIRE ... NX`, который есть
   * только с 7.0.
   */
  async increment(key: string, ttlSeconds: number): Promise<number> {
    const results = await this.withTimeout(
      this.client
        .multi()
        .set(key, '0', { EX: ttlSeconds, NX: true })
        .incr(key)
        .exec(),
      'INCR',
    );
    return (results?.[1] as unknown as number) ?? 0;
  }

  async ping(): Promise<boolean> {
    try {
      const reply = await this.withTimeout(this.client.ping(), 'PING');
      return reply === 'PONG';
    } catch {
      return false;
    }
  }

  isConnected(): boolean {
    return this.client.isOpen;
  }

  async connect(): Promise<void> {
    if (!this.client.isOpen) {
      await this.client.connect();
    }
  }

  async disconnect(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }
}
