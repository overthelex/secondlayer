import { Collector } from '../collector/http';
import { ceidg, pickFirm, CEIDG_HOST } from '../collector/jobs-ceidg';

type Route = (url: string, init: any) => { status: number; body?: string } | undefined;
function fakeHttp(route: Route) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    const r = route(String(url), init) ?? { status: 404 };
    return new Response(r.status === 204 ? null : r.body ?? '', { status: r.status });
  }) as unknown as typeof fetch;
  return { http: new Collector({ userAgent: 'test', minDelayMs: {}, maxConsecutiveFailures: 5, fetchImpl: impl, sleep: async () => {}, now: () => 0 }), calls };
}
function fakePool(route: (text: string, values?: unknown[]) => Record<string, unknown>[] | undefined = () => undefined) {
  const calls: { text: string; values?: unknown[] }[] = [];
  return {
    calls,
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      const rows = route(text, values) ?? [];
      return { rows, rowCount: rows.length };
    },
  };
}

const firm = (id: string, imie: string, nazwisko: string, miasto: string) => ({ id, nazwa: `${imie} ${nazwisko} Kancelaria`, status: 'AKTYWNY', wlasciciel: { imie, nazwisko, nip: '0000000000' }, adresDzialalnosci: { miasto, kod: '30-001', ulica: 'Długa', budynek: '1' } });

test('pickFirm: one hit with the same name wins; several hits need the register city; a different name never matches', () => {
  const a = firm('a', 'LUCYNA', 'RYŁKO', 'KRAKÓW');
  const b = firm('b', 'LUCYNA', 'RYŁKO', 'WARSZAWA');
  expect(pickFirm([a], 'RYŁKO', 'LUCYNA', 'KRAKÓW')).toBe(a);
  expect(pickFirm([a], 'RYŁKO', 'LUCYNA MARIA', 'KRAKÓW')).toBe(a);
  expect(pickFirm([a, b], 'RYŁKO', 'LUCYNA', 'Kraków')).toBe(a);
  expect(pickFirm([a, b], 'RYŁKO', 'LUCYNA', null)).toBeNull();
  expect(pickFirm([a, b], 'RYŁKO', 'LUCYNA', 'GDAŃSK')).toBeNull();
  expect(pickFirm([firm('c', 'ANNA', 'RYŁKO', 'KRAKÓW')], 'RYŁKO', 'LUCYNA', 'KRAKÓW')).toBeNull();
});

test('ceidg: list by name with the bearer token, one firm page per match, e-mail stored, every candidate marked as checked', async () => {
  const list1 = JSON.stringify({ firmy: [firm('f1', 'LUCYNA', 'RYŁKO', 'KRAKÓW')], count: 1 });
  const detail1 = JSON.stringify({ firma: [{ ...firm('f1', 'LUCYNA', 'RYŁKO', 'KRAKÓW'), email: 'L.Rylko@example.pl', telefon: '601 000 000', www: 'rylko.example.pl', pkdGlowny: { kod: '6910Z' } }] });
  const { http, calls } = fakeHttp((url) => {
    if (url.startsWith(`${CEIDG_HOST}/api/ceidg/v3/firmy?`) && url.includes('nazwisko=RY%C5%81KO')) return { status: 200, body: list1 };
    if (url.startsWith(`${CEIDG_HOST}/api/ceidg/v3/firmy?`)) return { status: 204 };
    if (url === `${CEIDG_HOST}/api/ceidg/v3/firma/f1`) return { status: 200, body: detail1 };
    return undefined;
  });
  const pool = fakePool((text) => {
    if (text.includes('FROM public.pl_lawyers') && text.includes('ceidg')) {
      return [
        { lawyer_id: 'radca:KR-1', surname: 'RYŁKO', given_names: 'LUCYNA', city: 'KRAKÓW' },
        { lawyer_id: 'radca:KR-2', surname: 'WILK', given_names: 'KRZYSZTOF', city: 'KRAKÓW' },
      ];
    }
    return [];
  });
  const r = await ceidg({ pool: pool as any, http, log: () => {} }, { token: 'tok', limit: 50 });
  expect(r).toEqual({ candidates: 2, found: 1, withContact: 1 });
  expect(calls.map((c) => c.url)).toEqual([
    `${CEIDG_HOST}/api/ceidg/v3/firmy?nazwisko=RY%C5%81KO&imie=LUCYNA&pkd=6910Z&status=AKTYWNY&limit=10`,
    `${CEIDG_HOST}/api/ceidg/v3/firma/f1`,
    `${CEIDG_HOST}/api/ceidg/v3/firmy?nazwisko=WILK&imie=KRZYSZTOF&pkd=6910Z&status=AKTYWNY&limit=10`,
  ]);
  expect(calls.every((c) => c.headers.authorization === 'Bearer tok')).toBe(true);
  const up = pool.calls.find((c) => c.text.includes('INSERT INTO public.pl_lawyers ('));
  expect(up?.values).toEqual(expect.arrayContaining(['radca:KR-1', 'l.rylko@example.pl', '+48601000000', 'rylko.example.pl', 'ceidg']));
  // both candidates get a ceidg.checkedAt so they are not asked again this half-year: the hit inside its upsert, the miss with found:false
  expect((up?.values as unknown[]).some((v) => typeof v === 'string' && v.includes('"ceidg"') && v.includes('"checkedAt"'))).toBe(true);
  const marks = pool.calls.filter((c) => c.text.startsWith('UPDATE public.pl_lawyers SET raw = raw ||'));
  expect(marks.map((m) => m.values?.[0])).toEqual(['radca:KR-2']);
  expect(String(marks[0].values?.[1])).toContain('"found":false');
});

test('ceidg: a second given name is dropped for the query; no token means no requests', async () => {
  const { http, calls } = fakeHttp(() => ({ status: 204 }));
  const pool = fakePool((text) => (text.includes('ceidg') && text.includes('FROM public.pl_lawyers') ? [{ lawyer_id: 'radca:WA-1', surname: 'CYWIŃSKA', given_names: 'BEATA ANNA', city: 'WARSZAWA' }] : []));
  await ceidg({ pool: pool as any, http, log: () => {} }, { token: 'tok', limit: 10 });
  expect(calls[0].url).toContain('nazwisko=CYWI%C5%83SKA&imie=BEATA&');
  const none = fakeHttp(() => ({ status: 204 }));
  const r = await ceidg({ pool: fakePool() as any, http: none.http, log: () => {} }, { token: null, limit: 10 });
  expect(r).toEqual({ candidates: 0, found: 0, withContact: 0 });
  expect(none.calls).toHaveLength(0);
});
