import { PbxService, outcomeOf } from '../pbx/calls';
import type { AriClient, AriEvent } from '../pbx/ari';
import { EventHub, type PbxBrowserEvent } from '../pbx/hub';
import { ValidationError } from '../leads/repo';

type Row = Record<string, unknown>;

function fakePool() {
  const calls: { text: string; values?: unknown[] }[] = [];
  const handlers: ((text: string, values?: unknown[]) => Row[] | undefined)[] = [];
  return {
    calls,
    on: (h: (text: string, values?: unknown[]) => Row[] | undefined) => handlers.push(h),
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      for (const h of handlers) {
        const r = h(text, values);
        if (r) return { rows: r, rowCount: r.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function fakeAri(originateError?: Error) {
  const originated: unknown[] = [];
  const continued: string[] = [];
  const ari = {
    app: 'crm',
    originate: async (req: unknown) => {
      if (originateError) throw originateError;
      originated.push(req);
      return { id: (req as { channelId: string }).channelId };
    },
    continueInDialplan: async (id: string) => void continued.push(id),
  } as unknown as AriClient;
  return { ari, originated, continued };
}

function fakeHub() {
  const published: PbxBrowserEvent[] = [];
  const hub = { publish: (e: PbxBrowserEvent) => published.push(e) } as unknown as EventHub;
  return { hub, published };
}

const settings = { agents: { 'igor@legal.org.ua': 'igor-desk' }, noteUserEmail: 'vladimir@legal.org.ua', outboundContext: 'outbound', countryCode: '380' };
const user = { id: 7, email: 'vladimir@legal.org.ua' };
let noteIds = 0;
const noteInsert = (t: string) => (t.includes('INSERT INTO attorney_crm_notes') ? [{ id: ++noteIds }] : undefined);

test('agentFor uses the map, else the local part of the e-mail', () => {
  const svc = new PbxService(fakePool() as any, fakeAri().ari, fakeHub().hub, settings, () => {});
  expect(svc.agentFor('Igor@legal.org.ua')).toBe('igor-desk');
  expect(svc.agentFor('vladimir@legal.org.ua')).toBe('vladimir');
});

test('startOutbound writes the note, originates to the user agent with the dialable number, and publishes', async () => {
  const pool = fakePool();
  pool.on(noteInsert);
  const { ari, originated } = fakeAri();
  const { hub, published } = fakeHub();
  const svc = new PbxService(pool as any, ari, hub, settings, () => {});
  const r = await svc.startOutbound('42', '+38(050)500-51-34', user, 'Коваль Іван');
  expect(r.number).toBe('380505005134');
  expect(r.channelId).toMatch(/^crm-/);
  expect(pool.calls[0].text).toContain('INSERT INTO attorney_crm_notes');
  expect(pool.calls[0].values).toEqual(['42', 7, expect.stringContaining('Дзвінок через АТС на +380 50 500 51 34: з’єднуємо')]);
  expect(originated[0]).toMatchObject({ endpoint: 'PJSIP/vladimir', context: 'outbound', extension: '380505005134', channelId: r.channelId, callerId: '"Коваль Іван" <380505005134>' });
  expect(published[0]).toMatchObject({ type: 'call', status: 'ringing_agent', sourceId: '42' });
  expect(svc.active).toBe(1);
});

test('startOutbound rejects a number that cannot be dialled before touching ARI', async () => {
  const pool = fakePool();
  const { ari, originated } = fakeAri();
  const svc = new PbxService(pool as any, ari, fakeHub().hub, settings, () => {});
  await expect(svc.startOutbound('42', '044 12', user, 'X')).rejects.toBeInstanceOf(ValidationError);
  expect(originated).toHaveLength(0);
  expect(pool.calls).toHaveLength(0);
});

test('startOutbound marks the note failed and rethrows when ARI refuses', async () => {
  const pool = fakePool();
  pool.on(noteInsert);
  const { ari } = fakeAri(new Error('ARI POST /channels → 503'));
  const svc = new PbxService(pool as any, ari, fakeHub().hub, settings, () => {});
  await expect(svc.startOutbound('42', '0505005134', user, 'X')).rejects.toThrow('503');
  const upd = pool.calls.find((c) => c.text.startsWith('UPDATE attorney_crm_notes'));
  expect(upd?.values?.[1]).toContain('не вдалося з’єднати');
  expect(svc.active).toBe(0);
});

async function outboundCall(pool: ReturnType<typeof fakePool>, published: PbxBrowserEvent[], ari = fakeAri().ari) {
  pool.on(noteInsert);
  const svc = new PbxService(pool as any, ari, { publish: (e: PbxBrowserEvent) => published.push(e) } as unknown as EventHub, settings, () => {});
  const { channelId } = await svc.startOutbound('42', '0505005134', user, 'Коваль');
  return { svc, channelId };
}

test('outbound: agent answers, lawyer answers, hangup → note with duration, lead contacted, ended event', async () => {
  const pool = fakePool();
  const published: PbxBrowserEvent[] = [];
  const { svc, channelId } = await outboundCall(pool, published);
  const t0 = Date.parse('2026-11-11T10:00:00.000Z');
  const ts = (ms: number) => new Date(t0 + ms).toISOString();
  await svc.handleEvent({ type: 'ChannelStateChange', timestamp: ts(5000), channel: { id: channelId, state: 'Up' } });
  await svc.handleEvent({ type: 'Dial', timestamp: ts(6000), caller: { id: channelId }, peer: { id: 'x.1' }, dialstatus: '' });
  await svc.handleEvent({ type: 'Dial', timestamp: ts(20000), caller: { id: channelId }, peer: { id: 'x.1' }, dialstatus: 'ANSWER' });
  await svc.handleEvent({ type: 'ChannelDestroyed', timestamp: ts(212000), channel: { id: channelId, state: 'Up' }, cause: 16, cause_txt: 'Normal Clearing' });
  const upd = pool.calls.filter((c) => c.text.startsWith('UPDATE attorney_crm_notes'));
  expect(upd).toHaveLength(1);
  expect(upd[0].values).toEqual([noteIds, `Дзвінок через АТС на +380 50 500 51 34: розмова відбулася, 3 хв 12 с (id ${channelId})`]);
  expect(pool.calls.some((c) => c.text.includes("VALUES ($1, 'contacted', $2)") && c.values?.[0] === '42')).toBe(true);
  expect(published.map((p) => p.status)).toEqual(['ringing_agent', 'dialing', 'answered', 'ended']);
  expect(published[3]).toMatchObject({ outcome: 'answered', duration: '3 хв 12 с' });
  expect(svc.active).toBe(0);
});

test('outbound: busy lawyer → note says busy, lead untouched', async () => {
  const pool = fakePool();
  const published: PbxBrowserEvent[] = [];
  const { svc, channelId } = await outboundCall(pool, published);
  await svc.handleEvent({ type: 'ChannelStateChange', channel: { id: channelId, state: 'Up' } });
  await svc.handleEvent({ type: 'Dial', caller: { id: channelId }, dialstatus: 'BUSY' });
  await svc.handleEvent({ type: 'ChannelDestroyed', channel: { id: channelId }, cause: 17 });
  const upd = pool.calls.find((c) => c.text.startsWith('UPDATE attorney_crm_notes'));
  expect(upd?.values?.[1]).toBe(`Дзвінок через АТС на +380 50 500 51 34: зайнято (id ${channelId})`);
  expect(pool.calls.some((c) => c.text.includes("'contacted'"))).toBe(false);
});

test('outbound: operator never picks up → agent_no_answer', async () => {
  const pool = fakePool();
  const { svc, channelId } = await outboundCall(pool, []);
  await svc.handleEvent({ type: 'ChannelDestroyed', channel: { id: channelId }, cause: 19 });
  const upd = pool.calls.find((c) => c.text.startsWith('UPDATE attorney_crm_notes'));
  expect(upd?.values?.[1]).toContain('оператор не взяв слухавку');
});

test('events for unknown channels are ignored', async () => {
  const pool = fakePool();
  const svc = new PbxService(pool as any, fakeAri().ari, fakeHub().hub, settings, () => {});
  await svc.handleEvent({ type: 'ChannelDestroyed', channel: { id: '1731.5' } });
  expect(pool.calls).toHaveLength(0);
});

const lawyerRow = { source_id: '42', family_name: 'Коваль', first_name: 'Іван', patronymic: 'Петрович', city: 'Київ' };

test('inbound: continues the dialplan first, matches the caller, notes it as the configured user, pops the card', async () => {
  const pool = fakePool();
  noteIds = 100;
  pool.on(noteInsert);
  pool.on((t, v) => (t.includes("regexp_replace(COALESCE(x.phone, ''), '\\D', '', 'g') LIKE $1") && v?.[0] === '%505005134' ? [lawyerRow] : undefined));
  pool.on((t, v) => (t.includes('FROM attorney_crm_users WHERE email = $1') && v?.[0] === 'vladimir@legal.org.ua' ? [{ id: 9 }] : undefined));
  const { ari, continued } = fakeAri();
  const { hub, published } = fakeHub();
  const svc = new PbxService(pool as any, ari, hub, settings, () => {});
  const ev: AriEvent = { type: 'StasisStart', application: 'crm', args: ['inbound', '0505005134'], channel: { id: '1731.7', caller: { number: '0505005134' } } };
  await svc.handleEvent(ev);
  expect(continued).toEqual(['1731.7']);
  expect(pool.calls[0].text).toContain('regexp_replace'); // lookup after continue
  const ins = pool.calls.find((c) => c.text.includes('INSERT INTO attorney_crm_notes'));
  expect(ins?.values).toEqual(['42', 9, 'Вхідний дзвінок з +380 50 500 51 34: дзвонить (id 1731.7)']);
  expect(published[0]).toEqual({ type: 'inbound', channelId: '1731.7', number: '+380 50 500 51 34', advocate: { sourceId: '42', fullName: 'Коваль Іван Петрович', city: 'Київ' } });
  // the operator answers, then the caller hangs up
  await svc.handleEvent({ type: 'ChannelStateChange', timestamp: '2026-11-11T10:00:10.000Z', channel: { id: '1731.7', state: 'Up' } });
  await svc.handleEvent({ type: 'ChannelDestroyed', timestamp: '2026-11-11T10:00:55.000Z', channel: { id: '1731.7' } });
  const upd = pool.calls.find((c) => c.text.startsWith('UPDATE attorney_crm_notes'));
  expect(upd?.values).toEqual([101, 'Вхідний дзвінок з +380 50 500 51 34: розмова відбулася, 45 с (id 1731.7)']);
  expect(published.at(-1)).toMatchObject({ type: 'call', direction: 'inbound', status: 'ended', outcome: 'answered' });
});

test('inbound from an unknown number: still pops, no note; missed when nobody answers', async () => {
  const pool = fakePool();
  const { ari, continued } = fakeAri();
  const { hub, published } = fakeHub();
  const svc = new PbxService(pool as any, ari, hub, settings, () => {});
  await svc.handleEvent({ type: 'StasisStart', args: ['inbound', '+380671112233'], channel: { id: '1731.8' } });
  expect(continued).toEqual(['1731.8']);
  expect(published[0]).toEqual({ type: 'inbound', channelId: '1731.8', number: '+380 67 111 22 33', advocate: null });
  expect(pool.calls.some((c) => c.text.includes('INSERT INTO attorney_crm_notes'))).toBe(false);
  await svc.handleEvent({ type: 'ChannelDestroyed', channel: { id: '1731.8' } });
  expect(published.at(-1)).toMatchObject({ status: 'ended', outcome: 'missed' });
});

test('outcomeOf maps dial statuses', () => {
  const base = { direction: 'outbound' as const, channelId: 'c', number: '380', sourceId: null, noteId: null, userId: null, startedAt: 0, agentAnsweredAt: 1, answeredAt: null, dialStatus: null };
  expect(outcomeOf({ ...base, dialStatus: 'NOANSWER' })).toBe('no_answer');
  expect(outcomeOf({ ...base, dialStatus: 'CHANUNAVAIL' })).toBe('failed');
  expect(outcomeOf({ ...base, dialStatus: 'CANCEL' })).toBe('cancelled');
  expect(outcomeOf({ ...base, dialStatus: null })).toBe('cancelled');
  expect(outcomeOf({ ...base, agentAnsweredAt: null })).toBe('agent_no_answer');
  expect(outcomeOf({ ...base, answeredAt: 5 })).toBe('answered');
});
