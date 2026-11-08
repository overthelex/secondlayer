import { importBounces, parseBounceLines, suppress, suppressedAmong, unsuppressManual } from '../mail/suppression';

function fakePool(rows: Record<string, unknown>[] = []) {
  const calls: { text: string; values?: unknown[] }[] = [];
  return {
    calls,
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return { rows, rowCount: rows.length };
    },
  };
}

const row = { email: 'a@b.ua', reason: 'bounce', source: 'cli', advocate_source_id: null, detail: null, created_at: new Date('2026-11-08') };

test('suppress normalises the address and upserts, letting unsubscribe override a weaker reason', async () => {
  const pool = fakePool([row]);
  const s = await suppress(pool as any, { email: ' A@B.UA ', reason: 'bounce', source: 'cli' });
  expect(pool.calls[0].text).toContain('INSERT INTO attorney_crm_suppression');
  expect(pool.calls[0].text).toContain("EXCLUDED.reason IN ('unsubscribe','complaint')");
  expect(pool.calls[0].values).toEqual(['a@b.ua', 'bounce', 'cli', null, null]);
  expect(s.email).toBe('a@b.ua');
  expect(s.createdAt).toBeInstanceOf(Date);
});

test('suppress refuses a non-address', async () => {
  const pool = fakePool();
  await expect(suppress(pool as any, { email: 'nope', reason: 'manual' })).rejects.toThrow('not an e-mail address');
  expect(pool.calls).toHaveLength(0);
});

test('suppressedAmong deduplicates, normalises and returns the blocked subset', async () => {
  const pool = fakePool([{ email: 'a@b.ua' }]);
  const blocked = await suppressedAmong(pool as any, ['A@B.UA', 'a@b.ua', 'c@d.ua']);
  expect(pool.calls[0].values).toEqual([['a@b.ua', 'c@d.ua']]);
  expect([...blocked]).toEqual(['a@b.ua']);
  expect(await suppressedAmong(pool as any, [])).toEqual(new Set());
});

test('unsuppressManual deletes only the team entry', async () => {
  const pool = fakePool();
  await unsuppressManual(pool as any, 'A@b.ua');
  expect(pool.calls[0].text).toContain("reason = 'manual'");
  expect(pool.calls[0].values).toEqual(['a@b.ua']);
});

test('parseBounceLines reads Postfix bounces, ignores deliveries and accepts bare lists / CSV', () => {
  const text = [
    'Nov  8 10:00:01 mail2 postfix/smtp[123]: ABC: to=<Dead@Example.UA>, relay=smtp.azurecomm.net[1.2.3.4]:587, delay=1, dsn=5.1.1, status=bounced (host said: 550 5.1.1 user unknown)',
    'Nov  8 10:00:02 mail2 postfix/smtp[123]: DEF: to=<alive@example.ua>, relay=smtp.azurecomm.net[1.2.3.4]:587, delay=1, dsn=2.0.0, status=sent (250 queued)',
    'Nov  8 10:00:03 mail2 postfix/smtp[124]: GHI: to=<slow@example.ua>, relay=none, delay=1209600, dsn=4.4.1, status=expired, returned to sender',
    'email,reason',
    'other@example.ua,HardBounce',
    '"quoted@example.ua"',
    'just some noise',
    '',
  ].join('\n');
  const parsed = parseBounceLines(text);
  expect(parsed.map((b) => b.email)).toEqual(['dead@example.ua', 'slow@example.ua', 'other@example.ua', 'quoted@example.ua']);
  expect(parsed[0].detail).toContain('550 5.1.1 user unknown');
  expect(parsed[1].detail.startsWith('expired')).toBe(true);
});

test('importBounces counts only addresses that were not listed before', async () => {
  const calls: { text: string; values?: unknown[] }[] = [];
  const known = new Set(['old@example.ua']);
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      if (text.startsWith('SELECT * FROM attorney_crm_suppression')) {
        return known.has(String(values?.[0])) ? { rows: [{ ...row, email: values?.[0] }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      known.add(String(values?.[0]));
      return { rows: [{ ...row, email: values?.[0], source: 'postfix-log' }], rowCount: 1 };
    },
  };
  const added = await importBounces(pool as any, [{ email: 'old@example.ua', detail: 'x' }, { email: 'new@example.ua', detail: 'y' }]);
  expect(added).toBe(1);
  expect(calls.filter((c) => c.text.startsWith('INSERT')).map((c) => c.values?.[1])).toEqual(['bounce', 'bounce']);
});
