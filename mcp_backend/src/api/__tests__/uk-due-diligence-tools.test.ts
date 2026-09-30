/**
 * uk_check_citations (LEXAI-2069): one call, the contract's citations in, statutory findings out.
 *
 * The cases are the ones that matter to a lawyer reading the result: a provision whose
 * text changed after signing must show both texts; an exclusion that never touches the
 * text must still surface; an instrument revoked before signing must say so rather than
 * report its provisions as unchanged; a misnamed statute must come back unresolved with
 * suggestions, never silently matched; and bad input must not be charged (isError).
 */

import {
  UkDueDiligenceTools, parseCitedProvision, normTitle, MAX_INSTRUMENTS, MAX_PROVISIONS,
} from '../tools/uk-due-diligence-tools.js';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

type Route = { match: RegExp; rows: any[] | ((params: any[]) => any[]) };

function mockDb(routes: Route[]) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  return {
    calls,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      for (const r of routes) {
        if (r.match.test(sql)) return { rows: typeof r.rows === 'function' ? r.rows(params) : r.rows };
      }
      return { rows: [] };
    }),
  };
}

const parse = (result: any) => JSON.parse(result.content[0].text);

const LTA = 'ukpga/Eliz2/2-3/56';
const H_OLD = 'aa'.repeat(16), H_NEW = 'bb'.repeat(16), H_24 = 'cc'.repeat(16);

function leaseDb() {
  return mockDb([
    { match: /WHERE id = \$1/, rows: (p) => (p[0] === LTA ? [{ id: LTA, title: 'Landlord and Tenant Act 1954' }] : []) },
    {
      match: /title ILIKE/,
      rows: (p) => {
        if (String(p[0]).includes('landlord%and%tenant%act%1954')) return [{ id: LTA, title: 'Landlord and Tenant Act 1954', leg_type: 'ukpga' }];
        if (String(p[0]).includes('insolvency')) return [{ id: 'ukpga/1985/65', title: 'Insolvency Act 1985 (repealed)', leg_type: 'ukpga' }];
        return [];
      },
    },
    { match: /similarity/, rows: [{ id: 'ukpga/1992/12', title: 'Taxation of Chargeable Gains Act 1992', similarity: 0.71 }] },
    {
      match: /FROM uk_legislation l LEFT JOIN uk_pit_load_state/,
      rows: (p) => (p[0] === LTA
        ? [{ title: 'Landlord and Tenant Act 1954', versions: 40, first_version: '2006-04-01', last_version: '2024-01-01' }]
        : [{ title: 'Insolvency Act 1985 (repealed)', versions: 0, last_version: '1986-12-29' }]),
    },
    {
      match: /FROM uk_legislation_effects/,
      rows: (p) => (p[0] === LTA
        ? [
            { affected_provisions: 's. 24-28', effect_type: 'excluded', affecting_id: 'uksi/2020/1', affecting_title: 'Business Tenancies Order 2020', affecting_provisions: 'art. 3', in_force_date: '2020-06-01', applied: true },
            { affected_provisions: 's. 38A(1)', effect_type: 'words substituted', affecting_id: 'ukpga/2021/9', affecting_title: 'Some Act 2021', affecting_provisions: 's. 7', in_force_date: '2021-03-01', applied: true },
            { affected_provisions: 's. 1', effect_type: 'words substituted', affecting_id: 'ukpga/2010/1', affecting_title: 'Old Act 2010', affecting_provisions: 's. 1', in_force_date: '2010-01-01', applied: true },
            { affected_provisions: 's. 24', effect_type: 'applied', affecting_id: 'x/1', affecting_title: 'Elsewhere', affecting_provisions: '', in_force_date: '2022-01-01', applied: true },
          ]
        : [{ affected_provisions: 'Act', effect_type: 'repealed', affecting_id: 'ukpga/1986/45', affecting_title: 'Insolvency Act 1986', affecting_provisions: 'Sch. 12', in_force_date: '1986-12-29', applied: true }]),
    },
    {
      match: /FROM uk_provision_version/,
      rows: [
        { provision_key: `${LTA}/section/38A`, valid_from: '2006-06-01', valid_to: '2021-03-01', h: H_OLD },
        { provision_key: `${LTA}/section/38A`, valid_from: '2021-03-01', valid_to: null, h: H_NEW },
        { provision_key: `${LTA}/section/24`, valid_from: '2006-06-01', valid_to: null, h: H_24 },
        { provision_key: `${LTA}/section/25`, valid_from: '2006-06-01', valid_to: null, h: H_24 },
      ],
    },
    { match: /FROM uk_provision_text/, rows: [{ h: H_OLD, text: 'old wording of 38A' }, { h: H_NEW, text: 'new wording of 38A' }] },
  ]);
}

describe('parseCitedProvision', () => {
  const act = 'ukpga/1986/45';
  it.each([
    ['s.24', [{ kind: 'section', number: '24' }]],
    ['section 38A(1)', [{ kind: 'section', number: '38A' }]],
    ['ss. 24-26', [{ kind: 'section', number: '24' }, { kind: 'section', number: '25' }, { kind: 'section', number: '26' }]],
    ['reg 40(4)', [{ kind: 'regulation', number: '40' }]],
    ['Sch. B1 para. 15', [{ kind: 'paragraph', schedule: 'B1', number: '15' }]],
    ['paragraph 2(2) of Schedule 4', [{ kind: 'paragraph', schedule: '4', number: '2' }]],
    ['Schedule 5, Part 1, paragraph 2', [{ kind: 'paragraph', schedule: '5', number: '2' }]],
    ['Schedule 7', [{ kind: 'schedule', number: '7' }]],
    ['schedule/B1/paragraph/15', [{ kind: 'paragraph', schedule: 'B1', number: '15' }]],
    ['253', [{ kind: 'section', number: '253' }]],
  ])('%s', (input, want) => {
    expect(parseCitedProvision(input, act)).toEqual(want);
  });

  it('lettered ranges keep the numbers between the ends', () => {
    const nums = (x: string) => parseCitedProvision(x, act)!.map((t) => t.number);
    expect(nums('ss. 1-7B')).toEqual(['1', '2', '3', '4', '5', '6', '7', '7B']);
    expect(nums('ss. 24A-24D')).toEqual(['24A', '24B', '24C', '24D']);
    expect(nums('ss. 38-38B')).toEqual(['38', '38A', '38B']);
  });

  it('a bare number in an SI is a regulation', () => {
    expect(parseCitedProvision('20', 'uksi/1998/1833')).toEqual([{ kind: 'regulation', number: '20' }]);
  });

  it('refuses what it cannot read and ranges over the cap', () => {
    expect(parseCitedProvision('clause 4.2', act)).toBeNull();
    expect(parseCitedProvision('ss. 1-500', act)).toBeNull();
  });
});

describe('normTitle', () => {
  it('ignores case, "The", punctuation and a revocation note', () => {
    expect(normTitle('The Working Time Regulations 1998')).toBe(normTitle('working time regulations 1998'));
    expect(normTitle('Insolvency Act 1985 (repealed 29.12.1986)')).toBe('insolvency act 1985');
    expect(normTitle('Contracts (Rights of Third Parties) Act 1999')).toBe('contracts rights of third parties act 1999');
  });
});

describe('uk_check_citations', () => {
  it('reports text changes with both texts, exclusions without a text change, and unchanged provisions', async () => {
    const tools = new UkDueDiligenceTools(leaseDb());
    const out = parse(await tools.executeTool('uk_check_citations', {
      as_of: '2016-01-22', compare_to: '2026-09-30',
      citations: [{ instrument: 'Landlord and Tenant Act 1954', provisions: ['ss. 24-25', 's.38A(1)'], clause: '37.2' }],
    }));

    const lta = out.instruments[0];
    expect(lta.leg_id).toBe(LTA);
    expect(lta.clauses).toEqual(['37.2']);
    const byProv = Object.fromEntries(lta.provisions.map((p: any) => [p.provision, p]));

    // s.38A: a new version after signing → changed, with the amending instrument and both texts.
    expect(byProv['s.38A'].status).toBe('changed_since_signing');
    expect(byProv['s.38A'].versions_since_signing).toEqual(['2021-03-01']);
    expect(byProv['s.38A'].effects[0].by.title).toBe('Some Act 2021');
    expect(byProv['s.38A'].text_at_signing).toBe('old wording of 38A');
    expect(byProv['s.38A'].text_now).toBe('new wording of 38A');

    // s.24: excluded by an order, text untouched → modified; "applied elsewhere" is not a finding.
    expect(byProv['s.24'].status).toBe('modified_since_signing');
    expect(byProv['s.24'].effects).toHaveLength(1);
    expect(byProv['s.24'].effects[0].effect).toBe('excluded');
    expect(byProv['s.24'].text_at_signing).toBeUndefined();

    expect(lta.status).toBe('changed_since_signing');
    expect(out.summary.provisions).toEqual({ changed_since_signing: 1, modified_since_signing: 2 });
    expect(out.as_at_caveat).toBeDefined();
  });

  it('an effect before signing is not a change since signing', async () => {
    const tools = new UkDueDiligenceTools(leaseDb());
    const out = parse(await tools.executeTool('uk_check_citations', {
      as_of: '2016-01-22', compare_to: '2026-09-30',
      citations: [{ instrument: LTA, provisions: ['s.1'] }],
    }));
    const p = out.instruments[0].provisions[0];
    expect(p.provision).toBe('s.1');
    expect(p.status).toBe('not_found');   // history exists, no s.1 row in this fixture
    expect(p.effects).toBeUndefined();    // the 2010 substitution predates signing
  });

  it('an instrument repealed before signing says so and when', async () => {
    const tools = new UkDueDiligenceTools(leaseDb());
    const out = parse(await tools.executeTool('uk_check_citations', {
      as_of: '2016-01-22',
      citations: [{ instrument: 'Insolvency Act 1985', provisions: ['s.1'] }],
    }));
    const ia = out.instruments[0];
    expect(ia.status).toBe('revoked_before_signing');
    expect(ia.revoked_on).toBe('1986-12-29');
    expect(ia.revoked_by[0].by.title).toBe('Insolvency Act 1986');
  });

  it('a misnamed statute is unresolved with suggestions, never silently matched', async () => {
    const tools = new UkDueDiligenceTools(leaseDb());
    const out = parse(await tools.executeTool('uk_check_citations', {
      as_of: '2016-01-22',
      citations: [{ instrument: 'Taxation of Capital Gains Act 1992', provisions: ['s.138'] }],
    }));
    expect(out.instruments).toEqual([]);
    expect(out.unresolved[0].cited_as).toBe('Taxation of Capital Gains Act 1992');
    expect(out.unresolved[0].suggestions[0].leg_id).toBe('ukpga/1992/12');
  });

  it('an instrument cited without provisions is checked as a whole', async () => {
    const tools = new UkDueDiligenceTools(leaseDb());
    const out = parse(await tools.executeTool('uk_check_citations', {
      as_of: '2016-01-22', compare_to: '2026-09-30',
      citations: [{ instrument: 'Landlord and Tenant Act 1954' }],
    }));
    const lta = out.instruments[0];
    expect(lta.status).toBe('changed_since_signing');
    expect(lta.effects_since_signing).toEqual({ amendments: 1, modifications: 1 });
    expect(lta.by_instrument.map((x: any) => x.leg_id).sort()).toEqual(['ukpga/2021/9', 'uksi/2020/1']);
  });

  it('bad input is refused with isError, so the fixed price is not charged', async () => {
    const tools = new UkDueDiligenceTools(mockDb([]));
    for (const args of [
      { as_of: '22/01/2016', citations: [{ instrument: 'x' }] },
      { as_of: '2016-01-22', citations: [] },
      { as_of: '2016-01-22', compare_to: '2015-01-01', citations: [{ instrument: 'x' }] },
      { as_of: '2016-01-22', citations: Array.from({ length: MAX_INSTRUMENTS + 1 }, (_, i) => ({ instrument: `Act ${i}` })) },
    ]) {
      const r: any = await tools.executeTool('uk_check_citations', args);
      expect(r.isError).toBe(true);
    }
  });

  it('is exposed on the curated v2 surface and only under the uk toolset', async () => {
    const { V2_TOOL_NAMES } = await import('../curated-mcp-tools.js');
    expect(V2_TOOL_NAMES.has('uk_check_citations')).toBe(true);
    const tools = new UkDueDiligenceTools(mockDb([]));
    const def = tools.getToolDefinitions()[0];
    expect(def.name).toBe('uk_check_citations');
    expect(def.annotations?.readOnlyHint).toBe(true);
  });
});

describe('uk_check_citations: repeal, removal, commencement and coverage', () => {
  const ERA = 'ukpga/1996/18';
  const db = () => mockDb([
    { match: /WHERE id = \$1/, rows: (p) => [{ id: p[0], title: p[0] === ERA ? 'Employment Rights Act 1996' : 'Scanned Act 1970' }] },
    {
      match: /FROM uk_legislation l LEFT JOIN uk_pit_load_state/,
      rows: (p) => (p[0] === ERA
        ? [{ title: 'Employment Rights Act 1996', versions: 30, last_version: '2025-01-01' }]
        : [{ title: 'Scanned Act 1970', versions: 0, last_version: null }]),
    },
    {
      match: /FROM uk_legislation_effects/,
      rows: (p) => (p[0] === ERA
        ? [{ affected_provisions: 's. 10', effect_type: 'repealed', affecting_id: 'ukpga/2020/5', affecting_title: 'Repealing Act 2020', affecting_provisions: 's. 1', in_force_date: '2020-04-06', applied: true }]
        : []),
    },
    {
      match: /FROM uk_provision_version/,
      rows: [
        { provision_key: `${ERA}/section/10`, valid_from: '2000-01-01', valid_to: '2020-04-06', h: 'dd'.repeat(16) },
        { provision_key: `${ERA}/section/11`, valid_from: '2000-01-01', valid_to: '2019-01-01', h: 'ee'.repeat(16) },
        { provision_key: `${ERA}/section/80N`, valid_from: '2018-01-01', valid_to: null, h: 'ff'.repeat(16) },
      ],
    },
    { match: /FROM uk_provision_text/, rows: [{ h: 'dd'.repeat(16), text: 'text of s.10' }, { h: 'ee'.repeat(16), text: 'text of s.11' }] },
  ]);

  it('a provision repealed after signing is revoked_since_signing, with its text at signing', async () => {
    const d = db();
    const out = parse(await new UkDueDiligenceTools(d).executeTool('uk_check_citations', {
      as_of: '2016-01-22', compare_to: '2026-09-30',
      citations: [{ instrument: ERA, provisions: ['s.10', 's.11', 's.80N'] }, { instrument: 'ukpga/1970/1', provisions: ['s.3'] }],
    }));
    const era = out.instruments.find((i: any) => i.leg_id === ERA);
    const by = Object.fromEntries(era.provisions.map((p: any) => [p.provision, p]));
    expect(by['s.10'].status).toBe('revoked_since_signing');
    expect(by['s.10'].effects[0].by.title).toBe('Repealing Act 2020');
    expect(by['s.10'].text_at_signing).toBe('text of s.10');
    expect(by['s.10'].text_now).toBeNull();
    // Gone from the text without a register entry: still revoked, never "as last seen".
    expect(by['s.11'].status).toBe('revoked_since_signing');
    expect(by['s.11'].removed_on).toBe('2019-01-01');
    expect(by['s.80N'].status).toBe('not_in_force_at_signing');
    expect(by['s.80N'].earliest_version).toBe('2018-01-01');
    expect(era.status).toBe('not_in_force_at_signing');   // worst of its provisions, by SEVERITY

    const scanned = out.instruments.find((i: any) => i.leg_id === 'ukpga/1970/1');
    expect(scanned.provisions[0].status).toBe('no_history');

    // Batched: one version-history query for the act with history, none for the one without.
    expect(d.calls.filter((c) => /FROM uk_provision_version/.test(c.sql))).toHaveLength(1);
  });

  it('refuses an empty instrument and more than the provision cap, uncharged', async () => {
    const tools = new UkDueDiligenceTools(db());
    const empty: any = await tools.executeTool('uk_check_citations', { as_of: '2016-01-22', citations: [{ instrument: ' ' }] });
    expect(empty.isError).toBe(true);
    const many = Array.from({ length: 11 }, (_, i) => ({ instrument: ERA, provisions: [`ss. ${i * 20 + 1}-${i * 20 + 20}`] }));
    const r: any = await tools.executeTool('uk_check_citations', { as_of: '2016-01-22', citations: many });
    expect(r.isError).toBe(true);
    expect(parse(r).message).toContain(String(MAX_PROVISIONS));
  });
});
