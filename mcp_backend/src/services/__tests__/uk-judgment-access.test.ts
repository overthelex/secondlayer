/**
 * The Find Case Law licence gate.
 *
 * These are not cosmetic tests. Question 13 of TNA ref CAS-349914-B9P5B8 tells The
 * National Archives that the judgments are restricted to legal professionals and
 * researchers, and that answer is what separates a 5-year transactional licence
 * from a 1-year R&D licence whose outputs cannot be given to anyone. If this gate
 * regresses, the application becomes untrue.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  gatedRegistryOf,
  checkJudgmentAccess,
  isFreeMailDomain,
  emailDomain,
  LICENCE_GATED_REGISTRIES,
} from '../uk-judgment-access.js';

const dbReturning = (rows: any[]) => ({
  query: jest.fn(async () => ({ rows })),
});

describe('which calls are gated', () => {
  it('gates the judgments registry', () => {
    expect(gatedRegistryOf('search_registry', { registry: 'uk_court_decisions' }))
      .toBe('uk_court_decisions');
  });

  it('does NOT gate UK legislation', () => {
    // legislation.gov.uk is OGL v3.0 with commercial use permitted. Gating it would
    // be a restriction we invented rather than one we were given.
    for (const r of ['uk_legislation', 'uk_legislation_provisions',
                     'uk_legislation_effects']) {
      expect(gatedRegistryOf('search_registry', { registry: r })).toBeNull();
    }
  });

  it('does not gate other tools or other registries', () => {
    expect(gatedRegistryOf('search_court_decisions', { registry: 'uk_court_decisions' }))
      .toBeNull();
    expect(gatedRegistryOf('search_registry', { registry: 'lawyers' })).toBeNull();
    expect(gatedRegistryOf('search_registry', {})).toBeNull();
    expect(gatedRegistryOf('search_registry', null)).toBeNull();
  });

  it('the gated set is explicit, so adding a registry is a deliberate act', () => {
    expect([...LICENCE_GATED_REGISTRIES]).toEqual(['uk_court_decisions']);
  });
});

describe('the access decision', () => {
  it('allows a granted account', async () => {
    const d = await checkJudgmentAccess(dbReturning([{ status: 'granted' }]), 42);
    expect(d.allowed).toBe(true);
  });

  it.each(['pending', 'refused', 'revoked'])('denies a %s account', async (status) => {
    const d = await checkJudgmentAccess(dbReturning([{ status }]), 42);
    expect(d.allowed).toBe(false);
    expect(d.message).toBeTruthy();
  });

  it('denies an account with no record at all', async () => {
    const d = await checkJudgmentAccess(dbReturning([]), 42);
    expect(d.allowed).toBe(false);
    // The message has to tell a professional how to get access, not just say no.
    expect(d.message).toMatch(/uk-judgments\/access/);
  });

  it('denies an anonymous caller without touching the database', async () => {
    const db = dbReturning([{ status: 'granted' }]);
    for (const id of [undefined, null, '']) {
      expect((await checkJudgmentAccess(db, id as any)).allowed).toBe(false);
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the database errors', async () => {
    // The tempting alternative — allow on error so the product keeps working —
    // would breach the licence precisely when we cannot see that it is happening.
    const db = { query: jest.fn(async () => { throw new Error('connection refused'); }) };
    const d = await checkJudgmentAccess(db, 42);
    expect(d.allowed).toBe(false);
  });

  it('takes a string id from JWT and a number id from the HTTP layer alike', async () => {
    expect((await checkJudgmentAccess(dbReturning([{ status: 'granted' }]), '42')).allowed)
      .toBe(true);
    expect((await checkJudgmentAccess(dbReturning([{ status: 'granted' }]), 42)).allowed)
      .toBe(true);
  });
});

describe('email domain signal', () => {
  it('recognises free mail', () => {
    expect(isFreeMailDomain('someone@gmail.com')).toBe(true);
    expect(isFreeMailDomain('someone@proton.me')).toBe(true);
  });

  it('treats a firm, an in-house address and a university as not free mail', () => {
    // All three are audiences we named in question 14, and a law-firm domain
    // allow-list would have excluded the last two.
    expect(isFreeMailDomain('a@slaughterandmay.com')).toBe(false);
    expect(isFreeMailDomain('a@hsbc.com')).toBe(false);
    expect(isFreeMailDomain('a@ox.ac.uk')).toBe(false);
  });

  it('extracts the domain, and copes with nonsense', () => {
    expect(emailDomain('A.Person@Example.COM')).toBe('example.com');
    expect(emailDomain('not-an-email')).toBeNull();
    expect(emailDomain(undefined)).toBeNull();
  });
});
