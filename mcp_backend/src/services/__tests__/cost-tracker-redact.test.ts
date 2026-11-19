/**
 * cost_tracking must not keep the name searched with search_case_status_by_party (spec section 6):
 * the party is stored as the same sha256 prefix the tool logs.
 */
import { describe, it, expect } from '@jest/globals';
import { createHash } from 'crypto';
import { personalDataHash, redactPersonalParams } from '../cost-tracker';

describe('redactPersonalParams', () => {
  it('hashes the party of search_case_status_by_party in both stored fields', () => {
    const args = { party: ' Яворська Л.Г. ', region: 'м. Київ', limit: 5 };
    const r = redactPersonalParams('search_case_status_by_party', JSON.stringify(args), args);
    const expected = 'sha256:' + createHash('sha256').update('яворська л.г.').digest('hex').slice(0, 12);
    expect(r.queryParams).toEqual({ party: expected, region: 'м. Київ', limit: 5 });
    expect(r.userQuery).not.toMatch(/яворськ/i);
    expect(JSON.parse(r.userQuery).party).toBe(expected);
    expect(personalDataHash('ЯВОРСЬКА Л.Г.')).toBe(expected);
    // The caller's arguments are not mutated: the tool still needs the real name.
    expect(args.party).toBe(' Яворська Л.Г. ');
  });

  it('leaves other tools untouched', () => {
    const args = { query: 'стягнення боргу' };
    expect(redactPersonalParams('search_court_decisions', 'стягнення боргу', args)).toEqual({ userQuery: 'стягнення боргу', queryParams: args });
  });
});
