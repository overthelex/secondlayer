/**
 * UkLegislationTools — the UK statute-book surface (LEXAI-2057).
 *
 * The assertions here are mostly about honesty rather than plumbing, because the three
 * ways this tool can mislead a lawyer are all cases where an empty or confident answer
 * would look fine:
 *
 *   - an open interval (valid_to = null) means "still standing in the last version the
 *     archive holds", NOT "in force today", and every point-in-time answer must say so;
 *   - an act with no version history must be told apart from a date outside the history;
 *   - an act the source publishes only as scans must come back as a coverage fact with a
 *     link, not as a 404 that invites a retry.
 */

import { UkLegislationTools } from '../tools/uk-legislation-tools.js';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

type Reply = { rows: any[] };

/** Routes by the shape of the SQL so a test only states the rows it cares about. */
function mockDb(routes: Array<{ match: RegExp; rows: any[] }>) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  return {
    calls,
    query: jest.fn(async (sql: string, params: any[] = []): Promise<Reply> => {
      calls.push({ sql, params });
      for (const r of routes) if (r.match.test(sql)) return { rows: r.rows };
      return { rows: [] };
    }),
  };
}

const parse = (result: any) => JSON.parse(result.content[0].text);

describe('uk_get_provision', () => {
  it('returns the version in force on as_of and always carries the open-interval caveat', async () => {
    const db = mockDb([
      {
        match: /uk_provision_version v JOIN uk_provision_text/,
        rows: [{
          provision_key: 'ukpga/1998/42/section/4', provision_label: '4', provision_type: 'section',
          ord: 3, part: null, chapter: null, schedule_no: null, title: 'Declaration of incompatibility',
          valid_from: '2009-10-01', valid_to: '2013-10-01',
          text: 'In this section "court" means— (a) the Supreme Court;', n_chars: 52,
        }],
      },
    ]);
    const tools = new UkLegislationTools(db);

    const out = parse(await tools.executeTool('uk_get_provision', {
      leg_id: 'ukpga/1998/42', provision: '4', as_of: '2010-06-01',
    }));

    expect(out.source).toBe('point_in_time');
    expect(out.provision.valid_from).toBe('2009-10-01');
    expect(out.provision.text).toContain('Supreme Court');
    // The caveat is the whole reason a lawyer can trust the rest of the payload.
    expect(out.as_at_caveat).toMatch(/not "in force today"/);
  });

  it('falls back to current text, and says why, when the act has no history at all', async () => {
    const db = mockDb([
      { match: /uk_provision_version v JOIN uk_provision_text/, rows: [] },
      { match: /count\(\*\) AS rows[\s\S]*uk_provision_version/, rows: [{ rows: '0', from_: null, to_: null }] },
      {
        match: /FROM uk_legislation_provisions/,
        rows: [{
          provision_label: '1', provision_type: 'section', ord: 0, part: null, chapter: null,
          schedule_no: null, title: null, valid_from: '2015-01-01', text: 'Current text.', n_chars: 13,
        }],
      },
    ]);
    const tools = new UkLegislationTools(db);

    const out = parse(await tools.executeTool('uk_get_provision', {
      leg_id: 'uksi/2015/209', provision: '1', as_of: '2010-06-01',
    }));

    expect(out.source).toBe('current_text_only');
    expect(out.message).toMatch(/has no version history/);
    expect(out.provision.text).toBe('Current text.');
    expect(out.error).toBeUndefined();
  });

  it('distinguishes a date outside the history from an act with no history', async () => {
    const db = mockDb([
      { match: /uk_provision_version v JOIN uk_provision_text/, rows: [] },
      { match: /count\(\*\) AS rows[\s\S]*uk_provision_version/, rows: [{ rows: '17', from_: '1991-02-01', to_: '2026-08-10' }] },
    ]);
    const tools = new UkLegislationTools(db);

    const out = parse(await tools.executeTool('uk_get_provision', {
      leg_id: 'ukpga/1990/8', provision: '55', as_of: '1980-01-01',
    }));

    expect(out.error).toBe('no_version_for_date');
    expect(out.history_from).toBe('1991-02-01');
    expect(out.history_to).toBe('2026-08-10');
  });

  it('reports a scan-only act as a coverage fact with a source link, not a bare 404', async () => {
    const db = mockDb([
      { match: /FROM uk_legislation_provisions\n\s+WHERE leg_id/, rows: [] },
      { match: /count\(\*\) AS n FROM uk_legislation_provisions/, rows: [{ n: '0' }] },
    ]);
    const tools = new UkLegislationTools(db);

    const out = parse(await tools.executeTool('uk_get_provision', {
      leg_id: 'nisro/1950/12', provision: '3',
    }));

    expect(out.error).toBe('no_text');
    expect(out.message).toMatch(/only as scanned images/);
    expect(out.source_url).toBe('https://www.legislation.gov.uk/nisro/1950/12');
  });

  it('builds the provision key by instrument kind, because a bare number is ambiguous', async () => {
    const db = mockDb([{ match: /uk_provision_version v JOIN uk_provision_text/, rows: [] },
                       { match: /count\(\*\) AS rows/, rows: [{ rows: '1', from_: '2000-01-01', to_: '2020-01-01' }] }]);
    const tools = new UkLegislationTools(db);

    await tools.executeTool('uk_get_provision', { leg_id: 'ukpga/1990/8', provision: '55', as_of: '2004-03-03' });
    expect(db.calls[0].params).toContain('ukpga/1990/8/section/55');

    db.calls.length = 0;
    await tools.executeTool('uk_get_provision', { leg_id: 'uksi/2010/2955', provision: '7', as_of: '2012-01-01' });
    expect(db.calls[0].params).toContain('uksi/2010/2955/regulation/7');
  });

  it('rejects a malformed leg_id before touching the database', async () => {
    const db = mockDb([]);
    const tools = new UkLegislationTools(db);

    const out = parse(await tools.executeTool('uk_get_provision', { leg_id: 'Companies Act', provision: '1' }));
    expect(out.error).toBe('bad_leg_id');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('accepts a regnal-year identifier: every act before 1963 has one', async () => {
    // Landlord and Tenant Act 1954 is ukpga/Eliz2/2-3/56: four parts and a hyphen. The old
    // three-part pattern rejected it, so the core property statutes were unreachable.
    const db = mockDb([{ match: /FROM uk_provision_version/, rows: [] }]);
    const tools = new UkLegislationTools(db);

    const out = parse(await tools.executeTool('uk_get_provision', {
      leg_id: 'ukpga/Eliz2/2-3/56', provision: '38A', as_of: '2016-01-22',
    }));
    expect(out.error).not.toBe('bad_leg_id');
    expect(db.query).toHaveBeenCalled();
    expect(db.calls[0].params).toContain('ukpga/Eliz2/2-3/56/section/38A');
  });

  it('still rejects an identifier with too many parts', async () => {
    const db = mockDb([]);
    const tools = new UkLegislationTools(db);
    const out = parse(await tools.executeTool('uk_get_provision', { leg_id: 'ukpga/Eliz2/2-3/56/section', provision: '1' }));
    expect(out.error).toBe('bad_leg_id');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('accepts a full legislation.gov.uk URL as the identifier', async () => {
    const db = mockDb([{ match: /FROM uk_legislation_provisions/, rows: [{ provision_label: '1', text: 'x', n_chars: 1 }] }]);
    const tools = new UkLegislationTools(db);

    const out = parse(await tools.executeTool('uk_get_provision', {
      leg_id: 'https://www.legislation.gov.uk/id/ukpga/2006/46', provision: '1',
    }));
    expect(out.leg_id).toBe('ukpga/2006/46');
  });
});

describe('uk_get_provision — ambiguity', () => {
  it('refuses to guess when a bare number matches a section and a schedule paragraph', async () => {
    // `4` in the Human Rights Act is section 4 and also paragraph 4 of Schedule 1.
    // Returning the first row would be the wrong kind of helpful: a lawyer quoting the
    // schedule paragraph as "section 4" has no way to notice.
    const db = mockDb([
      {
        match: /uk_provision_version v JOIN uk_provision_text/,
        rows: [
          { provision_key: 'ukpga/1998/42/section/4', provision_type: 'section', title: 'Declaration', valid_from: '2013-10-01', valid_to: null, text: 'a' },
          { provision_key: 'ukpga/1998/42/schedule/1/paragraph/4', provision_type: 'paragraph', schedule_no: '1', title: 'Art 4', valid_from: '2013-10-01', valid_to: null, text: 'b' },
        ],
      },
    ]);
    const tools = new UkLegislationTools(db);

    const out = parse(await tools.executeTool('uk_get_provision', {
      leg_id: 'ukpga/1998/42', provision: 'paragraph/4', as_of: '2020-01-01',
    }));

    expect(out.error).toBe('ambiguous_provision');
    expect(out.matches.map((m: any) => m.provision_key).sort()).toEqual([
      'ukpga/1998/42/schedule/1/paragraph/4', 'ukpga/1998/42/section/4',
    ]);
  });

  it('still answers when the exact key is among the matches', async () => {
    const db = mockDb([
      {
        match: /uk_provision_version v JOIN uk_provision_text/,
        rows: [
          { provision_key: 'ukpga/1998/42/section/4', provision_label: '4', valid_from: '2013-10-01', valid_to: null, text: 'the right one', n_chars: 13 },
          { provision_key: 'ukpga/1998/42/schedule/1/paragraph/4', provision_label: '4', valid_from: '2013-10-01', valid_to: null, text: 'the other one', n_chars: 13 },
        ],
      },
    ]);
    const tools = new UkLegislationTools(db);

    const out = parse(await tools.executeTool('uk_get_provision', {
      leg_id: 'ukpga/1998/42', provision: '4', as_of: '2020-01-01',
    }));

    expect(out.error).toBeUndefined();
    expect(out.provision.text).toBe('the right one');
  });

  it('binds the act, the key and the date it was given', async () => {
    const db = mockDb([{ match: /uk_provision_version v JOIN uk_provision_text/, rows: [] },
                       { match: /count\(\*\) AS rows/, rows: [{ rows: '0', from_: null, to_: null }] },
                       { match: /FROM uk_legislation_provisions/, rows: [] }]);
    const tools = new UkLegislationTools(db);

    await tools.executeTool('uk_get_provision', {
      leg_id: 'ukpga/1990/8', provision: 'section/55', as_of: '2004-03-03',
    });

    expect(db.calls[0].params).toEqual(
      ['ukpga/1990/8', 'ukpga/1990/8/section/55', '55', '2004-03-03']);
  });
});

describe('uk_search_legislation', () => {
  it('finds by title and reports coverage on every hit', async () => {
    const db = mockDb([{
      match: /FROM uk_legislation l/,
      rows: [{ _total_count: '2', id: 'ukpga/2006/46', leg_type: 'ukpga', year: 2006,
               title: 'Companies Act 2006', has_text: true, versions: '200',
               unapplied_effects: 61 }],
    }]);
    const tools = new UkLegislationTools(db);

    const out = parse(await tools.executeTool('uk_search_legislation', { query: 'Companies Act' }));
    const hit = (out.results || out)[0] ?? out.results?.[0];
    expect(JSON.stringify(out)).toContain('ukpga/2006/46');
    expect(JSON.stringify(out)).toContain('"point_in_time":true');
    expect(db.calls[0].params[0]).toBe('%Companies Act%');
  });

  it('treats an identifier as an identifier, not as a title fragment', async () => {
    const db = mockDb([{ match: /FROM uk_legislation l/, rows: [] }]);
    const tools = new UkLegislationTools(db);

    const out = parse(await tools.executeTool('uk_search_legislation', { query: 'ukpga/2006/46' }));
    expect(db.calls[0].params[0]).toBe('ukpga/2006/46');
    expect(db.calls[0].sql).toContain('l.id = $1');
    expect(out.note).toMatch(/is not in the register/);
  });

  it('counts one archived version as point-in-time data', async () => {
    // An act with a single archived version still says what it looked like on that
    // date; only zero means there is no history to offer.
    const db = mockDb([{
      match: /FROM uk_legislation l/,
      rows: [{ _total_count: '1', id: 'asp/2006/1', versions: '1', has_text: true }],
    }]);
    const tools = new UkLegislationTools(db);
    const out = parse(await tools.executeTool('uk_search_legislation', { query: 'Housing' }));
    expect(JSON.stringify(out)).toContain('"point_in_time":true');
  });
});

describe('uk_get_provision_history', () => {
  it('groups intervals by provision_key so two provisions are not interleaved', async () => {
    const db = mockDb([
      {
        match: /uk_provision_version v JOIN uk_provision_text/,
        rows: [
          { provision_key: 'ukpga/1998/42/section/4', provision_label: '4', valid_from: '1998-11-09', valid_to: '2007-10-01', n_chars: 1386, text: null },
          { provision_key: 'ukpga/1998/42/schedule/1/section/4', provision_label: '4', valid_from: '1998-11-09', valid_to: null, n_chars: 200, text: null },
          { provision_key: 'ukpga/1998/42/section/4', provision_label: '4', valid_from: '2007-10-01', valid_to: null, n_chars: 1543, text: null },
        ],
      },
    ]);
    const tools = new UkLegislationTools(db);

    const out = parse(await tools.executeTool('uk_get_provision_history', {
      leg_id: 'ukpga/1998/42', provision: '4',
    }));

    expect(out.provisions).toHaveLength(2);
    const section = out.provisions.find((p: any) => p.provision_key === 'ukpga/1998/42/section/4');
    expect(section.intervals).toBe(2);
    expect(section.open_ended).toBe(true);
    expect(section.history[0].valid_to).toBe('2007-10-01');
    // No text unless asked: a 400-version act would otherwise return megabytes.
    expect(section.history[0].text).toBeUndefined();
  });

  it('says the act has no history rather than returning an empty list', async () => {
    const db = mockDb([
      { match: /uk_provision_version v JOIN uk_provision_text/, rows: [] },
      { match: /count\(\*\) AS n FROM uk_provision_version/, rows: [{ n: '0' }] },
    ]);
    const tools = new UkLegislationTools(db);

    const out = parse(await tools.executeTool('uk_get_provision_history', {
      leg_id: 'uksi/2015/209', provision: '1',
    }));
    expect(out.error).toBe('no_point_in_time');
    expect(out.message).toMatch(/62,866/);
  });
});

describe('uk_get_act', () => {
  it('reports coverage and the unapplied-effects backlog, which is why text can lag the law', async () => {
    const db = mockDb([
      { match: /FROM uk_legislation WHERE id/, rows: [{ id: 'ukpga/2006/46', leg_type: 'ukpga', year: 2006, number: '46', title: 'Companies Act 2006' }] },
      { match: /AS provisions/, rows: [{ provisions: '1713', text_valid_from: '2026-07-16', pit_rows: '3675', pit_from: '2007-01-01', pit_to: '2026-07-16', versions: '200' }] },
      { match: /FROM uk_legislation_effects WHERE affected_id/, rows: [{ total: '4200', unapplied: '61', applied: '4139' }] },
    ]);
    const tools = new UkLegislationTools(db);

    const out = parse(await tools.executeTool('uk_get_act', { leg_id: 'ukpga/2006/46' }));

    expect(out.coverage.has_text).toBe(true);
    expect(out.coverage.point_in_time).toBe(true);
    expect(out.coverage.versions).toBe(200);
    expect(out.coverage.as_at_caveat).toBeDefined();
    expect(out.effects.unapplied).toBe(61);
    expect(out.effects.note).toMatch(/may lag the law/);
  });

  it('explains a text-less act instead of returning empty coverage', async () => {
    const db = mockDb([
      { match: /FROM uk_legislation WHERE id/, rows: [{ id: 'ukppa/1900/1', leg_type: 'ukppa', year: 1900, title: 'A private act' }] },
      { match: /AS provisions/, rows: [{ provisions: '0', text_valid_from: null, pit_rows: '0', pit_from: null, pit_to: null, versions: null }] },
      { match: /FROM uk_legislation_effects WHERE affected_id/, rows: [{ total: '0', unapplied: '0', applied: '0' }] },
    ]);
    const tools = new UkLegislationTools(db);

    const out = parse(await tools.executeTool('uk_get_act', { leg_id: 'ukppa/1900/1' }));
    expect(out.coverage.has_text).toBe(false);
    expect(out.coverage.note).toMatch(/only as scanned images/);
    expect(out.coverage.as_at_caveat).toBeUndefined();
  });
});

describe('uk_get_act_as_at', () => {
  it('assembles the act in document order and paginates on characters', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      provision_label: String(i + 1), provision_type: 'section', ord: i,
      title: `Heading ${i + 1}`, valid_from: '2009-10-01', valid_to: null,
      text: 'x'.repeat(100),
    }));
    const db = mockDb([{ match: /uk_act_as_at/, rows }]);
    const tools = new UkLegislationTools(db);

    const out = parse(await tools.executeTool('uk_get_act_as_at', {
      leg_id: 'ukpga/1998/42', as_of: '2010-01-01', max_chars: 150,
    }));

    expect(out.provisions).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(150);
    expect(out.text.startsWith('Section 1 — Heading 1')).toBe(true);
    expect(out.as_at_caveat).toBeDefined();
  });

  it('requires a well-formed as_of', async () => {
    const db = mockDb([]);
    const tools = new UkLegislationTools(db);
    const out = parse(await tools.executeTool('uk_get_act_as_at', { leg_id: 'ukpga/1998/42', as_of: 'last year' }));
    expect(out.error).toBe('bad_date');
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('uk_get_effects', () => {
  const effectsRows = [
    { affected_provisions: 's. 24-28', effect_type: 'excluded', affecting_id: 'ukpga/2023/55', affecting_title: 'Levelling-up and Regeneration Act 2023', affecting_provisions: 's. 209', in_force_date: '2024-12-02', applied: true, affected_extent: 'E+W' },
    { affected_provisions: 's. 38A(3)', effect_type: 'words substituted', affecting_id: 'x/1', affecting_title: 'An amending act', affecting_provisions: 's. 1', in_force_date: '2020-01-01', applied: true, affected_extent: 'E+W' },
    { affected_provisions: 'Pt. 2', effect_type: 'excluded', affecting_id: 'ukpga/2014/20', affecting_title: 'Defence Reform Act 2014', affecting_provisions: 'Sch. 6', in_force_date: null, applied: false, affected_extent: 'E+W' },
    { affected_provisions: 's. 29', effect_type: 'omitted', affecting_id: 'x/2', affecting_title: 'Another act', affecting_provisions: 's. 2', in_force_date: '2019-01-01', applied: true, affected_extent: 'E+W' },
  ];

  it('names the instrument behind an exclusion that never changed the text', async () => {
    const db = mockDb([{ match: /FROM uk_legislation_effects/, rows: effectsRows }]);
    const tools = new UkLegislationTools(db);

    const out = parse(await tools.executeTool('uk_get_effects', { leg_id: 'ukpga/Eliz2/2-3/56', provision: '25' }));

    expect(out.total).toBe(2); // s.24-28 (range) and Pt. 2 (part); not s.38A, not s.29
    expect(out.by_scope).toEqual({ provision: 1, part: 1 });
    expect(out.effects[0]).toMatchObject({
      affected_provisions: 's. 24-28', scope: 'provision', effect_type: 'excluded',
      affecting: { id: 'ukpga/2023/55', title: 'Levelling-up and Regeneration Act 2023', provisions: 's. 209' },
    });
    expect(out.unapplied).toBe(1);
    expect(db.calls[0].params[0]).toBe('ukpga/Eliz2/2-3/56');
  });

  it('passes the date and type filters to SQL, keeping effects with no in-force date', async () => {
    const db = mockDb([{ match: /FROM uk_legislation_effects/, rows: [] }]);
    const tools = new UkLegislationTools(db);

    const out = parse(await tools.executeTool('uk_get_effects', {
      leg_id: 'uksi/2007/991', since: '2016-01-22', effect_type: 'revoked',
    }));

    expect(db.calls[0].sql).toMatch(/in_force_date IS NULL OR in_force_date >= \$2/);
    expect(db.calls[0].params).toEqual(['uksi/2007/991', '2016-01-22', '%revoked%']);
    expect(out.total).toBe(0);
    expect(out.note).toMatch(/No effects recorded/);
  });

  it('rejects a bad date and a bad provision before touching the database', async () => {
    const db = mockDb([]);
    const tools = new UkLegislationTools(db);
    expect(parse(await tools.executeTool('uk_get_effects', { leg_id: 'ukpga/1986/45', since: 'last year' })).error).toBe('bad_date');
    expect(parse(await tools.executeTool('uk_get_effects', { leg_id: 'ukpga/1986/45', provision: 'the bit about IVAs' })).error).toBe('bad_provision');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('pages the matched effects', async () => {
    const db = mockDb([{ match: /FROM uk_legislation_effects/, rows: effectsRows }]);
    const tools = new UkLegislationTools(db);
    const out = parse(await tools.executeTool('uk_get_effects', { leg_id: 'ukpga/Eliz2/2-3/56', limit: 1, offset: 1 }));
    expect(out.total).toBe(4);
    expect(out.effects).toHaveLength(1);
    expect(out.effects[0].affected_provisions).toBe('s. 38A(3)');
    expect(out.has_more).toBe(true);
  });
});

describe('tool surface', () => {
  it('advertises six read-only uk_* tools and handles exactly those', () => {
    const tools = new UkLegislationTools(mockDb([]));
    const defs = tools.getToolDefinitions();

    expect(defs.map((d) => d.name).sort()).toEqual([
      'uk_get_act', 'uk_get_act_as_at', 'uk_get_effects', 'uk_get_provision',
      'uk_get_provision_history', 'uk_search_legislation',
    ]);
    for (const d of defs) {
      expect(d.name.startsWith('uk_')).toBe(true);     // the MCP_TOOLSET gate keys on this
      expect(d.annotations?.readOnlyHint).toBe(true);
    }
    expect(tools.handles('uk_get_act')).toBe(true);
    expect(tools.handles('ch_get_act_text')).toBe(false);
  });
});
