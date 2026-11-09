// The collection jobs and the daemon that schedules them. Each job is resumable from
// public.pl_lawyers_crawl and idempotent (upserts only). Sources and politeness rules:
// docs/superpowers/specs/2026-11-08-attorney-crm-pl-design.md
import type { Queryable } from '../db';
import { Collector, HttpStatusError } from './http';
import { normalisePhone, statusFromRaw } from './normalise';
import { parseAdwokaciList, parseAdwokatDetail } from './parse-adwokaci';
import { parseRadcowieFragment } from './parse-radcowie';
import { parseCityPage, parseDirectoryProfile } from './parse-szukajradcy';
import { mapPracticeTag, nraLabelToCode } from '../tenant/pl-practices';
import { chamberCursors, chambers, clearChamberCursors, needsChambersRun } from './jobs-chambers';
import { ceidg } from './jobs-ceidg';
import {
  countByProfession, detailCandidates, findByEntryNumber, findUniqueByName, getCursor, markDetailFetched, markUnseen, setCursor, upsertLawyers,
  type LawyerUpsert, type MatchedLawyer, type Profession,
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

/** Below these a "complete" walk is not believed on a first run (register sizes, Nov 2026: 35.2K / 57.5K). */
const MIN_WALK_ROWS: Record<Profession, number> = { adwokat: 30_000, radca: 50_000 };

/**
 * A walk may mark the unseen rows only when it is plausible that it really saw the whole register:
 * at least 90% of what is stored, or the fixed minimum when nothing is stored yet. A 200 that is a
 * maintenance page, a WAF interstitial or a changed layout would otherwise flip everyone.
 */
export function plausibleWalk(profession: Profession, rowsSeen: number, stored: number): boolean {
  return stored > 0 ? rowsSeen >= Math.floor(stored * 0.9) : rowsSeen >= MIN_WALK_ROWS[profession];
}

/** A list walk is needed when it never completed or a walk is in progress (cursor has walkStartedAt, no completedAt). */
export function needsListWalk(cur: Record<string, unknown> | null): boolean {
  if (!cur) return true;
  if (typeof cur.walkStartedAt === 'string') return true;
  return typeof cur.completedAt !== 'string';
}

async function finishWalk(d: JobDeps, src: string, profession: Profession, rowsSeen: number, walkStartedAt: Date, newStatus: 'former' | 'inactive', extra: Record<string, unknown>): Promise<void> {
  const stored = await countByProfession(d.pool, profession);
  if (plausibleWalk(profession, rowsSeen, stored)) {
    const n = await markUnseen(d.pool, profession, walkStartedAt, newStatus);
    d.log(`[${src}] walk complete: ${rowsSeen} rows, ${n} marked ${newStatus}`);
    await setCursor(d.pool, src, { page: 1, ...extra, completedAt: now(d).toISOString(), rowsSeen });
  } else {
    d.log(`[${src}] walk complete but implausible (${rowsSeen} rows vs ${stored} stored): nobody marked ${newStatus}; check the register by hand`);
    await setCursor(d.pool, src, { page: 1, ...extra, completedAt: now(d).toISOString(), rowsSeen, unseenSkipped: true });
  }
}

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
  const resuming = typeof cur.walkStartedAt === 'string';
  let page = resuming && typeof cur.page === 'number' && cur.page >= 1 ? cur.page : 1;
  const walkStartedAt = resuming ? new Date(cur.walkStartedAt as string) : now(d);
  let lastPage: number | null = typeof cur.lastPage === 'number' ? cur.lastPage : null;
  let rowsSeen = resuming && typeof cur.rowsSeen === 'number' ? cur.rowsSeen : 0;
  let pages = 0;
  let rows = 0;
  for (;;) {
    const html = await d.http.get(`${HOSTS.adwokaci}/adwokat/list/strona/${page}`);
    const parsed = parseAdwokaciList(html);
    if (parsed.lastPage) lastPage = parsed.lastPage;
    if (parsed.rows.length === 0 && (lastPage === null || page <= lastPage)) {
      throw new Error(`[${SRC}] page ${page} parsed to zero rows (${html.length} bytes) before the last page ${lastPage ?? '?'}: not the end of the list`);
    }
    const seenAt = now(d);
    const n = await upsertLawyers(
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
    rows += n;
    rowsSeen += n;
    pages++;
    d.log(`[${SRC}] page ${page}/${lastPage ?? '?'}: ${parsed.rows.length} rows`);
    if (lastPage !== null && page >= lastPage) break;
    page++;
    await setCursor(d.pool, SRC, { page, lastPage, rowsSeen, walkStartedAt: walkStartedAt.toISOString() });
  }
  await finishWalk(d, SRC, 'adwokat', rowsSeen, walkStartedAt, 'former', { lastPage });
  return { pages, rows };
}

// ── adwokaci: profile details ──

export async function adwokaciDetails(d: JobDeps, o: { maxAgeDays: number; limit: number }): Promise<{ fetched: number; failed: number }> {
  const todo = await detailCandidates(d.pool, o.maxAgeDays, o.limit);
  let fetched = 0;
  let failed = 0;
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
    // One profile the parser or the database cannot take must not stop the queue: record it on
    // the row (so it is not retried every minute) and go on. Transport failures are thrown above.
    try {
    const det = parseAdwokatDetail(html);
    const codes = det.practices.map(nraLabelToCode).filter((x): x is string => x !== null);
    const phone = normalisePhone(det.phone) ?? det.phone;
    const phone2 = normalisePhone(det.phone2) ?? det.phone2;
    // the list walk owns the name (three clean columns); the store keeps stored values for blanks
    await upsertLawyers(
      d.pool,
      [{
        lawyerId: c.lawyerId,
        profession: 'adwokat',
        surname: '',
        givenNames: '',
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
        raw: { detail: { fetchedAt: now(d).toISOString(), name: det.name } },
      }],
      now(d),
      false,
    );
    fetched++;
    } catch (e) {
      failed++;
      const msg = (e as Error).message;
      d.log(`[adwokaci-details] ${c.lawyerId}: skipped, ${msg}`);
      await markDetailFetched(d.pool, c.lawyerId, { detailError: msg, at: now(d).toISOString() });
    }
  }
  if (fetched || failed) d.log(`[adwokaci-details] fetched ${fetched} profiles${failed ? `, ${failed} skipped with errors` : ''}`);
  return { fetched, failed };
}

// ── radcowie: list walk (POST fragment, 15 per page) ──

export async function radcowieList(d: JobDeps): Promise<{ pages: number; rows: number }> {
  const SRC = 'radcowie-list';
  const cur = (await getCursor(d.pool, SRC)) ?? {};
  const resuming = typeof cur.walkStartedAt === 'string';
  let page = resuming && typeof cur.page === 'number' && cur.page >= 1 ? cur.page : 1;
  const walkStartedAt = resuming ? new Date(cur.walkStartedAt as string) : now(d);
  let rowsSeen = resuming && typeof cur.rowsSeen === 'number' ? cur.rowsSeen : 0;
  let pages = 0;
  let rows = 0;
  let emptyStreak = 0;
  for (;;) {
    const html = await d.http.post(`${HOSTS.radcowie}/Home/GetDataW`, { nazwisko: '', imie: '', nrwpisu: '', districts: '0', cities: '0', stan: '0', page: String(page) });
    const parsed = parseRadcowieFragment(html);
    if (parsed.length === 0) {
      // the register answers a row-less fragment past the last page; two in a row ends the walk
      if (++emptyStreak >= 2) break;
    } else emptyStreak = 0;
    const n = await upsertLawyers(
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
    rows += n;
    rowsSeen += n;
    pages++;
    if (page % 100 === 0) d.log(`[${SRC}] page ${page}: ${rowsSeen} rows so far`);
    page++;
    await setCursor(d.pool, SRC, { page, rowsSeen, walkStartedAt: walkStartedAt.toISOString() });
  }
  // the end came too early to be the real end: a maintenance page or WAF answer with HTTP 200
  const stored = await countByProfession(d.pool, 'radca');
  if (!plausibleWalk('radca', rowsSeen, stored)) {
    throw new Error(`[${SRC}] walk ended early at page ${page} with ${rowsSeen} rows (${stored} stored): leaving the cursor for a retry`);
  }
  await finishWalk(d, SRC, 'radca', rowsSeen, walkStartedAt, 'inactive', {});
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
  // visited is intra-run resume state only: the next monthly run re-reads every profile
  await setCursor(d.pool, SRC, { completedAt: now(d).toISOString(), profiles, matched, unmatched });
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
  /** CEIDG: token (null disables the loop), radcowie per batch, days before a radca is asked about again */
  ceidgToken: string | null;
  ceidgBatch: number;
  ceidgRecheckDays: number;
}

const DEFAULT_SCHEDULE: Schedule = { tickMs: 60_000, detailBatch: 200, detailMaxAgeDays: 90, idleMs: 60_000, ceidgToken: null, ceidgBatch: 100, ceidgRecheckDays: 180 };

/**
 * The szukajradcy pass matches against the radca rows, so it waits for a completed radca list;
 * then it runs whenever it never ran or was interrupted. The monthly slot only clears its cursor.
 */
export function needsDirectoryRun(sz: Record<string, unknown> | null, radcowieList: Record<string, unknown> | null): boolean {
  if (!radcowieList || needsListWalk(radcowieList)) return false;
  return !sz || typeof sz.completedAt !== 'string';
}

/**
 * Runs probe once, then two independent loops:
 *  - registers: list walks (until the first completes, then weekly), then profile details in batches;
 *  - directory: the szukajradcy pass and the chamber sites (first run as soon as the radca list is complete, then monthly);
 *  - ceidg: with a token, practising radcowie still without a contact are looked up in CEIDG in batches
 *    (the client spaces requests under the 1,000/hour quota); without a token the loop is not started.
 * Every job is isolated: one that throws is logged and retried next tick, the others still run.
 */
export function daemon(d: JobDeps, schedule: Partial<Schedule> = {}): { stop: () => void; done: Promise<void> } {
  const s = { ...DEFAULT_SCHEDULE, ...schedule };
  let stopped = false;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const lastRun: Record<string, Date | null> = { lists: null, szukajradcy: null, chambers: null };
  const remember = () => setCursor(d.pool, 'daemon', Object.fromEntries(Object.entries(lastRun).map(([k, v]) => [k, v?.toISOString() ?? null])));
  const guarded = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      d.log(`[daemon] ${name} failed: ${(e as Error).message}; retrying in ${s.tickMs / 1000}s`);
      return null;
    }
  };

  const lists = async () => {
    const t = now(d);
    // A never-completed or interrupted walk continues on every tick (first start, a crash
    // mid-walk, a failure outside the Sunday slot); the slot only starts a fresh one.
    if (isDue('weekly', t, lastRun.lists)) {
      for (const src of ['adwokaci-list', 'radcowie-list']) {
        const c = await getCursor(d.pool, src);
        if (c && !needsListWalk(c)) await setCursor(d.pool, src, { page: 1 }); // forget completedAt → fresh walk
      }
      lastRun.lists = t;
      await remember();
    }
    if (needsListWalk(await getCursor(d.pool, 'adwokaci-list'))) await adwokaciList(d);
    if (needsListWalk(await getCursor(d.pool, 'radcowie-list'))) await radcowieList(d);
  };
  const registersLoop = async () => {
    while (!stopped) {
      const listsOk = (await guarded('lists', lists)) !== null;
      if (stopped) break;
      const det = await guarded('adwokaci-details', () => adwokaciDetails(d, { maxAgeDays: s.detailMaxAgeDays, limit: s.detailBatch }));
      if (stopped) break;
      if (!listsOk || det === null) await sleep(s.tickMs);
      else if (det.fetched === 0) await sleep(s.idleMs);
    }
  };
  const directoryLoop = async () => {
    while (!stopped) {
      await guarded('szukajradcy', async () => {
        const t = now(d);
        if (isDue('monthly', t, lastRun.szukajradcy)) {
          await setCursor(d.pool, 'szukajradcy', {});
          lastRun.szukajradcy = t;
          await remember();
        }
        if (needsDirectoryRun(await getCursor(d.pool, 'szukajradcy'), await getCursor(d.pool, 'radcowie-list'))) await szukajradcy(d);
      });
      if (stopped) break;
      await guarded('chambers', async () => {
        const t = now(d);
        if (isDue('monthly', t, lastRun.chambers)) {
          await clearChamberCursors(d);
          lastRun.chambers = t;
          await remember();
        }
        if (needsChambersRun(await chamberCursors(d), await getCursor(d.pool, 'radcowie-list'))) await chambers(d);
      });
      if (!stopped) await sleep(s.tickMs);
    }
  };
  const ceidgLoop = async () => {
    while (!stopped) {
      // the first run waits for the radca list, like the directory passes: the candidates come from it
      const listReady = !needsListWalk(await getCursor(d.pool, 'radcowie-list'));
      const r = listReady ? await guarded('ceidg', () => ceidg(d, { token: s.ceidgToken, limit: s.ceidgBatch, recheckDays: s.ceidgRecheckDays })) : null;
      if (stopped) break;
      await sleep(r && r.candidates > 0 ? s.tickMs : s.idleMs * 10);
    }
  };
  const loop = async () => {
    await probe(d);
    const cur = await getCursor(d.pool, 'daemon');
    for (const k of Object.keys(lastRun)) if (typeof cur?.[k] === 'string') lastRun[k] = new Date(cur[k] as string);
    const loops = [registersLoop(), directoryLoop()];
    if (s.ceidgToken) loops.push(ceidgLoop());
    else d.log('[ceidg] CEIDG_TOKEN not set: CEIDG enrichment is off');
    await Promise.all(loops);
  };
  const done = loop();
  return { stop: () => { stopped = true; }, done };
}

