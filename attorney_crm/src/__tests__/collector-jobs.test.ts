import fs from 'fs';
import path from 'path';
import { Collector } from '../collector/http';
import { upsertLawyers, markUnseen } from '../collector/store';
import { adwokaciList, probe, szukajradcy, isDue } from '../collector/jobs';

const fx = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures/pl', f), 'utf8');

type Route = (url: string, init: any) => { status: number; body?: string } | undefined;
function fakeHttp(route: Route) {
  const calls: { url: string; init: any }[] = [];
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const r = route(String(url), init) ?? { status: 404 };
    return new Response(r.body ?? '', { status: r.status });
  }) as unknown as typeof fetch;
  const http = new Collector({ userAgent: 'test', minDelayMs: {}, maxConsecutiveFailures: 5, fetchImpl: impl, sleep: async () => {}, now: () => 0 });
  return { http, calls };
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

test('upsert keeps the old phone when the new fetch has none', async () => {
  const pool = fakePool();
  await upsertLawyers(pool as any, [{ lawyerId: 'adw:1', profession: 'adwokat', surname: 'A', givenNames: 'B', status: 'active', statusRaw: 'Wykonujący zawód' }], new Date());
  const q = pool.calls[0];
  expect(q.text).toContain('INSERT INTO public.pl_lawyers');
  expect(q.text).toMatch(/phone\s*=\s*COALESCE\(EXCLUDED\.phone,\s*public\.pl_lawyers\.phone\)/);
  expect(q.values).toContain('adw:1');
});

test('upsert merges rows that share a lawyer id inside one batch (the radca register lists BŁ/1678 twice)', async () => {
  const pool = fakePool();
  const n = await upsertLawyers(pool as any, [
    { lawyerId: 'radca:BŁ/1678', profession: 'radca', surname: 'CZARNOMY', givenNames: 'EDYTA', status: 'inactive', statusRaw: 'Nie wykonuje zawodu', city: null, email: 'e@x.pl' },
    { lawyerId: 'radca:BŁ/1678', profession: 'radca', surname: 'CZARNOMYS', givenNames: 'EDYTA', status: 'inactive', statusRaw: 'Nie wykonuje zawodu', city: 'BIAŁYSTOK', email: null },
    { lawyerId: 'radca:BŁ/1679', profession: 'radca', surname: 'INNA', givenNames: 'ANNA', status: 'active', statusRaw: 'Wykonuje zawód' },
  ], new Date());
  expect(n).toBe(2);
  const q = pool.calls[0];
  expect((q.values ?? []).filter((v: unknown) => v === 'radca:BŁ/1678')).toHaveLength(1);
  // first row wins for a filled field, blanks are filled from the later duplicate
  expect(q.values).toContain('CZARNOMY');
  expect(q.values).not.toContain('CZARNOMYS');
  expect(q.values).toContain('BIAŁYSTOK');
  expect(q.values).toContain('e@x.pl');
});

test('markUnseen only touches rows not seen since the walk started', async () => {
  const pool = fakePool(() => []);
  const t = new Date('2026-11-08T00:00:00Z');
  await markUnseen(pool as any, 'adwokat', t, 'former');
  expect(pool.calls[0].text).toMatch(/UPDATE public\.pl_lawyers SET status = \$1/);
  expect(pool.calls[0].text).toContain('list_seen_at < $');
  expect(pool.calls[0].values).toEqual(expect.arrayContaining(['former', 'adwokat', t]));
});

test('adwokaciList walks from the cursor and marks unseen only after a full walk', async () => {
  const page = fx('adwokaci-list-page1.html').replace(/strona\/\d+/g, 'strona/2');
  const { http, calls } = fakeHttp((url) => (url.includes('/adwokat/list/strona/') ? { status: 200, body: page } : undefined));
  const walkStartedAt = '2026-11-01T00:00:00.000Z';
  // 100 stored, 100 seen in this (resumed) walk → plausible → unseen rows are marked
  const pool = fakePool((text) => {
    if (text.includes('FROM public.pl_lawyers_crawl')) return [{ cursor: { page: 2, walkStartedAt } }];
    if (text.includes('count(*)') && text.includes('profession = $1')) return [{ n: 100 }];
    return [];
  });
  const r = await adwokaciList({ pool: pool as any, http, log: () => {} });
  expect(calls.map((c) => c.url)).toEqual(['https://rejestradwokatow.pl/adwokat/list/strona/2']);
  expect(r).toEqual({ pages: 1, rows: 100 });
  const upd = pool.calls.find((c) => c.text.startsWith('UPDATE public.pl_lawyers SET status'));
  expect(upd?.values).toEqual(expect.arrayContaining(['former', 'adwokat', new Date(walkStartedAt)]));

  // a failing page: no UPDATE, cursor stays, error surfaces
  const bad = fakeHttp(() => ({ status: 500 }));
  const pool2 = fakePool((text) => (text.includes('FROM public.pl_lawyers_crawl') ? [{ cursor: { page: 1, walkStartedAt } }] : []));
  await expect(adwokaciList({ pool: pool2 as any, http: bad.http, log: () => {} })).rejects.toThrow();
  expect(pool2.calls.some((c) => c.text.startsWith('UPDATE public.pl_lawyers SET status'))).toBe(false);
});

test('szukajradcy matches by entry number and falls back to unique name', async () => {
  const profile1 = fx('szukajradcy-lawyer-adam-krukowski.html');
  const profile2 = profile1.replace(/WA-17979/g, 'XX-1').replace(/Adam Krukowski/g, 'Nobody Unknown').replace(/ADAM KRUKOWSKI/g, 'NOBODY UNKNOWN');
  const city = `<html><ul><li><a href="https://szukajradcy.pl/lawyers/adam-krukowski">x</a></li><li><a href="https://szukajradcy.pl/lawyers/nobody-unknown">y</a></li></ul></html>`;
  const sitemap = `<?xml version="1.0"?><urlset><url><loc>https://szukajradcy.pl/radca-prawny-katowice</loc></url><url><loc>https://szukajradcy.pl/artykuly</loc></url></urlset>`;
  const { http, calls } = fakeHttp((url) => {
    if (url.endsWith('/pages-sitemap.xml')) return { status: 200, body: sitemap };
    if (url.endsWith('/radca-prawny-katowice')) return { status: 200, body: city };
    if (url.endsWith('/lawyers/adam-krukowski')) return { status: 200, body: profile1 };
    if (url.endsWith('/lawyers/nobody-unknown')) return { status: 200, body: profile2 };
    return undefined;
  });
  const pool = fakePool((text, values) => {
    if (text.includes('FROM public.pl_lawyers_crawl')) return [];
    if (text.includes('WHERE entry_number = $1')) return values?.[0] === 'WA-17979' ? [{ lawyer_id: 'radca:WA-17979', contact_source: null }] : [];
    if (text.includes('upper(surname)')) return [];
    return [];
  });
  const r = await szukajradcy({ pool: pool as any, http, log: () => {} });
  expect(r).toEqual({ profiles: 2, matched: 1, unmatched: 1 });
  expect(calls.some((c) => c.url.includes('/search'))).toBe(false);
  const up = pool.calls.find((c) => c.text.includes('INSERT INTO public.pl_lawyers ('));
  expect(up?.values).toEqual(expect.arrayContaining(['radca:WA-17979', 'kancelaria@krukowski.legal', 'szukajradcy', 'https://szukajradcy.pl/lawyers/adam-krukowski']));
  expect(up?.values).toEqual(expect.arrayContaining([expect.arrayContaining(['public_procurement', 'civil', 'labour'])]));
  expect(pool.calls.filter((c) => c.text.includes('INSERT INTO public.pl_lawyers ('))).toHaveLength(1);
  // enrichment must not overwrite the register's name or status with blanks
  expect(up?.text).toMatch(/surname = COALESCE\(NULLIF\(EXCLUDED\.surname, ''\), public\.pl_lawyers\.surname\)/);
  expect(up?.text).toMatch(/status = CASE WHEN COALESCE\(NULLIF\(EXCLUDED\.status_raw, ''\), ''\) = '' AND public\.pl_lawyers\.status_raw <> '' THEN public\.pl_lawyers\.status/);
  expect(pool.calls.some((c) => c.text.includes('upper(surname)') && c.values?.[0] === 'Unknown')).toBe(true);
});

test('probe throws on a 403', async () => {
  const { http } = fakeHttp((url) => (url.includes('rejestrradcow.pl') ? { status: 403 } : { status: 200, body: 'ok' }));
  await expect(probe({ pool: fakePool() as any, http, log: () => {} })).rejects.toThrow(/rejestrradcow\.pl 403/);
});

test('isDue: weekly Sunday 02:00 Warsaw and monthly 1st 03:00, once per slot', () => {
  const sun = new Date('2026-11-08T01:30:00Z'); // Sunday 02:30 Warsaw (CET)
  expect(isDue('weekly', sun, null)).toBe(true);
  expect(isDue('weekly', sun, new Date('2026-11-08T01:05:00Z'))).toBe(false);
  expect(isDue('weekly', new Date('2026-11-09T01:30:00Z'), null)).toBe(false);
  expect(isDue('monthly', new Date('2026-12-01T02:10:00Z'), null)).toBe(true);
  expect(isDue('monthly', new Date('2026-12-01T02:10:00Z'), new Date('2026-12-01T02:05:00Z'))).toBe(false);
  expect(isDue('monthly', new Date('2026-12-02T02:10:00Z'), null)).toBe(false);
});

// ---- final review fix pass (2026-11-08) ----
import { adwokaciDetails, radcowieList, needsListWalk, plausibleWalk } from '../collector/jobs';
import { findUniqueByName } from '../collector/store';

test('a list walk whose row count is implausibly low does not mark anyone unseen', async () => {
  // adwokaci: every page parses fine but the register "shrank" to 100 rows while 35K are stored
  const page = fx('adwokaci-list-page1.html').replace(/strona\/\d+/g, 'strona/1');
  const { http } = fakeHttp((url) => (url.includes('/adwokat/list/strona/') ? { status: 200, body: page } : undefined));
  const pool = fakePool((text) => {
    if (text.includes('FROM public.pl_lawyers_crawl')) return [];
    if (text.includes('count(*)') && text.includes('profession = $1')) return [{ n: 35000 }];
    return [];
  });
  const r = await adwokaciList({ pool: pool as any, http, log: () => {} });
  expect(r.rows).toBe(100);
  expect(pool.calls.some((c) => c.text.startsWith('UPDATE public.pl_lawyers SET status'))).toBe(false);
  const final = pool.calls.filter((c) => c.text.includes('pl_lawyers_crawl') && c.text.startsWith('INSERT')).pop();
  expect(String(final?.values?.[1])).toContain('"unseenSkipped":true');
});

test('a 200 that parses to zero rows before the last page is a failure, not the end of the list', async () => {
  const first = fx('adwokaci-list-page1.html').replace(/strona\/\d+/g, 'strona/3');
  let n = 0;
  const { http } = fakeHttp((url) => {
    if (!url.includes('/adwokat/list/strona/')) return undefined;
    n++;
    return { status: 200, body: n === 1 ? first : '<html><body>Przerwa techniczna</body></html>' };
  });
  const pool = fakePool((text) => (text.includes('FROM public.pl_lawyers_crawl') ? [] : []));
  await expect(adwokaciList({ pool: pool as any, http, log: () => {} })).rejects.toThrow(/zero rows/);
  expect(pool.calls.some((c) => c.text.startsWith('UPDATE public.pl_lawyers SET status'))).toBe(false);
});

test('radcowie walk that ends after too few rows throws instead of marking everyone inactive', async () => {
  const frag = fx('radcowie-getdataw-stan0-page1.html');
  let n = 0;
  const { http } = fakeHttp((url) => (url.endsWith('/Home/GetDataW') ? { status: 200, body: ++n <= 2 ? frag : '<html>maintenance</html>' } : undefined));
  const pool = fakePool((text) => {
    if (text.includes('FROM public.pl_lawyers_crawl')) return [];
    if (text.includes('count(*)') && text.includes('profession = $1')) return [{ n: 57000 }];
    return [];
  });
  await expect(radcowieList({ pool: pool as any, http, log: () => {} })).rejects.toThrow(/ended early/);
  expect(pool.calls.some((c) => c.text.startsWith('UPDATE public.pl_lawyers SET status'))).toBe(false);
});

test('plausibleWalk: 90% of the stored count, or the fixed minimum on a first run', () => {
  expect(plausibleWalk('adwokat', 100, 35000)).toBe(false);
  expect(plausibleWalk('adwokat', 32000, 35000)).toBe(true);
  expect(plausibleWalk('adwokat', 31000, 0)).toBe(true);
  expect(plausibleWalk('adwokat', 1000, 0)).toBe(false);
  expect(plausibleWalk('radca', 52000, 0)).toBe(true);
  expect(plausibleWalk('radca', 1000, 57000)).toBe(false);
});

test('adwokaciDetails never sends a name (the list walk owns it)', async () => {
  const { http } = fakeHttp((url) => (url.includes('/adwokat/') ? { status: 200, body: fx('adwokat-adamczyk-andrzej-42384.html') } : undefined));
  const pool = fakePool((text) => (text.includes('ORDER BY (status = \'active\') DESC') ? [{ lawyer_id: 'adw:42384', profile_url: 'https://rejestradwokatow.pl/adwokat/adamczyk-andrzej-42384' }] : []));
  const r = await adwokaciDetails({ pool: pool as any, http, log: () => {} }, { maxAgeDays: 90, limit: 10 });
  expect(r.fetched).toBe(1);
  const up = pool.calls.find((c) => c.text.includes('INSERT INTO public.pl_lawyers ('));
  expect(up?.values?.slice(0, 4)).toEqual(['adw:42384', 'adwokat', '', '']);
  expect(up?.values).toEqual(expect.arrayContaining(['WAW/Adw/4', '+48601355341', 'adw.adamczyk@gmail.com', 'register']));
});

test('needsListWalk: never run, or started and not completed → true; completed → false', () => {
  expect(needsListWalk(null)).toBe(true);
  expect(needsListWalk({ page: 5, walkStartedAt: '2026-11-01T00:00:00Z' })).toBe(true);
  expect(needsListWalk({ page: 1, completedAt: '2026-11-01T03:00:00Z' })).toBe(false);
});

test('szukajradcy clears the visited set when the run completes so the next run refreshes', async () => {
  const city = `<html><a href="https://szukajradcy.pl/lawyers/adam-krukowski">x</a></html>`;
  const sitemap = `<urlset><url><loc>https://szukajradcy.pl/radca-prawny-katowice</loc></url></urlset>`;
  const { http } = fakeHttp((url) => {
    if (url.endsWith('/pages-sitemap.xml')) return { status: 200, body: sitemap };
    if (url.endsWith('/radca-prawny-katowice')) return { status: 200, body: city };
    if (url.endsWith('/lawyers/adam-krukowski')) return { status: 200, body: fx('szukajradcy-lawyer-adam-krukowski.html') };
    return undefined;
  });
  const pool = fakePool((text, values) => (text.includes('WHERE entry_number = $1') ? [{ lawyer_id: 'radca:WA-17979', contact_source: null }] : []));
  await szukajradcy({ pool: pool as any, http, log: () => {} });
  const final = pool.calls.filter((c) => c.text.startsWith('INSERT INTO public.pl_lawyers_crawl')).pop();
  const cur = JSON.parse(String(final?.values?.[1]));
  expect(cur.completedAt).toBeTruthy();
  expect(cur.visited ?? []).toEqual([]);
});

test('findUniqueByName: unique nationwide matches; several → only an exact city match; NULL city never wins by default', async () => {
  const rows = [
    { lawyer_id: 'radca:A', contact_source: null, city: 'WARSZAWA' },
    { lawyer_id: 'radca:B', contact_source: null, city: null },
  ];
  const two = fakePool((text) => (text.includes('upper(surname)') ? rows : []));
  expect(await findUniqueByName(two as any, 'Kowalski', 'Jan', 'Katowice')).toBeNull();
  expect((await findUniqueByName(two as any, 'Kowalski', 'Jan', 'Warszawa'))?.lawyerId).toBe('radca:A');
  const one = fakePool((text) => (text.includes('upper(surname)') ? [rows[0]] : []));
  expect((await findUniqueByName(one as any, 'Kowalski', 'Jan', 'Katowice'))?.lawyerId).toBe('radca:A');
  expect(two.calls[0].text).not.toMatch(/city IS NULL/);
});

import { daemon, needsDirectoryRun } from '../collector/jobs';

const ADAMCZYK = 'https://rejestradwokatow.pl/adwokat/adamczyk-andrzej-42384';

test('one profile the database rejects is skipped and recorded; the rest of the batch goes on', async () => {
  const { http } = fakeHttp((url) => (url.includes('/adwokat/') ? { status: 200, body: fx('adwokat-adamczyk-andrzej-42384.html') } : undefined));
  const pool = fakePool((text, values) => {
    if (text.includes('ORDER BY (status = \'active\') DESC')) return [{ lawyer_id: 'adw:1', profile_url: `${ADAMCZYK}?a` }, { lawyer_id: 'adw:2', profile_url: `${ADAMCZYK}?b` }];
    if (text.includes('INSERT INTO public.pl_lawyers (') && values?.[0] === 'adw:1') throw new Error('date/time field value out of range: "0000-00-00"');
    return [];
  });
  const logs: string[] = [];
  const r = await adwokaciDetails({ pool: pool as any, http, log: (m) => logs.push(m) }, { maxAgeDays: 90, limit: 10 });
  expect(r).toEqual({ fetched: 1, failed: 1 });
  const mark = pool.calls.find((c) => c.text.startsWith('UPDATE public.pl_lawyers SET detail_fetched_at') && c.values?.[0] === 'adw:1');
  expect(String(mark?.values?.[1])).toContain('detailError');
  expect(logs.join('\n')).toMatch(/adw:1.*out of range/);
});

test('needsDirectoryRun: only after the radca list is complete, and until the directory pass completes', () => {
  const listDone = { page: 1, completedAt: '2026-11-09T02:11:22Z' };
  expect(needsDirectoryRun(null, listDone)).toBe(true); // never ran: start without waiting for the monthly slot
  expect(needsDirectoryRun({ cities: ['x'], page: 3 }, listDone)).toBe(true); // interrupted: continue
  expect(needsDirectoryRun({ completedAt: '2026-11-09T09:00:00Z' }, listDone)).toBe(false);
  expect(needsDirectoryRun(null, { page: 40, walkStartedAt: '2026-11-09T00:00:00Z' })).toBe(false); // nothing to match against yet
  expect(needsDirectoryRun(null, null)).toBe(false);
});

const TUESDAY = () => new Date('2026-11-10T12:00:00Z');
const DONE = { page: 1, completedAt: '2026-11-09T02:00:00Z' };

test('daemon: a failing list walk does not starve the details job', async () => {
  const { http } = fakeHttp((url) => {
    if (url.endsWith('/adwokat/list/strona/7')) return { status: 200, body: '<html>maintenance</html>' };
    if (url.includes('/adwokat/list/')) return { status: 200, body: fx('adwokaci-list-page1.html') };
    if (url.includes('/adwokat/')) return { status: 200, body: fx('adwokat-adamczyk-andrzej-42384.html') };
    return { status: 200, body: 'ok' };
  });
  let served = false;
  let h: { stop: () => void; done: Promise<void> } | undefined;
  const pool = fakePool((text, values) => {
    if (text.includes('FROM public.pl_lawyers_crawl')) {
      if (values?.[0] === 'adwokaci-list') return [{ cursor: { page: 7, lastPage: 352, walkStartedAt: '2026-11-09T00:00:00Z' } }];
      if (values?.[0] === 'radcowie-list') return [{ cursor: DONE }];
      if (values?.[0] === 'szukajradcy') return [{ cursor: { completedAt: '2026-11-09T09:00:00Z' } }];
      return [];
    }
    if (text.includes('ORDER BY (status = \'active\') DESC')) {
      if (served) return [];
      served = true;
      return [{ lawyer_id: 'adw:42384', profile_url: ADAMCZYK }];
    }
    if (text.includes('INSERT INTO public.pl_lawyers (')) h?.stop();
    return [];
  });
  h = daemon({ pool: pool as any, http, log: () => {}, now: TUESDAY }, { tickMs: 1, idleMs: 1 });
  const guard = setTimeout(() => h?.stop(), 1500);
  await h.done;
  clearTimeout(guard);
  expect(pool.calls.some((c) => c.text.includes('INSERT INTO public.pl_lawyers (') && c.values?.[0] === 'adw:42384')).toBe(true);
});

test('daemon: the directory pass starts by itself once the radca list is complete (no monthly slot needed)', async () => {
  let h: { stop: () => void; done: Promise<void> } | undefined;
  const { http, calls } = fakeHttp((url) => {
    if (url.endsWith('/pages-sitemap.xml')) { h?.stop(); return { status: 200, body: '<urlset></urlset>' }; }
    if (url.includes('/adwokat/list/')) return { status: 200, body: fx('adwokaci-list-page1.html') };
    return { status: 200, body: 'ok' };
  });
  const pool = fakePool((text, values) => {
    if (text.includes('FROM public.pl_lawyers_crawl')) {
      if (values?.[0] === 'adwokaci-list' || values?.[0] === 'radcowie-list') return [{ cursor: DONE }];
      return []; // no szukajradcy cursor, no daemon cursor
    }
    return [];
  });
  h = daemon({ pool: pool as any, http, log: () => {}, now: TUESDAY }, { tickMs: 1, idleMs: 1 });
  const guard = setTimeout(() => h?.stop(), 1500);
  await h.done;
  clearTimeout(guard);
  expect(calls.some((c) => c.url.endsWith('/pages-sitemap.xml'))).toBe(true);
});
