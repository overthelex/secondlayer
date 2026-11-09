import request from 'supertest';
import { createApp } from '../server';
import { LoginRateLimit } from '../auth/rate-limit';
import { loadTenant } from '../tenant';
import { deliveryOutcome, hookKey, hookKeyMatches, parseAcsEvents, DELIVERY_EVENT, VALIDATION_EVENT } from '../mail/acs-events';

type Row = Record<string, unknown>;

function fakePool(fail = false) {
  const calls: { text: string; values?: unknown[] }[] = [];
  return {
    calls,
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      if (text.includes('INSERT INTO attorney_crm_suppression')) {
        if (fail) throw new Error('db down');
        return { rows: [{ email: values?.[0], reason: values?.[1], source: values?.[2], advocate_source_id: null, detail: values?.[4], created_at: new Date() } as Row], rowCount: 1 };
      }
      return { rows: [] as Row[], rowCount: 0 };
    },
  };
}

const config = {
  port: 0, databaseUrl: 'x', sessionSecret: 'secret', derivationLagDays: 30, derivationBatch: 2000, derivationEnabled: false, tenant: loadTenant({}),
  publicUrl: 'https://attorney.legal.org.ua', smtpUrl: null, mailFrom: 'v@legal.org.ua', replyTo: null, unsubscribeMailbox: 'unsubscribe@legal.org.ua',
};
const app = (pool: ReturnType<typeof fakePool>) => createApp({ pool: pool as any, config, rateLimit: new LoginRateLimit() });
const key = hookKey('secret');

const report = (recipient: string, status: string, statusMessage = '', sender = 'vladimir@legal.org.ua') => ({
  id: '1', topic: '/subscriptions/x', subject: `sender/${sender}/message/abc`, eventType: DELIVERY_EVENT, eventTime: '2026-11-09T12:00:00Z', dataVersion: '1.0',
  data: { sender, recipient, messageId: 'abc', status, deliveryStatusDetails: { statusMessage }, deliveryAttemptTimeStamp: '2026-11-09T12:00:00Z' },
});

const inserts = (pool: ReturnType<typeof fakePool>) => pool.calls.filter((c) => c.text.includes('INSERT INTO attorney_crm_suppression'));

test('the hook key is derived from the secret and compared in full', () => {
  expect(key).toMatch(/^[0-9a-f]{40}$/);
  expect(hookKey('other')).not.toBe(key);
  expect(hookKeyMatches('secret', key)).toBe(true);
  expect(hookKeyMatches('secret', key.slice(0, 39))).toBe(false);
  expect(hookKeyMatches('secret', undefined)).toBe(false);
  expect(hookKeyMatches('secret', ['x'])).toBe(false);
});

test('parseAcsEvents reads Event Grid batches and single CloudEvents, and drops junk', () => {
  expect(parseAcsEvents([report('a@b.ua', 'Bounced'), null, 'x', {}])).toHaveLength(1);
  expect(parseAcsEvents({ type: DELIVERY_EVENT, data: { recipient: 'a@b.ua' } })).toEqual([{ type: DELIVERY_EVENT, data: { recipient: 'a@b.ua' } }]);
  expect(parseAcsEvents('nope')).toEqual([]);
});

test('deliveryOutcome maps statuses to suppression reasons', () => {
  const of = (status: string, msg = '') => deliveryOutcome(parseAcsEvents([report('Dead@Example.UA', status, msg)])[0], 'legal.org.ua');
  expect(of('Bounced', '550 5.1.1 user unknown')).toEqual({ email: 'dead@example.ua', status: 'Bounced', reason: 'bounce', detail: 'Bounced: 550 5.1.1 user unknown' });
  expect(of('Suppressed')?.reason).toBe('bounce');
  expect(of('FilteredSpam')?.reason).toBe('complaint');
  expect(of('Quarantined')?.reason).toBe('complaint');
  expect(of('Delivered')?.reason).toBeNull();
  expect(of('Failed')?.reason).toBeNull();
  expect(of('Expanded')?.reason).toBeNull();
});

test('deliveryOutcome ignores other sender domains, other events and malformed reports', () => {
  const foreign = parseAcsEvents([report('a@b.ua', 'Bounced', '', 'vladimir@lawrider.uk')])[0];
  expect(deliveryOutcome(foreign, 'legal.org.ua')).toBeNull();
  expect(deliveryOutcome({ type: 'Microsoft.Communication.SMSReceived', data: {} }, 'legal.org.ua')).toBeNull();
  expect(deliveryOutcome({ type: DELIVERY_EVENT, data: { sender: 'v@legal.org.ua', status: 'Bounced' } }, 'legal.org.ua')).toBeNull();
});

test('POST /hooks/acs-events without the key is 401 and touches nothing', async () => {
  const pool = fakePool();
  const res = await request(app(pool)).post('/hooks/acs-events').send([report('a@b.ua', 'Bounced')]);
  expect(res.status).toBe(401);
  expect((await request(app(pool)).post('/hooks/acs-events').set('x-acs-hook-key', 'wrong').send([])).status).toBe(401);
  expect(pool.calls).toHaveLength(0);
});

test('the Event Grid validation handshake echoes the code', async () => {
  const pool = fakePool();
  const res = await request(app(pool))
    .post('/hooks/acs-events')
    .set('x-acs-hook-key', key)
    .set('aeg-event-type', 'SubscriptionValidation')
    .send([{ id: '1', eventType: VALIDATION_EVENT, data: { validationCode: 'ABC-123', validationUrl: 'https://example' } }]);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ validationResponse: 'ABC-123' });
  expect(pool.calls).toHaveLength(0);
});

test('a batch suppresses bounces and spam verdicts, and leaves delivered and foreign mail alone', async () => {
  const pool = fakePool();
  const res = await request(app(pool))
    .post('/hooks/acs-events')
    .set('x-acs-hook-key', key)
    .send([
      report('ok@example.ua', 'Delivered'),
      report('Dead@Example.ua', 'Bounced', '550 5.1.1 user unknown'),
      report('spam@example.ua', 'FilteredSpam'),
      report('later@example.ua', 'Failed', 'timeout'),
      report('other@example.uk', 'Bounced', '', 'vladimir@lawrider.uk'),
    ]);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ received: 5, reports: 4, suppressed: 2 });
  expect(inserts(pool).map((c) => c.values)).toEqual([
    ['dead@example.ua', 'bounce', 'acs-event', null, 'Bounced: 550 5.1.1 user unknown'],
    ['spam@example.ua', 'complaint', 'acs-event', null, 'FilteredSpam'],
  ]);
});

test('the key is also accepted as ?key= and the body may arrive as application/cloudevents+json', async () => {
  const pool = fakePool();
  const res = await request(app(pool))
    .post(`/hooks/acs-events?key=${key}`)
    .set('Content-Type', 'application/cloudevents-batch+json')
    .send(JSON.stringify([{ type: DELIVERY_EVENT, data: { sender: 'vladimir@legal.org.ua', recipient: 'dead@example.ua', status: 'Bounced' } }]));
  expect(res.status).toBe(200);
  expect(res.body.suppressed).toBe(1);
});

test('a database failure answers 500 so Event Grid redelivers the batch', async () => {
  const pool = fakePool(true);
  const res = await request(app(pool)).post('/hooks/acs-events').set('x-acs-hook-key', key).send([report('dead@example.ua', 'Bounced')]);
  expect(res.status).toBe(500);
});

test('the webhook needs no session (sits before requireLogin)', async () => {
  const res = await request(app(fakePool())).post('/hooks/acs-events').set('x-acs-hook-key', key).send([]);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ received: 0, reports: 0, suppressed: 0 });
});
