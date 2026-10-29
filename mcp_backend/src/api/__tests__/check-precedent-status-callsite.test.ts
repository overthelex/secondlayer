import { MCPQueryAPI } from '../mcp-query-api';

/**
 * LEXAI-2122, call-site check: the reconciler must see the object CitationValidator really
 * returns at runtime. In this repo citation-validator.ts is a stub (top-level
 * `affectingDecisions`, always `unknown`); CI overlays the real implementation from
 * secondlayer-core, whose validatePrecedentStatus delegates to ShepardizationService and
 * returns the shape built below (core src/services/citation-validator.ts) — the
 * ShepardizationResult nested under `shepardization`, with overruled_by taken from every
 * overruling entry. That nested shape is also what prod's tool output shows.
 */
function coreValidatorResult(caseNumber: string, shep: any) {
  const overruled = shep.affecting_decisions
    .filter((d: any) => d.effect === 'overruled' || d.effect === 'remanded')
    .map((d: any) => d.doc_id);
  const distinguished = shep.affecting_decisions
    .filter((d: any) => d.effect === 'modified')
    .map((d: any) => d.doc_id);
  return {
    case_id: caseNumber,
    status: shep.status,
    reversed_by: [],
    overruled_by: overruled,
    distinguished_in: distinguished,
    last_checked: shep.checked_at,
    confidence: shep.confidence,
    shepardization: shep,
  };
}

const SHEP_922 = {
  case_number: '922/989/18',
  target_doc_id: '73441144',
  status: 'valid',
  confidence: 0.9,
  affecting_decisions: [
    { doc_id: '90458880', instance: 'Велика Палата ВС', court: 'Велика Палата Верховного Суду', date: '2020-06-22T21:00:00.000Z', outcome: 'залишено без змін', effect: 'upheld' },
    { doc_id: '83871497', instance: 'Апеляція', court: 'Східний апеляційний господарський суд', date: '2019-08-18T21:00:00.000Z', outcome: 'скаргу залишено без задоволення', effect: 'upheld' },
    { doc_id: '76542491', instance: 'Апеляція', court: 'Харківський апеляційний господарський суд', date: '2018-09-18T21:00:00.000Z', outcome: 'скасовано', effect: 'overruled' },
    { doc_id: '76570168', instance: 'Апеляція', court: 'Харківський апеляційний господарський суд', date: '2018-09-18T21:00:00.000Z', outcome: 'скасовано', effect: 'overruled' },
  ],
  chain_length: 29,
  check_source: 'edrsr',
  checked_at: '2026-10-28T14:06:13.623Z',
};

function apiWith(validatorResult: any) {
  const validator = { validatePrecedentStatus: jest.fn().mockResolvedValue(validatorResult) };
  const stub = {} as any;
  const api = new MCPQueryAPI(stub, stub, stub, stub, stub, validator as any, stub, stub);
  return { api, validator };
}

async function call(api: MCPQueryAPI, args: any) {
  const res: any = await api.handleToolCall('check_precedent_status', args);
  expect(res.isError).toBeFalsy();
  return JSON.parse(res.content[0].text);
}

describe('check_precedent_status call site', () => {
  it('reconciles the core CitationValidator shape: 922/989/18 no longer valid + overruled_by', async () => {
    const raw = coreValidatorResult('922/989/18', SHEP_922);
    // Precondition: the unreconciled core result is the contradictory one from the report.
    expect(raw.status).toBe('valid');
    expect(raw.overruled_by).toEqual(['76542491', '76570168']);

    const { api, validator } = apiWith(raw);
    const out = await call(api, { case_number: '922/989/18' });

    expect(validator.validatePrecedentStatus).toHaveBeenCalledWith('', '922/989/18');
    expect(out.status.status).toBe('valid');
    expect(out.status.overruled_by).toEqual([]);
    expect(out.status.decided_by).toMatchObject({ doc_id: '90458880', date: '2020-06-23' });
    expect(out.status.other_reversals.map((d: any) => d.doc_id)).toEqual(['76542491', '76570168']);
    expect(out.status.shepardization.status).toBe('valid');
  });

  it('passes the repo stub shape (top-level affectingDecisions, no shepardization) through unchanged', async () => {
    const stubShape = { status: 'unknown', confidence: 0, affectingDecisions: [] };
    const { api } = apiWith(stubShape);
    const out = await call(api, { case_number: '922/989/18' });
    expect(out.status).toEqual(stubShape);
  });
});
