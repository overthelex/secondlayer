import fs from 'fs';
import path from 'path';
import { Collector } from '../collector/http';
import { chambers, needsChambersRun, CHAMBER_SOURCES } from '../collector/jobs-chambers';

const fx = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures/pl', f), 'utf8');

type Route = (url: string) => { status: number; body?: string } | undefined;
function fakeHttp(route: Route) {
  const calls: string[] = [];
  const impl = (async (url: any) => {
    calls.push(String(url));
    const r = route(String(url)) ?? { status: 404 };
    return new Response(r.body ?? '', { status: r.status });
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
    upserts: () => calls.filter((c) => c.text.includes('INSERT INTO public.pl_lawyers (')),
  };
}

const onePage = (html: string) => html.replace(/Strona 1 z \d+/, 'Strona 1 z 1');

test('Kraków radca cards attach by KR number; cards without contacts are not written', async () => {
  const { http, calls } = fakeHttp((url) => (url === 'https://oirp.krakow.pl/radcy/?page=1' ? { status: 200, body: onePage(fx('oirp-krakow-radcy-page1.html')) } : undefined));
  const pool = fakePool((text, values) => {
    if (text.includes('FROM public.pl_lawyers_crawl')) return [];
    if (text.includes('WHERE entry_number = $1')) return values?.[0] === 'KR-1363' ? [{ lawyer_id: 'radca:KR-1363', contact_source: null }] : [];
    return [];
  });
  const r = await chambers({ pool: pool as any, http, log: () => {} }, { only: ['krakow-radcy'] });
  expect(calls).toEqual(['https://oirp.krakow.pl/radcy/?page=1']);
  expect(r['krakow-radcy']).toEqual({ seen: 10, withContact: 1, matched: 1 });
  const ups = pool.upserts();
  expect(ups).toHaveLength(1);
  expect(ups[0].values).toEqual(expect.arrayContaining(['radca:KR-1363', '+48124112277', 'a.adamczyk@adamczyk-law.pl', 'chamber']));
  // the pass is recorded as complete
  const cur = pool.calls.filter((c) => c.text.includes('INSERT INTO public.pl_lawyers_crawl')).pop();
  expect(cur?.values?.[0]).toBe('chamber:krakow-radcy');
  expect(String(cur?.values?.[1])).toContain('completedAt');
});

test('Kraków firm cards: one-person firms match by name inside the chamber, partnerships are skipped', async () => {
  const { http } = fakeHttp((url) => (url === 'https://oirp.krakow.pl/kancelarie/?page=1' ? { status: 200, body: onePage(fx('oirp-krakow-kancelarie-page1.html')) } : undefined));
  const pool = fakePool((text, values) => {
    if (text.includes('FROM public.pl_lawyers_crawl')) return [];
    if (text.includes('upper(surname) = upper($1)') && values?.[0] === 'Poprawa' && values?.[1] === 'Anna') return [{ lawyer_id: 'radca:KR-1', contact_source: null, status: 'active' }];
    return [];
  });
  const r = await chambers({ pool: pool as any, http, log: () => {} }, { only: ['krakow-kancelarie'] });
  expect(r['krakow-kancelarie']?.matched).toBe(1);
  const up = pool.upserts()[0];
  expect(up.values).toEqual(expect.arrayContaining(['radca:KR-1', 'chamber', 'Anna Poprawa Kancelaria Radcy Prawnego']));
  // the chamber name is always passed to the name lookup
  expect(pool.calls.some((c) => c.text.includes('upper(surname) = upper($1)') && c.values?.[2] === 'OIRP KRAKÓW')).toBe(true);
  // "Spółka" cards never reach the name lookup
  expect(pool.calls.some((c) => c.values?.includes('Strzelec-Gwóźdź'))).toBe(false);
});

test('Opole: the firm page is fetched only for matched firms and adds the e-mail', async () => {
  const list = fx('oirp-opole-kancelarie-page1.html').replace(/class="page-link"([^>]*)>(2|61)</g, 'class="page-link"$1>1<');
  const detail = fx('oirp-opole-kancelarie-10.html').replace(/(<p class="text-sm text-gray-400">Email<\/p>\s*<p class="font-bold">)\s*-\s*(<\/p>)/, '$1 biuro@lesniewski.example $2');
  expect(detail).toContain('biuro@lesniewski.example');
  const { http, calls } = fakeHttp((url) => {
    if (url === 'https://oirp.opole.pl/kancelarie?page=1') return { status: 200, body: list };
    if (url === 'https://oirp.opole.pl/kancelarie/3') return { status: 200, body: detail };
    return undefined;
  });
  const pool = fakePool((text, values) => {
    if (text.includes('FROM public.pl_lawyers_crawl')) return [];
    if (text.includes('upper(surname) = upper($1)') && values?.[0] === 'Leśniewski') return [{ lawyer_id: 'radca:OP-3', contact_source: null, status: 'active' }];
    return [];
  });
  const r = await chambers({ pool: pool as any, http, log: () => {} }, { only: ['opole'] });
  expect(calls).toEqual(['https://oirp.opole.pl/kancelarie?page=1', 'https://oirp.opole.pl/kancelarie/3']);
  expect(r.opole?.matched).toBe(1);
  expect(pool.upserts()[0].values).toEqual(expect.arrayContaining(['radca:OP-3', '+48784022308', 'biuro@lesniewski.example']));
});

test('Zielona Góra: loose entry key first, then the printed name', async () => {
  const { http } = fakeHttp((url) => (url === 'https://zielonagora.oirp.pl/lista-kancelarii/' ? { status: 200, body: fx('zielonagora-oirp-lista-kancelarii.html') } : undefined));
  const pool = fakePool((text, values) => {
    if (text.includes('FROM public.pl_lawyers_crawl')) return [];
    if (text.includes("regexp_replace(upper(entry_number)")) return values?.[1] === 'ZGZG500' ? [{ lawyer_id: 'radca:ZG/ZG/500', contact_source: null }] : [];
    if (text.includes('upper(surname) = upper($1)') && values?.[0] === 'Kunt' && values?.[1] === 'Łukasz') return [{ lawyer_id: 'radca:ZG/G/397', contact_source: 'szukajradcy', status: 'active' }];
    return [];
  });
  const r = await chambers({ pool: pool as any, http, log: () => {} }, { only: ['zielonagora'] });
  expect(r.zielonagora).toEqual({ seen: 6, withContact: 6, matched: 2 });
  const ids = pool.upserts().map((u) => (u.values as unknown[]).find((v) => String(v).startsWith('radca:')));
  expect(ids).toEqual(['radca:ZG/G/397', 'radca:ZG/ZG/500']);
  expect(pool.calls.some((c) => c.text.includes('regexp_replace(upper(entry_number)') && c.values?.[0] === 'OIRP ZIELONA GÓRA')).toBe(true);
});

test('Szczecin: tiles then firm pages for matches; Rzeszów and Olsztyn: single documents', async () => {
  const { http, calls } = fakeHttp((url) => {
    if (url === 'https://oirp.szczecin.pl/listy/lista-kancelarii/') return { status: 200, body: fx('oirp-szczecin-lista-kancelarii.html') };
    if (url === 'https://oirp.szczecin.pl/kancelaria/pawel-kowalski-radca-prawny/') return { status: 200, body: fx('oirp-szczecin-kancelaria-pawel-kowalski.html') };
    if (url === 'https://www.oirp.rzeszow.pl/json/kancelaria.json') return { status: 200, body: fx('oirp-rzeszow-kancelaria.json') };
    if (url === 'https://oirp.olsztyn.pl/radcowie/lista-kancelarii/') return { status: 200, body: fx('oirp-olsztyn-kancelarie.html') };
    return undefined;
  });
  const pool = fakePool((text, values) => {
    if (text.includes('FROM public.pl_lawyers_crawl')) return [];
    if (text.includes('upper(surname) = upper($1)')) {
      if (values?.[0] === 'Kowalski' && values?.[1] === 'Paweł') return [{ lawyer_id: 'radca:SZ-1', contact_source: null, status: 'active' }];
      if (values?.[0] === 'Kostecka-Szyndak') return [{ lawyer_id: 'radca:RZ-1', contact_source: null, status: 'active' }];
      if (values?.[0] === 'Lewicka') return [{ lawyer_id: 'radca:OL-1', contact_source: null, status: 'active' }];
    }
    return [];
  });
  const r = await chambers({ pool: pool as any, http, log: () => {} }, { only: ['szczecin', 'rzeszow', 'olsztyn'] });
  expect(calls.filter((u) => u.includes('/kancelaria/'))).toEqual(['https://oirp.szczecin.pl/kancelaria/pawel-kowalski-radca-prawny/']);
  expect(r.szczecin?.matched).toBe(1);
  expect(r.rzeszow).toEqual({ seen: 6, withContact: 5, matched: 1 });
  expect(r.olsztyn?.matched).toBe(1);
  const vals = pool.upserts().flatMap((u) => u.values as unknown[]);
  expect(vals).toEqual(expect.arrayContaining(['radca:SZ-1', 'pkowalski@pk-radcaprawny.pl', 'https://pk-radcaprawny.pl', 'radca:RZ-1', 'anna.kostecka-szyndak@o2.pl', 'radca:OL-1', '+48897622204', '+48606829381']));
  // specialities of the Szczecin page are mapped where the taxonomy knows them
  expect(vals.some((v) => Array.isArray(v) && (v as string[]).includes('labour'))).toBe(true);
});

test('a source that already completed is skipped; an HTTP failure of one source does not stop the others', async () => {
  const { http, calls } = fakeHttp((url) => (url.includes('rzeszow') ? { status: 404 } : url.includes('olsztyn') ? { status: 200, body: fx('oirp-olsztyn-kancelarie.html') } : undefined));
  const pool = fakePool((text, values) => {
    if (text.includes('FROM public.pl_lawyers_crawl')) return values?.[0] === 'chamber:szczecin' ? [{ cursor: { completedAt: '2026-11-01T00:00:00Z' } }] : [];
    return [];
  });
  const log: string[] = [];
  const r = await chambers({ pool: pool as any, http, log: (l) => log.push(l) }, { only: ['szczecin', 'rzeszow', 'olsztyn'] });
  expect(calls.some((u) => u.includes('szczecin'))).toBe(false);
  expect(r.rzeszow).toBeNull();
  expect(r.olsztyn?.seen).toBe(7);
  expect(log.some((l) => /\[chamber:rzeszow\] failed/.test(l))).toBe(true);
});

test('needsChambersRun waits for the radca list and runs while any source is incomplete', () => {
  const done = { completedAt: '2026-11-01T00:00:00Z' };
  const all = Object.fromEntries(CHAMBER_SOURCES.map((s) => [s, done]));
  expect(needsChambersRun(all, null)).toBe(false);
  expect(needsChambersRun(all, { page: 3, walkStartedAt: 'x' })).toBe(false);
  expect(needsChambersRun(all, done)).toBe(false);
  expect(needsChambersRun({ ...all, opole: null }, done)).toBe(true);
  expect(needsChambersRun({ ...all, opole: { page: 7 } }, done)).toBe(true);
});
