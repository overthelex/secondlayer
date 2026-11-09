// Contacts of radcowie from the six regional chamber (OIRP) sites that publish them; see parse-chambers.ts
// for the sources. Each source has its own cursor (chamber:<source>) and is resumable; a source that fails
// is logged and left for the next tick, the others still run. Matching is always confined to the chamber:
// by entry number where the site prints one (Kraków radcy, Zielona Góra), else by the person's name inside
// the chamber's register rows. A firm with several names is never attached to anyone.
import type { JobDeps } from './jobs';
import { HttpStatusError } from './http';
import { normaliseEntryNumber } from './normalise';
import {
  looseEntryKey, parseKrakowKancelarie, parseKrakowRadcy, parseOlsztynKancelarie, parseOpoleDetail, parseOpoleList,
  parseRzeszowJson, parseSzczecinDetail, parseSzczecinList, parseZielonaGoraKancelarie, personFromOfficeName,
} from './parse-chambers';
import { mapPracticeTag } from '../tenant/pl-practices';
import { findByEntryNumber, findByLooseEntryKey, findUniqueByNameInChamber, getCursor, setCursor, upsertLawyers, type MatchedLawyer } from './store';

export const CHAMBER_HOSTS = {
  krakow: 'https://oirp.krakow.pl',
  olsztyn: 'https://oirp.olsztyn.pl',
  opole: 'https://oirp.opole.pl',
  zielonagora: 'https://zielonagora.oirp.pl',
  szczecin: 'https://oirp.szczecin.pl',
  rzeszow: 'https://www.oirp.rzeszow.pl',
} as const;

/** None of the six publishes a Crawl-delay; 3 s is a tenth of what a visitor clicking through would do. */
export const CHAMBER_MIN_DELAY_MS: Record<string, number> = {
  'oirp.krakow.pl': 3_000, 'oirp.olsztyn.pl': 3_000, 'oirp.opole.pl': 3_000, 'zielonagora.oirp.pl': 3_000, 'oirp.szczecin.pl': 3_000, 'oirp.rzeszow.pl': 3_000,
};

export type ChamberSource = 'krakow-radcy' | 'krakow-kancelarie' | 'olsztyn' | 'opole' | 'zielonagora' | 'szczecin' | 'rzeszow';
export const CHAMBER_SOURCES: ChamberSource[] = ['krakow-radcy', 'krakow-kancelarie', 'olsztyn', 'opole', 'zielonagora', 'szczecin', 'rzeszow'];

export interface SourceStats { seen: number; withContact: number; matched: number }

const CHAMBER: Record<ChamberSource, string> = {
  'krakow-radcy': 'OIRP KRAKÓW', 'krakow-kancelarie': 'OIRP KRAKÓW', olsztyn: 'OIRP OLSZTYN', opole: 'OIRP OPOLE', zielonagora: 'OIRP ZIELONA GÓRA', szczecin: 'OIRP SZCZECIN', rzeszow: 'OIRP RZESZÓW',
};

const now = (d: JobDeps) => (d.now ?? (() => new Date()))();
const cursorKey = (src: ChamberSource) => `chamber:${src}`;

interface Contacts {
  phone?: string | null; phone2?: string | null; email?: string | null; website?: string | null;
  address?: string | null; postcode?: string | null; city?: string | null; officeName?: string | null;
}
const hasContact = (c: Contacts) => !!(c.phone || c.email || c.website);

/** Fill-only upsert of what the chamber site knows; the store keeps register/szukajradcy values where present. */
async function attach(d: JobDeps, src: ChamberSource, m: MatchedLawyer, c: Contacts, tags: string[], url: string): Promise<void> {
  const codes = [...new Set(tags.map(mapPracticeTag).filter((x): x is string => x !== null))];
  await upsertLawyers(
    d.pool,
    [{
      lawyerId: m.lawyerId,
      profession: 'radca',
      surname: '',
      givenNames: '',
      status: 'active',
      statusRaw: '',
      phone: c.phone ?? null,
      phone2: c.phone2 ?? null,
      email: c.email ?? null,
      website: c.website ?? null,
      address: c.address ?? null,
      postcode: c.postcode ?? null,
      city: c.city ?? null,
      officeName: c.officeName ?? null,
      contactSource: 'chamber',
      practices: codes,
      practiceTagsRaw: tags,
      raw: { [cursorKey(src)]: { fetchedAt: now(d).toISOString(), url, officeName: c.officeName ?? null } },
    }],
    now(d),
    false,
  );
}

/** Name as the sites print it ("Agata ADAMCZYK", "Paweł Kowalski"): the surname is last; try the other order too. */
function nameOrders(name: string): { surname: string; givenNames: string }[] {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return [];
  return [
    { surname: parts[parts.length - 1], givenNames: parts.slice(0, -1).join(' ') },
    { surname: parts[0], givenNames: parts.slice(1).join(' ') },
  ];
}

async function byNames(d: JobDeps, chamber: string, cands: { surname: string; givenNames: string }[]): Promise<MatchedLawyer | null> {
  for (const c of cands) {
    const m = await findUniqueByNameInChamber(d.pool, c.surname, c.givenNames, chamber);
    if (m) return m;
  }
  return null;
}

type PagedCursor = { page?: number; seen?: number; withContact?: number; matched?: number; completedAt?: string };

async function paged(d: JobDeps, src: ChamberSource, url: (page: number) => string, handle: (html: string) => Promise<{ lastPage: number | null; stats: SourceStats }>): Promise<SourceStats> {
  const cur = ((await getCursor(d.pool, cursorKey(src))) ?? {}) as PagedCursor;
  let page = typeof cur.page === 'number' && cur.page >= 1 ? cur.page : 1;
  const stats: SourceStats = { seen: cur.seen ?? 0, withContact: cur.withContact ?? 0, matched: cur.matched ?? 0 };
  for (;;) {
    const html = await d.http.get(url(page));
    const r = await handle(html);
    stats.seen += r.stats.seen;
    stats.withContact += r.stats.withContact;
    stats.matched += r.stats.matched;
    if (r.stats.seen === 0 && r.lastPage !== null && page < r.lastPage) throw new Error(`[${cursorKey(src)}] page ${page}/${r.lastPage} parsed to zero cards (${html.length} bytes): layout changed?`);
    if (r.lastPage === null || page >= r.lastPage) break;
    page++;
    await setCursor(d.pool, cursorKey(src), { page, ...stats });
  }
  return stats;
}

// ── the seven sources ──

async function krakowRadcy(d: JobDeps): Promise<SourceStats> {
  const src: ChamberSource = 'krakow-radcy';
  return paged(d, src, (p) => `${CHAMBER_HOSTS.krakow}/radcy/?page=${p}`, async (html) => {
    const { rows, lastPage } = parseKrakowRadcy(html);
    const stats: SourceStats = { seen: rows.length, withContact: 0, matched: 0 };
    for (const r of rows) {
      if (!r.phone && !r.email) continue;
      stats.withContact++;
      const exact = normaliseEntryNumber(r.entryNumber);
      let m = exact ? await findByEntryNumber(d.pool, exact) : null;
      if (!m) m = await findByLooseEntryKey(d.pool, CHAMBER[src], looseEntryKey(r.entryNumber, 'KR'));
      if (!m) m = await byNames(d, CHAMBER[src], nameOrders(r.name));
      if (!m) { d.log(`[${cursorKey(src)}] unmatched: ${r.name} (${r.entryNumber})`); continue; }
      stats.matched++;
      await attach(d, src, m, { phone: r.phone, email: r.email }, [], `${CHAMBER_HOSTS.krakow}/radcy/`);
    }
    return { lastPage, stats };
  });
}

async function krakowKancelarie(d: JobDeps): Promise<SourceStats> {
  const src: ChamberSource = 'krakow-kancelarie';
  return paged(d, src, (p) => `${CHAMBER_HOSTS.krakow}/kancelarie/?page=${p}`, async (html) => {
    const { rows, lastPage } = parseKrakowKancelarie(html);
    const stats: SourceStats = { seen: rows.length, withContact: 0, matched: 0 };
    for (const f of rows) {
      if (!hasContact(f)) continue;
      stats.withContact++;
      if (/spółka/i.test(f.kind)) continue;
      const m = await byNames(d, CHAMBER[src], personFromOfficeName(f.name));
      if (!m) continue;
      stats.matched++;
      await attach(d, src, m, { phone: f.phone, email: f.email, website: f.website, address: f.address, city: f.city, officeName: f.name }, f.tags, `${CHAMBER_HOSTS.krakow}/kancelarie/`);
    }
    return { lastPage, stats };
  });
}

async function olsztyn(d: JobDeps): Promise<SourceStats> {
  const src: ChamberSource = 'olsztyn';
  const url = `${CHAMBER_HOSTS.olsztyn}/radcowie/lista-kancelarii/`;
  const rows = parseOlsztynKancelarie(await d.http.get(url));
  const stats: SourceStats = { seen: rows.length, withContact: 0, matched: 0 };
  for (const f of rows) {
    if (!hasContact(f)) continue;
    stats.withContact++;
    const m = await byNames(d, CHAMBER[src], personFromOfficeName(f.name));
    if (!m) continue;
    stats.matched++;
    await attach(d, src, m, { phone: f.phone, phone2: f.phone2, email: f.email, website: f.website, address: f.address, city: f.city, officeName: f.name }, [], url);
  }
  return stats;
}

async function opole(d: JobDeps): Promise<SourceStats> {
  const src: ChamberSource = 'opole';
  return paged(d, src, (p) => `${CHAMBER_HOSTS.opole}/kancelarie?page=${p}`, async (html) => {
    const { rows, lastPage } = parseOpoleList(html);
    const stats: SourceStats = { seen: rows.length, withContact: 0, matched: 0 };
    for (const f of rows) {
      const m = await byNames(d, CHAMBER[src], personFromOfficeName(f.name));
      if (!m) continue;
      // the list has the phone only; e-mail and website live on the firm page, fetched for matches only
      let det: ReturnType<typeof parseOpoleDetail> | null = null;
      try {
        det = parseOpoleDetail(await d.http.get(`${CHAMBER_HOSTS.opole}${f.path}`));
      } catch (e) {
        if (!(e instanceof HttpStatusError)) throw e;
      }
      const c: Contacts = { phone: f.phone ?? det?.phone ?? det?.phone2 ?? null, phone2: f.phone && det?.phone && det.phone !== f.phone ? det.phone : det?.phone2 ?? null, email: det?.email ?? null, website: det?.website ?? null, address: det?.address ?? null, postcode: det?.postcode ?? null, city: f.city ?? det?.city ?? null, officeName: f.name };
      if (!hasContact(c)) continue;
      stats.withContact++;
      stats.matched++;
      await attach(d, src, m, c, [], `${CHAMBER_HOSTS.opole}${f.path}`);
    }
    return { lastPage, stats };
  });
}

async function zielonaGora(d: JobDeps): Promise<SourceStats> {
  const src: ChamberSource = 'zielonagora';
  const url = `${CHAMBER_HOSTS.zielonagora}/lista-kancelarii/`;
  const rows = parseZielonaGoraKancelarie(await d.http.get(url));
  const stats: SourceStats = { seen: rows.length, withContact: 0, matched: 0 };
  for (const r of rows) {
    if (!hasContact(r)) continue;
    stats.withContact++;
    let m = r.entryNumberRaw ? await findByLooseEntryKey(d.pool, CHAMBER[src], looseEntryKey(r.entryNumberRaw, 'ZG')) : null;
    if (!m) m = await byNames(d, CHAMBER[src], [{ surname: r.surname, givenNames: r.givenNames }]);
    if (!m) { d.log(`[${cursorKey(src)}] unmatched: ${r.surname} ${r.givenNames} (${r.entryNumberRaw ?? 'no number'})`); continue; }
    stats.matched++;
    await attach(d, src, m, { phone: r.phone, email: r.email, website: r.website, address: r.address, officeName: r.officeName }, [], url);
  }
  return stats;
}

async function szczecin(d: JobDeps): Promise<SourceStats> {
  const src: ChamberSource = 'szczecin';
  const tiles = parseSzczecinList(await d.http.get(`${CHAMBER_HOSTS.szczecin}/listy/lista-kancelarii/`));
  const stats: SourceStats = { seen: tiles.length, withContact: 0, matched: 0 };
  for (const t of tiles) {
    const m = await byNames(d, CHAMBER[src], nameOrders(t.name));
    if (!m) continue;
    let det: ReturnType<typeof parseSzczecinDetail>;
    try {
      det = parseSzczecinDetail(await d.http.get(t.url));
    } catch (e) {
      if (e instanceof HttpStatusError) continue;
      throw e;
    }
    if (!hasContact(det)) continue;
    stats.withContact++;
    stats.matched++;
    await attach(d, src, m, { phone: det.phone, email: det.email, website: det.website, address: det.address, postcode: det.postcode, city: det.city ?? t.city, officeName: det.officeName }, det.tags, t.url);
  }
  return stats;
}

async function rzeszow(d: JobDeps): Promise<SourceStats> {
  const src: ChamberSource = 'rzeszow';
  const url = `${CHAMBER_HOSTS.rzeszow}/json/kancelaria.json`;
  const rows = parseRzeszowJson(await d.http.get(url));
  const stats: SourceStats = { seen: rows.length, withContact: 0, matched: 0 };
  for (const f of rows) {
    if (!hasContact(f)) continue;
    stats.withContact++;
    if (f.kind && !/^Kancelaria Radcy Prawnego$/i.test(f.kind)) continue; // partnerships and mixed firms
    const m = await byNames(d, CHAMBER[src], personFromOfficeName(f.name));
    if (!m) continue;
    stats.matched++;
    await attach(d, src, m, { phone: f.phone, email: f.email, website: f.website, address: f.address, postcode: f.postcode, city: f.city, officeName: f.name }, [], url);
  }
  return stats;
}

const RUN: Record<ChamberSource, (d: JobDeps) => Promise<SourceStats>> = {
  'krakow-radcy': krakowRadcy, 'krakow-kancelarie': krakowKancelarie, olsztyn, opole, zielonagora: zielonaGora, szczecin, rzeszow,
};

/**
 * Runs every source that has not completed since its cursor was last cleared. Returns per-source stats,
 * null for a source that failed this time (its cursor is kept, it is retried on the next tick).
 */
export async function chambers(d: JobDeps, o: { only?: ChamberSource[] } = {}): Promise<Record<ChamberSource, SourceStats | null>> {
  const out = {} as Record<ChamberSource, SourceStats | null>;
  for (const src of o.only ?? CHAMBER_SOURCES) {
    const cur = await getCursor(d.pool, cursorKey(src));
    if (cur && typeof cur.completedAt === 'string') { out[src] = cur as unknown as SourceStats; continue; }
    try {
      const stats = await RUN[src](d);
      await setCursor(d.pool, cursorKey(src), { ...stats, completedAt: now(d).toISOString() });
      d.log(`[${cursorKey(src)}] done: ${stats.seen} entries, ${stats.withContact} with a contact, ${stats.matched} attached`);
      out[src] = stats;
    } catch (e) {
      d.log(`[${cursorKey(src)}] failed: ${(e as Error).message}`);
      out[src] = null;
    }
  }
  return out;
}

/** Like the szukajradcy pass: needs a completed radca list; runs while any source has no completedAt. */
export function needsChambersRun(cursors: Partial<Record<ChamberSource, Record<string, unknown> | null>>, radcowieList: Record<string, unknown> | null): boolean {
  if (!radcowieList || typeof radcowieList.walkStartedAt === 'string' || typeof radcowieList.completedAt !== 'string') return false;
  return CHAMBER_SOURCES.some((s) => typeof cursors[s]?.completedAt !== 'string');
}

export async function chamberCursors(d: JobDeps): Promise<Partial<Record<ChamberSource, Record<string, unknown> | null>>> {
  const out: Partial<Record<ChamberSource, Record<string, unknown> | null>> = {};
  for (const s of CHAMBER_SOURCES) out[s] = await getCursor(d.pool, cursorKey(s));
  return out;
}

export async function clearChamberCursors(d: JobDeps): Promise<void> {
  for (const s of CHAMBER_SOURCES) await setCursor(d.pool, cursorKey(s), {});
}
