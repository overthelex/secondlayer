// CEIDG (the register of sole traders) through the Hurtownia Danych API v3 at dane.biznes.gov.pl: for every
// practising radca without a phone or e-mail, one list request by surname + first given name restricted to
// PKD 69.10.Z (legal activities) and active firms, then one firm request for the single matching firm.
// The firm record carries e-mail, phone and website only where the entrepreneur consented to publish them.
// Limit: 1,000 requests per 60 minutes per token; we space requests 4.5 s apart (800/h) and the Collector
// backs off on 429. Each candidate is marked raw.ceidg.checkedAt so it is asked about again only after
// CEIDG_RECHECK_DAYS. A list query by a common surname (KOWALCZYK JOANNA, NOWAK ANNA) can take minutes on
// CEIDG's side: it gets one attempt of LIST_TIMEOUT_MS, the candidate is marked raw.ceidg.timeoutAt and asked
// again after a week; three timeouts in a row are taken as an outage and stop the batch. Token: CEIDG_TOKEN (a JWT issued to a team member's Profil Zaufany account).
import type { JobDeps } from './jobs';
import { CollectorStopped, HttpStatusError, RequestTimeout } from './http';
import { normalisePhone } from './normalise';
import { ceidgCandidates, markRaw, upsertLawyers } from './store';

export const CEIDG_HOST = 'https://dane.biznes.gov.pl';
export const CEIDG_MIN_DELAY_MS: Record<string, number> = { 'dane.biznes.gov.pl': 4_500 };
const PKD_LEGAL = '6910Z';
const LIST_TIMEOUT_MS = 120_000;
const TIMEOUTS_IN_A_ROW_IS_OUTAGE = 3;

export interface CeidgFirm {
  id: string;
  nazwa?: string;
  status?: string;
  wlasciciel?: { imie?: string; nazwisko?: string; nip?: string; regon?: string };
  adresDzialalnosci?: { miasto?: string; kod?: string; ulica?: string; budynek?: string; lokal?: string };
  email?: string | null;
  telefon?: string | null;
  www?: string | null;
  pkdGlowny?: { kod?: string };
}

const up = (s: string | null | undefined) => (s ?? '').trim().toUpperCase();

/**
 * The firm that is this radca: owner's surname equal, owner's first name equal to the register's first given
 * name. One such firm → it; several → only the one in the register's city; none → null.
 */
export function pickFirm(firms: CeidgFirm[], surname: string, givenNames: string, city: string | null): CeidgFirm | null {
  const first = up(givenNames).split(/\s+/)[0];
  const same = firms.filter((f) => up(f.wlasciciel?.nazwisko) === up(surname) && up(f.wlasciciel?.imie) === first);
  if (same.length === 1) return same[0];
  if (same.length > 1 && city) {
    const inCity = same.filter((f) => up(f.adresDzialalnosci?.miasto) === up(city));
    if (inCity.length === 1) return inCity[0];
  }
  return null;
}

function address(a: CeidgFirm['adresDzialalnosci']): string | null {
  if (!a) return null;
  const street = [a.ulica, a.budynek && a.lokal ? `${a.budynek}/${a.lokal}` : a.budynek].filter(Boolean).join(' ');
  const town = [a.kod, a.miasto].filter(Boolean).join(' ');
  const v = [street, town].filter(Boolean).join(', ');
  return v || null;
}

export interface CeidgStats { candidates: number; found: number; withContact: number; timedOut: number }

export async function ceidg(d: JobDeps, o: { token: string | null; limit: number; recheckDays?: number }): Promise<CeidgStats> {
  const stats: CeidgStats = { candidates: 0, found: 0, withContact: 0, timedOut: 0 };
  let timeoutsInARow = 0;
  if (!o.token) return stats;
  const headers = { authorization: `Bearer ${o.token}`, accept: 'application/json' };
  const todo = await ceidgCandidates(d.pool, o.recheckDays ?? 180, o.limit);
  stats.candidates = todo.length;
  const now = () => (d.now ?? (() => new Date()))().toISOString();
  for (const c of todo) {
    const first = c.givenNames.trim().split(/\s+/)[0];
    const q = new URLSearchParams({ nazwisko: c.surname.trim(), imie: first, pkd: PKD_LEGAL, status: 'AKTYWNY', limit: '10' });
    let firms: CeidgFirm[] = [];
    try {
      const body = await d.http.get(`${CEIDG_HOST}/api/ceidg/v3/firmy?${q}`, headers, { timeoutMs: LIST_TIMEOUT_MS, timeoutIsAnswer: true });
      firms = body ? ((JSON.parse(body) as { firmy?: CeidgFirm[] }).firmy ?? []) : [];
      timeoutsInARow = 0;
    } catch (e) {
      if (e instanceof RequestTimeout) {
        stats.timedOut++;
        timeoutsInARow++;
        await markRaw(d.pool, c.lawyerId, { ceidg: { timeoutAt: now() } });
        d.log(`[ceidg] ${c.lawyerId}: list query timed out after ${LIST_TIMEOUT_MS / 1000} s, asked again in a week`);
        if (timeoutsInARow >= TIMEOUTS_IN_A_ROW_IS_OUTAGE) throw new CollectorStopped(`CEIDG: ${timeoutsInARow} list queries in a row timed out`);
        continue;
      }
      if (!(e instanceof HttpStatusError)) throw e;
      timeoutsInARow = 0;
      d.log(`[ceidg] ${c.lawyerId}: HTTP ${e.status} on the list query`);
    }
    const pick = pickFirm(firms, c.surname, c.givenNames, c.city);
    if (!pick) {
      await markRaw(d.pool, c.lawyerId, { ceidg: { checkedAt: now(), found: false, hits: firms.length } });
      continue;
    }
    stats.found++;
    let firm: CeidgFirm = pick;
    try {
      const body = await d.http.get(`${CEIDG_HOST}/api/ceidg/v3/firma/${encodeURIComponent(pick.id)}`, headers);
      const parsed = JSON.parse(body) as { firma?: CeidgFirm[] } | CeidgFirm;
      firm = (Array.isArray((parsed as { firma?: CeidgFirm[] }).firma) ? (parsed as { firma: CeidgFirm[] }).firma[0] : (parsed as CeidgFirm)) ?? pick;
    } catch (e) {
      if (!(e instanceof HttpStatusError)) throw e;
      d.log(`[ceidg] ${c.lawyerId}: HTTP ${e.status} on firm ${pick.id}`);
    }
    const email = firm.email?.trim().toLowerCase() || null;
    const phone = normalisePhone(firm.telefon);
    const website = firm.www?.trim() || null;
    if (email || phone || website) {
      stats.withContact++;
      await upsertLawyers(
        d.pool,
        [{
          lawyerId: c.lawyerId,
          profession: 'radca',
          surname: '',
          givenNames: '',
          status: 'active',
          statusRaw: '',
          email,
          phone,
          website,
          address: address(firm.adresDzialalnosci),
          postcode: firm.adresDzialalnosci?.kod ?? null,
          city: firm.adresDzialalnosci?.miasto ?? null,
          officeName: firm.nazwa ?? null,
          contactSource: 'ceidg',
          raw: { ceidg: { checkedAt: now(), found: true, id: firm.id, nip: firm.wlasciciel?.nip ?? null, pkd: firm.pkdGlowny?.kod ?? null } },
        }],
        (d.now ?? (() => new Date()))(),
        false,
      );
    } else {
      await markRaw(d.pool, c.lawyerId, { ceidg: { checkedAt: now(), found: true, id: firm.id, nip: firm.wlasciciel?.nip ?? null, noContact: true } });
    }
  }
  if (stats.candidates) d.log(`[ceidg] ${stats.candidates} asked, ${stats.found} found in CEIDG, ${stats.withContact} with a published contact, ${stats.timedOut} timed out`);
  return stats;
}
