// The four collection jobs and the daemon that schedules them. Each job is resumable from
// public.pl_lawyers_crawl and idempotent (upserts only). Sources and politeness rules:
// docs/superpowers/specs/2026-11-08-attorney-crm-pl-design.md
import type { Queryable } from '../db';
import { Collector, HttpStatusError } from './http';
import { normalisePhone, statusFromRaw } from './normalise';
import { parseAdwokaciList, parseAdwokatDetail } from './parse-adwokaci';
import { parseRadcowieFragment } from './parse-radcowie';
import { parseCityPage, parseDirectoryProfile } from './parse-szukajradcy';
import { mapPracticeTag, nraLabelToCode } from '../tenant/pl-practices';
import {
  detailCandidates, findByEntryNumber, findUniqueByName, getCursor, markDetailFetched, markUnseen, setCursor, upsertLawyers,
  type LawyerUpsert, type MatchedLawyer,
} from './store';

export interface JobDeps {
  pool: Queryable;
  http: Collector;
  log: (line: string) => void;
  now?: () => Date;
}

export const HOSTS = {
  adwokaci: 'https://rejestradwokatow.pl',
  radcowie: 'https://rejestrradcow.pl',
  szukajradcy: 'https://szukajradcy.pl',
} as const;

export const MIN_DELAY_MS: Record<string, number> = { 'rejestradwokatow.pl': 10_000, 'rejestrradcow.pl': 1_000, 'szukajradcy.pl': 2_000 };

const now = (d: JobDeps) => (d.now ?? (() => new Date()))();

// ── probe ──

export async function probe(d: JobDeps): Promise<{ host: string; status: number; ms: number }[]> {
  const targets = [`${HOSTS.adwokaci}/adwokat/list/strona/1`, `${HOSTS.radcowie}/`, `${HOSTS.szukajradcy}/`];
  const out: { host: string; status: number; ms: number }[] = [];
  for (const url of targets) {
    const host = new URL(url).host;
    const r = await d.http.probe(url);
    out.push({ host, ...r });
    d.log(`[probe] ${host} ${r.status} ${r.ms}ms`);
  }
  const bad = out.filter((r) => r.status === 0 || r.status >= 400);
  if (bad.length) throw new Error(`probe failed: ${bad.map((b) => `${b.host} ${b.status}`).join(', ')}`);
  return out;
}

// ── adwokaci: list walk ──

export async function adwokaciList(d: JobDeps): Promise<{ pages: number; rows: number }> {
  const SRC = 'adwokaci-list';
  const cur = (await getCursor(d.pool, SRC)) ?? {};
  let page = typeof cur.page === 'number' && cur.page >= 1 ? cur.page : 1;
  const walkStartedAt = typeof cur.walkStartedAt === 'string' ? new Date(cur.walkStartedAt) : now(d);
  let lastPage: number | null = typeof cur.lastPage === 'number' ? cur.lastPage : null;
  let pages = 0;
  let rows = 0;
  for (;;) {
    const html = await d.http.get(`${HOSTS.adwokaci}/adwokat/list/strona/${page}`);
    const parsed = parseAdwokaciList(html);
    if (parsed.lastPage) lastPage = parsed.lastPage;
    const seenAt = now(d);
    rows += await upsertLawyers(
      d.pool,
      parsed.rows.map<LawyerUpsert>((r) => ({
        lawyerId: `adw:${r.id}`,
        profession: 'adwokat',
        surname: r.surname,
        givenNames: r.givenNames,
        status: statusFromRaw('adwokat', r.statusRaw),
        statusRaw: r.statusRaw,
        chamber: r.chamber,
        city: r.city,
        profileUrl: r.profileUrl,
      })),
      seenAt,
    );
    pages++;
    d.log(`[adwokaci-list] page ${page}/${lastPage ?? '?'}: ${parsed.rows.length} rows`);
    if (parsed.rows.length === 0 || (lastPage !== null && page >= lastPage)) break;
    page++;
    await setCursor(d.pool, SRC, { page, lastPage, walkStartedAt: walkStartedAt.toISOString() });
  }
  const former = await markUnseen(d.pool, 'adwokat', walkStartedAt, 'former');
  d.log(`[adwokaci-list] walk complete: ${rows} rows, ${former} marked former`);
  await setCursor(d.pool, SRC, { page: 1, lastPage, completedAt: now(d).toISOString() });
  return { pages, rows };
}

// ── adwokaci: profile details ──

export async function adwokaciDetails(d: JobDeps, o: { maxAgeDays: number; limit: number }): Promise<{ fetched: number }> {
  const todo = await detailCandidates(d.pool, o.maxAgeDays, o.limit);
  let fetched = 0;
  for (const c of todo) {
    let html: string;
    try {
      html = await d.http.get(c.profileUrl);
    } catch (e) {
      if (e instanceof HttpStatusError) {
        await markDetailFetched(d.pool, c.lawyerId, { detailMissing: e.status, at: now(d).toISOString() });
        d.log(`[adwokaci-details] ${c.lawyerId}: HTTP ${e.status}, skipped`);
        continue;
      }
      throw e;
    }
    const det = parseAdwokatDetail(html);
    const codes = det.practices.map(nraLabelToCode).filter((x): x is string => x !== null);
    const phone = normalisePhone(det.phone) ?? det.phone;
    const phone2 = normalisePhone(det.phone2) ?? det.phone2;
    const [surname, ...given] = det.name.split(' ');
    await upsertLawyers(
      d.pool,
      [{
        lawyerId: c.lawyerId,
        profession: 'adwokat',
        surname: surname || c.lawyerId,
        givenNames: given.join(' '),
        status: statusFromRaw('adwokat', det.statusRaw ?? ''),
        statusRaw: det.statusRaw ?? '',
        city: det.city,
        postcode: det.postcode,
        address: det.address,
        officeName: det.officeName,
        phone,
        phone2,
        email: det.email,
        contactSource: phone || det.email ? 'register' : undefined,
        entryNumber: det.entryNumber,
        entryDate: det.entryDate,
        practices: codes,
        practiceTagsRaw: det.practices,
        detailFetched: true,
        raw: { detail: { fetchedAt: now(d).toISOString() } },
      }],
      now(d),
      false,
    );
    fetched++;
  }
  if (fetched) d.log(`[adwokaci-details] fetched ${fetched} profiles`);
  return { fetched };
}

// ── radcowie: list walk (POST fragment, 15 per page) ──

export async function radcowieList(d: JobDeps): Promise<{ pages: number; rows: number }> {
  const SRC = 'radcowie-list';
  const cur = (await getCursor(d.pool, SRC)) ?? {};
  let page = typeof cur.page === 'number' && cur.page >= 1 ? cur.page : 1;
  const walkStartedAt = typeof cur.walkStartedAt === 'string' ? new Date(cur.walkStartedAt) : now(d);
  let pages = 0;
  let rows = 0;
  let emptyStreak = 0;
  for (;;) {
    const html = await d.http.post(`${HOSTS.radcowie}/Home/GetDataW`, { nazwisko: '', imie: '', nrwpisu: '', districts: '0', cities: '0', stan: '0', page: String(page) });
    const parsed = parseRadcowieFragment(html);
    if (parsed.length === 0) {
      // the register answers an empty fragment past the last page; two in a row ends the walk
      if (++emptyStreak >= 2) break;
    } else emptyStreak = 0;
    rows += await upsertLawyers(
      d.pool,
      parsed.map<LawyerUpsert>((r) => ({
        lawyerId: `radca:${r.entryNumber}`,
        profession: 'radca',
        surname: r.surname,
        givenNames: r.givenNames,
        status: statusFromRaw('radca', r.statusRaw),
        statusRaw: r.statusRaw,
        chamber: r.chamber,
        city: r.city,
        entryNumber: r.entryNumber,
      })),
      now(d),
    );
    pages++;
    if (page % 100 === 0) d.log(`[radcowie-list] page ${page}: ${rows} rows so far`);
    page++;
    await setCursor(d.pool, SRC, { page, walkStartedAt: walkStartedAt.toISOString() });
  }
  const inactive = await markUnseen(d.pool, 'radca', walkStartedAt, 'inactive');
  d.log(`[radcowie-list] walk complete: ${pages} pages, ${rows} rows, ${inactive} marked inactive`);
  await setCursor(d.pool, SRC, { page: 1, completedAt: now(d).toISOString() });
  return { pages, rows };
}

// ── szukajradcy: contacts for radcowie via city pages ──

interface SzukajCursor {
  cities: string[];
  page: number;
  visited: string[];
  pageParamFor?: string;
}

async function sitemapCities(d: JobDeps): Promise<string[]> {
  const xml = await d.http.get(`${HOSTS.szukajradcy}/pages-sitemap.xml`);
  const locs = [...xml.matchAll(/<loc>\s*(https:\/\/szukajradcy\.pl\/radca-prawny-[^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/\/$/, ''));
  return [...new Set(locs)];
}

/** "Adam Krukowski" → candidates [{surname:'Krukowski', given:'Adam'}, {surname:'Adam', given:'Krukowski'}]. */
function nameCandidates(name: string): { surname: string; given: string }[] {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return [];
  return [
    { surname: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') },
    { surname: parts[0], given: parts.slice(1).join(' ') },
  ];
}

export async function szukajradcy(d: JobDeps): Promise<{ profiles: number; matched: number; unmatched: number }> {
  const SRC = 'szukajradcy';
  const saved = (await getCursor(d.pool, SRC)) as Partial<SzukajCursor> | null;
  const cur: SzukajCursor = {
    cities: Array.isArray(saved?.cities) ? saved!.cities! : await sitemapCities(d),
    page: typeof saved?.page === 'number' ? saved!.page! : 1,
    visited: Array.isArray(saved?.visited) ? saved!.visited! : [],
    pageParamFor: typeof saved?.pageParamFor === 'string' ? saved!.pageParamFor : undefined,
  };
  const visited = new Set(cur.visited);
  let profiles = 0;
  let matched = 0;
  let unmatched = 0;
  let sinceSave = 0;
  const save = async () => {
    cur.visited = [...visited];
    await setCursor(d.pool, SRC, cur as unknown as Record<string, unknown>);
    sinceSave = 0;
  };

  while (cur.cities.length) {
    const cityUrl = cur.cities[0];
    const url = cur.page > 1 ? `${cityUrl}?${cur.pageParamFor ?? 'page'}=${cur.page}` : cityUrl;
    let html: string;
    try {
      html = await d.http.get(url);
    } catch (e) {
      if (e instanceof HttpStatusError) {
        d.log(`[szukajradcy] ${url}: HTTP ${e.status}, city skipped`);
        cur.cities.shift();
        cur.page = 1;
        await save();
        continue;
      }
      throw e;
    }
    const city = parseCityPage(html);
    for (const profileUrl of city.profiles) {
      if (visited.has(profileUrl)) continue;
      visited.add(profileUrl);
      profiles++;
      let phtml: string;
      try {
        phtml = await d.http.get(profileUrl);
      } catch (e) {
        if (e instanceof HttpStatusError) continue;
        throw e;
      }
      const p = parseDirectoryProfile(phtml);
      let m: MatchedLawyer | null = p.entryNumber ? await findByEntryNumber(d.pool, p.entryNumber) : null;
      if (!m) {
        for (const c of nameCandidates(p.name)) {
          m = await findUniqueByName(d.pool, c.surname, c.given, p.city);
          if (m) break;
        }
      }
      if (!m) {
        unmatched++;
        d.log(`[szukajradcy] unmatched: ${p.name} (${p.entryNumber ?? 'no number'}) ${profileUrl}`);
      } else {
        matched++;
        const tags = p.tags;
        const codes = [...new Set(tags.map(mapPracticeTag).filter((x): x is string => x !== null))];
        const contacts = m.contactSource === 'register' ? {} : { phone: p.phone, email: p.email, website: p.website, address: p.address, officeName: p.officeName, contactSource: 'szukajradcy' as const };
        await upsertLawyers(
          d.pool,
          [{
            lawyerId: m.lawyerId,
            profession: 'radca',
            // name/status are COALESCE-free columns; re-send what the register has by leaving them to the next list walk:
            // the store overwrites surname/given_names/status with EXCLUDED, so pass the directory's values only when we have nothing better.
            surname: '',
            givenNames: '',
            status: 'active',
            statusRaw: '',
            ...contacts,
            practices: codes,
            practiceTagsRaw: tags,
            directoryUrl: profileUrl,
            raw: { szukajradcy: { fetchedAt: now(d).toISOString(), entryNumber: p.entryNumber, name: p.name } },
          }],
          now(d),
          false,
        );
      }
      if (++sinceSave >= 50) await save();
    }
    if (city.lastPage && cur.page < city.lastPage) {
      cur.page++;
      cur.pageParamFor = city.pageParam ?? undefined;
    } else {
      cur.cities.shift();
      cur.page = 1;
      cur.pageParamFor = undefined;
    }
    await save();
  }
  d.log(`[szukajradcy] done: ${profiles} profiles, ${matched} matched, ${unmatched} unmatched`);
  await setCursor(d.pool, SRC, { completedAt: now(d).toISOString(), visited: [...visited] });
  return { profiles, matched, unmatched };
}

// ── daemon ──

export type Cadence = 'weekly' | 'monthly';

const WARSAW = 'Europe/Warsaw';

function warsawParts(d: Date): { weekday: string; day: number; hour: number; ymd: string } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: WARSAW, weekday: 'short', day: 'numeric', hour: 'numeric', hour12: false, year: 'numeric', month: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { weekday: get('weekday'), day: Number(get('day')), hour: Number(get('hour')) % 24, ymd: `${get('year')}-${get('month')}-${get('day').padStart(2, '0')}` };
}

/** Weekly = Sunday 02:00–02:59 Warsaw; monthly = 1st 03:00–03:59 Warsaw; at most once per slot day. */
export function isDue(cadence: Cadence, at: Date, lastRun: Date | null): boolean {
  const p = warsawParts(at);
  const inSlot = cadence === 'weekly' ? p.weekday === 'Sun' && p.hour === 2 : p.day === 1 && p.hour === 3;
  if (!inSlot) return false;
  return !lastRun || warsawParts(lastRun).ymd !== p.ymd;
}

export interface Schedule {
  tickMs: number;
  detailBatch: number;
  detailMaxAgeDays: number;
  idleMs: number;
}

const DEFAULT_SCHEDULE: Schedule = { tickMs: 60_000, detailBatch: 200, detailMaxAgeDays: 90, idleMs: 60_000 };

/** Runs probe once, then lists weekly, szukajradcy monthly, and the details loop continuously. */
export function daemon(d: JobDeps, schedule: Partial<Schedule> = {}): { stop: () => void; done: Promise<void> } {
  const s = { ...DEFAULT_SCHEDULE, ...schedule };
  let stopped = false;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const lastRun: Record<string, Date | null> = { lists: null, szukajradcy: null };

  const loop = async () => {
    await probe(d);
    const cur = await getCursor(d.pool, 'daemon');
    for (const k of Object.keys(lastRun)) if (typeof cur?.[k] === 'string') lastRun[k] = new Date(cur[k] as string);
    const remember = () => setCursor(d.pool, 'daemon', Object.fromEntries(Object.entries(lastRun).map(([k, v]) => [k, v?.toISOString() ?? null])));
    // First start on an empty table: walk the lists right away instead of waiting for Sunday.
    const empty = (await d.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM public.pl_lawyers')).rows[0]?.n === 0;
    if (empty) {
      await adwokaciList(d);
      await radcowieList(d);
      lastRun.lists = now(d);
      await remember();
    }
    while (!stopped) {
      const t = now(d);
      try {
        if (isDue('weekly', t, lastRun.lists)) {
          await adwokaciList(d);
          await radcowieList(d);
          lastRun.lists = t;
          await remember();
        }
        if (isDue('monthly', t, lastRun.szukajradcy)) {
          await szukajradcy(d);
          lastRun.szukajradcy = t;
          await remember();
        }
        const { fetched } = await adwokaciDetails(d, { maxAgeDays: s.detailMaxAgeDays, limit: s.detailBatch });
        if (fetched === 0) await sleep(s.idleMs);
      } catch (e) {
        d.log(`[daemon] job failed: ${(e as Error).message}; retrying in ${s.tickMs / 1000}s`);
        await sleep(s.tickMs);
      }
    }
  };
  const done = loop();
  return { stop: () => { stopped = true; }, done };
}
