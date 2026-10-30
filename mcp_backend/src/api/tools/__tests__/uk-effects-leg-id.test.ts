/**
 * uk_get_effects with a calendar-year leg_id for a pre-1963 act. The register keys the
 * Landlord and Tenant Act 1954 as `ukpga/Eliz2/2-3/56`; `ukpga/1954/56` used to match no
 * effect and answer "no effects recorded". The database is mocked — no network.
 */

jest.mock('../../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { UkLegislationTools, calendarParts } from '../uk-legislation-tools.js';

const EFFECT = {
  affected_provisions: 's. 24(1)',
  effect_type: 'words substituted',
  affecting_id: 'uksi/2003/3096',
  affecting_title: 'The Regulatory Reform (Business Tenancies) (England and Wales) Order 2003',
  affecting_provisions: 'art. 3(1)',
  in_force_date: '2004-06-01',
  applied: true,
  affected_extent: 'E+W',
  commencement_authority: null,
  notes: null,
};

/** First query = the leg_id lookup, second = the effects. */
function toolsWith(lookup: any[], effects: any[] = [EFFECT]) {
  const db = {
    query: jest.fn()
      .mockResolvedValueOnce({ rows: lookup })
      .mockResolvedValueOnce({ rows: effects }),
  };
  return { tools: new UkLegislationTools(db), db };
}

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('calendarParts', () => {
  it('splits a calendar-year id', () => {
    expect(calendarParts('ukpga/1954/56')).toEqual({ leg_type: 'ukpga', year: 1954, number: '56' });
  });
  it('leaves regnal and other ids alone', () => {
    expect(calendarParts('ukpga/Eliz2/2-3/56')).toBeNull();
    expect(calendarParts('aep/Hen3/23')).toBeNull();
  });
});

describe('uk_get_effects leg_id resolution', () => {
  it('maps a calendar-year id onto the one regnal act it names', async () => {
    const { tools, db } = toolsWith([
      { id: 'ukpga/Eliz2/2-3/56', title: 'Landlord and Tenant Act 1954', exact: false },
    ]);
    const out = parse(await tools.executeTool('uk_get_effects', { leg_id: 'ukpga/1954/56', provision: '24' }));
    expect(out.leg_id).toBe('ukpga/Eliz2/2-3/56');
    expect(out.resolved_from).toBe('ukpga/1954/56');
    expect(out.total).toBe(1);
    expect(db.query.mock.calls[1][1][0]).toBe('ukpga/Eliz2/2-3/56');
    expect(out.source).toBe('https://www.legislation.gov.uk/changes/affected/ukpga/Eliz2/2-3/56');
  });

  it('never rewrites an id the register holds', async () => {
    const { tools, db } = toolsWith([
      { id: 'ukpga/1986/45', title: 'Insolvency Act 1986', exact: true },
    ]);
    const out = parse(await tools.executeTool('uk_get_effects', { leg_id: 'ukpga/1986/45' }));
    expect(out.leg_id).toBe('ukpga/1986/45');
    expect(out.resolved_from).toBeUndefined();
    expect(db.query.mock.calls[1][1][0]).toBe('ukpga/1986/45');
  });

  it('refuses to guess when one calendar year holds two sessions', async () => {
    const { tools, db } = toolsWith([
      { id: 'ukpga/Eliz2/2-3/10', title: 'First Act', exact: false },
      { id: 'ukpga/Eliz2/3-4/10', title: 'Second Act', exact: false },
    ]);
    const out = parse(await tools.executeTool('uk_get_effects', { leg_id: 'ukpga/1954/10' }));
    expect(out.error).toBe('ambiguous_leg_id');
    expect(out.candidates.map((c: any) => c.leg_id)).toEqual(['ukpga/Eliz2/2-3/10', 'ukpga/Eliz2/3-4/10']);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('keeps an id the register does not know, since effects can name such acts', async () => {
    const { tools, db } = toolsWith([]);
    const out = parse(await tools.executeTool('uk_get_effects', { leg_id: 'ukpga/2030/1' }));
    expect(out.leg_id).toBe('ukpga/2030/1');
    expect(db.query.mock.calls[1][1][0]).toBe('ukpga/2030/1');
  });

  it('does not read the lookup for tools without a leg_id', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const tools = new UkLegislationTools(db);
    await tools.executeTool('uk_search_legislation', { query: 'ukpga/1954/56' });
    expect(db.query.mock.calls[0][0]).not.toMatch(/exact/);
  });

  it('skips the lookup for a regnal id', async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [EFFECT] }) };
    const tools = new UkLegislationTools(db);
    const out = parse(await tools.executeTool('uk_get_effects', { leg_id: 'ukpga/Eliz2/2-3/56' }));
    expect(out.total).toBe(1);
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

describe('the other leg_id tools resolve the same way', () => {
  const LTA = [{ id: 'ukpga/Eliz2/2-3/56', title: 'Landlord and Tenant Act 1954', exact: false }];

  it('uk_get_act finds the act by its calendar-year id', async () => {
    const db = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: LTA })
        .mockResolvedValueOnce({ rows: [{ id: 'ukpga/Eliz2/2-3/56', title: 'Landlord and Tenant Act 1954' }] })
        .mockResolvedValueOnce({ rows: [{ provisions: 120, pit_rows: 900, versions: 45 }] })
        .mockResolvedValueOnce({ rows: [{ total: 300, applied: 294, unapplied: 6 }] }),
    };
    const out = parse(await new UkLegislationTools(db).executeTool('uk_get_act', { leg_id: 'ukpga/1954/56' }));
    expect(out.resolved_from).toBe('ukpga/1954/56');
    expect(out.act.id).toBe('ukpga/Eliz2/2-3/56');
    expect(db.query.mock.calls.slice(1).every((c: any[]) => c[1][0] === 'ukpga/Eliz2/2-3/56')).toBe(true);
  });

  it('uk_get_provision reads the provision under the regnal id', async () => {
    const db = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: LTA })
        .mockResolvedValueOnce({ rows: [{ provision_key: 'ukpga/Eliz2/2-3/56/section/24', text: 'x' }] }),
    };
    const out = parse(await new UkLegislationTools(db).executeTool('uk_get_provision', { leg_id: 'ukpga/1954/56', provision: '24' }));
    expect(out.resolved_from).toBe('ukpga/1954/56');
    expect(out.leg_id).toBe('ukpga/Eliz2/2-3/56');
    expect(db.query.mock.calls[1][1][0]).toBe('ukpga/Eliz2/2-3/56');
  });

  it('says resolved_from on an error reply too', async () => {
    const db = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: LTA })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ n: 0 }] }),
    };
    const out = parse(await new UkLegislationTools(db).executeTool('uk_get_provision_history', { leg_id: 'ukpga/1954/56', provision: '999' }));
    expect(out.resolved_from).toBe('ukpga/1954/56');
    expect(out.leg_id).toBe('ukpga/Eliz2/2-3/56');
    expect(out.error).toBe('no_point_in_time');
  });

  it('uk_get_act_as_at refuses an ambiguous id before touching the text', async () => {
    const db = {
      query: jest.fn().mockResolvedValueOnce({ rows: [
        { id: 'ukpga/Eliz2/2-3/10', title: 'First Act', exact: false },
        { id: 'ukpga/Eliz2/3-4/10', title: 'Second Act', exact: false },
      ] }),
    };
    const out = parse(await new UkLegislationTools(db).executeTool('uk_get_act_as_at', { leg_id: 'ukpga/1954/10', as_of: '2000-01-01' }));
    expect(out.error).toBe('ambiguous_leg_id');
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

describe('uk_get_effects ordering (LEXAI-2134)', () => {
  it('lists effects on the provision before Part and whole-act effects', async () => {
    const e = (affected: string, date: string) => ({ ...EFFECT, affected_provisions: affected, effect_type: 'excluded', in_force_date: date });
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [e('Act', '2003-03-24'), e('Pt. 2', '2005-01-01'), e('s. 24(1)', '2010-01-01'), e('s. 24-28', '2024-12-02')] }) };
    const out = parse(await new UkLegislationTools(db).executeTool('uk_get_effects', { leg_id: 'ukpga/Eliz2/2-3/56', provision: '24' }));
    expect(out.effects.map((x: any) => x.scope)).toEqual(['provision', 'provision', 'part', 'whole_instrument']);
    expect(out.effects[0].in_force_date).toBe('2010-01-01');
  });
});
