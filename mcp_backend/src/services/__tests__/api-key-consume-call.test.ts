import { describe, it, expect, jest } from '@jest/globals';
import { ApiKeyService } from '../api-key-service.js';
import { apiKeyRefusalText } from '../../routes/mcp-sse-routes.js';

const dbWith = (query: (...a: any[]) => Promise<any>) => ({ query: jest.fn(query) }) as any;

describe('ApiKeyService.consumeCall', () => {
  it('passes the key to consume_api_key_call and returns its verdict', async () => {
    const db = dbWith(async () => ({ rows: [{ allowed: true, reason: 'OK', requestsToday: 4, rateLimitPerDay: 10000 }] }));
    const r = await new ApiKeyService(db).consumeCall('sl_key');
    expect(r).toEqual({ allowed: true, reason: 'OK', requestsToday: 4, rateLimitPerDay: 10000 });
    expect(db.query.mock.calls[0][0]).toContain('consume_api_key_call($1)');
    expect(db.query.mock.calls[0][1]).toEqual(['sl_key']);
  });

  it('fails closed when the check errors', async () => {
    const db = dbWith(async () => { throw new Error('db down'); });
    await expect(new ApiKeyService(db).consumeCall('sl_key')).resolves.toMatchObject({ allowed: false });
  });

  it('fails closed when the function returns no row', async () => {
    const db = dbWith(async () => ({ rows: [] }));
    await expect(new ApiKeyService(db).consumeCall('sl_key')).resolves.toMatchObject({ allowed: false });
  });
});

describe('apiKeyRefusalText', () => {
  it.each([
    ['Daily rate limit exceeded', 'денний ліміт'],
    ['Per-minute rate limit exceeded', 'за хвилину'],
    ['API key expired', 'термін дії'],
    ['Invalid or inactive API key', 'відключений'],
    ['anything else', 'не вдалося перевірити'],
  ])('%s → Ukrainian message', (reason, fragment) => {
    expect(apiKeyRefusalText(reason)).toContain(fragment);
  });
});
