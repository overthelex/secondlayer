/**
 * LEXAI-2121: openreyestr_get_statistics reported 399 public associations (ЄДР FSU
 * table) instead of the ~1.08M rows of the Minjust registry the gateway owns.
 */

import {
  enrichOpenreyestrStatistics,
  resetPublicOrganizationsCountCache,
} from '../openreyestr-statistics-enricher.js';

const upstream = {
  totalEntities: { legalEntities: 1994486, individualEntrepreneurs: 6854457, publicAssociations: 399, total: 8849342 },
  activeEntities: { legalEntities: 1377542, individualEntrepreneurs: 2181627, publicAssociations: 391, total: 3559560 },
};

function fakeDb(rows: Array<{ registry_type: string; n: string }>) {
  const calls: string[] = [];
  return {
    calls,
    query: async (text: string) => {
      calls.push(text);
      return { rows };
    },
  };
}

describe('enrichOpenreyestrStatistics', () => {
  beforeEach(() => resetPublicOrganizationsCountCache());

  it('replaces the ЄДР FSU counter with the Minjust registry count, in the MCP envelope', async () => {
    const db = fakeDb([
      { registry_type: 'political_party', n: '581555' },
      { registry_type: 'public_org', n: '469287' },
      { registry_type: 'charitable_org', n: '23248' },
    ]);
    const envelope = { content: [{ type: 'text', text: JSON.stringify(upstream) }] };
    const out = await enrichOpenreyestrStatistics(envelope, db);
    const stats = JSON.parse(out.content[0].text);

    expect(stats.totalEntities.publicAssociations).toBe(1074090);
    expect(stats.totalEntities.total).toBe(1994486 + 6854457);
    expect(stats.activeEntities.publicAssociations).toBeNull();
    expect(stats.activeEntities.total).toBe(1377542 + 2181627);
    expect(stats.publicAssociationsByType.political_party).toBe(581555);
    expect(db.calls[0]).toContain('opendata_public_organizations');
  });

  it('caches the count instead of re-running the query on every call', async () => {
    const db = fakeDb([{ registry_type: 'public_org', n: '10' }]);
    await enrichOpenreyestrStatistics(upstream, db);
    await enrichOpenreyestrStatistics(upstream, db);
    expect(db.calls).toHaveLength(1);
  });

  it('returns the upstream result unchanged when the count fails or the shape is unknown', async () => {
    const failing = { query: async () => { throw new Error('boom'); } };
    expect(await enrichOpenreyestrStatistics(upstream, failing)).toBe(upstream);
    const err = { content: [{ type: 'text', text: 'Error: x' }], isError: true };
    expect(await enrichOpenreyestrStatistics(err, fakeDb([]))).toBe(err);
  });
});
