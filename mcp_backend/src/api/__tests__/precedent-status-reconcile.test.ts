import { reconcilePrecedentStatus, instanceLevel, statusForEffect } from '../precedent-status-reconcile';

/**
 * LEXAI-2122: check_precedent_status returned `status: valid` together with a non-empty
 * `overruled_by`. The fixtures below are the CitationValidator results prod returned on
 * 2026-10-28 for real cases (affecting_decisions verbatim).
 */
function validatorResult(caseNumber: string, status: string, affecting: any[], overruledBy: string[] = [], distinguished: string[] = []) {
  return {
    case_id: caseNumber,
    status,
    reversed_by: [],
    overruled_by: overruledBy,
    distinguished_in: distinguished,
    last_checked: '2026-10-28T14:06:13.623Z',
    confidence: 0.9,
    shepardization: {
      case_number: caseNumber,
      target_doc_id: '1',
      status,
      confidence: 0.9,
      affecting_decisions: affecting,
      chain_length: 20,
      check_source: 'edrsr',
      checked_at: '2026-10-28T14:06:13.623Z',
    },
  };
}

const VP = { instance: 'Велика Палата ВС', court: 'Велика Палата Верховного Суду' };
const APPEAL = { instance: 'Апеляція', court: 'Харківський апеляційний господарський суд' };

describe('reconcilePrecedentStatus', () => {
  it('922/989/18: Grand Chamber is decisive; 2018 appeal reversals of an ухвала move out of overruled_by', () => {
    const input = validatorResult(
      '922/989/18',
      'valid',
      [
        { doc_id: '90458880', ...VP, date: '2020-06-22T21:00:00.000Z', outcome: 'залишено без змін', effect: 'upheld' },
        { doc_id: '83871497', instance: 'Апеляція', court: 'Східний апеляційний господарський суд', date: '2019-08-18T21:00:00.000Z', outcome: 'скаргу залишено без задоволення', effect: 'upheld' },
        { doc_id: '76542491', ...APPEAL, date: '2018-09-18T21:00:00.000Z', outcome: 'скасовано', effect: 'overruled' },
        { doc_id: '76570168', ...APPEAL, date: '2018-09-18T21:00:00.000Z', outcome: 'скасовано', effect: 'overruled' },
      ],
      ['76542491', '76570168'],
    );

    const out: any = reconcilePrecedentStatus(input);

    expect(out.status).toBe('valid');
    expect(out.overruled_by).toEqual([]);
    expect(out.distinguished_in).toEqual([]);
    expect(out.decided_by).toMatchObject({ doc_id: '90458880', instance: 'Велика Палата ВС', date: '2020-06-23' });
    expect(out.other_reversals.map((d: any) => d.doc_id)).toEqual(['76542491', '76570168']);
    expect(out.other_reversals[0].date).toBe('2018-09-19');
    expect(out.summary).toContain('23.06.2020');
    expect(out.summary).toContain('76542491');
    expect(out.shepardization.status).toBe('valid');
    // raw evidence is kept untouched
    expect(out.shepardization.affecting_decisions).toHaveLength(4);
  });

  it('369/6892/15-ц: fully overturned — overruled_by holds only the decisive Grand Chamber remand', () => {
    const out: any = reconcilePrecedentStatus(
      validatorResult(
        '369/6892/15-ц',
        'explicitly_overruled',
        [
          { doc_id: '75296530', ...VP, date: '2018-05-21T21:00:00.000Z', outcome: 'скасовано та направлено на новий розгляд', effect: 'remanded' },
          { doc_id: '89289804', instance: 'Касація (КЦС ВС)', court: 'Касаційний цивільний суд Верховного Суду', date: '2020-05-12T21:00:00.000Z', outcome: 'скаргу залишено без задоволення', effect: 'upheld' },
          { doc_id: '85676704', instance: 'Апеляція', court: 'Київський апеляційний суд', date: '2019-11-11T22:00:00.000Z', outcome: 'скасовано', effect: 'overruled' },
        ],
        ['75296530', '85676704'],
      ),
    );

    expect(out.status).toBe('explicitly_overruled');
    expect(out.overruled_by).toEqual(['75296530']);
    expect(out.decided_by).toMatchObject({ doc_id: '75296530', date: '2018-05-22', effect: 'remanded' });
    expect(out.other_reversals.map((d: any) => d.doc_id)).toEqual(['85676704']);
  });

  it('127/17566/21: same-day appeal rulings — most severe effect decides, lists follow it', () => {
    const out: any = reconcilePrecedentStatus(
      validatorResult(
        '127/17566/21',
        'limited',
        [
          { doc_id: '109738448', instance: 'Апеляція', court: 'Вінницький апеляційний суд', date: '2023-03-21T22:00:00.000Z', outcome: 'частково задоволено', effect: 'modified' },
          { doc_id: '109809527', instance: 'Апеляція', court: 'Вінницький апеляційний суд', date: '2023-03-21T22:00:00.000Z', outcome: 'скасовано', effect: 'overruled' },
        ],
        ['109809527'],
        ['109738448'],
      ),
    );

    expect(out.status).toBe('explicitly_overruled');
    expect(out.overruled_by).toEqual(['109809527']);
    expect(out.distinguished_in).toEqual(['109738448']);
    expect(out.decided_by.doc_id).toBe('109809527');
    expect(out.shepardization.status).toBe('explicitly_overruled');
  });

  it('partially changed at the top instance → limited, distinguished_in = that decision', () => {
    const out: any = reconcilePrecedentStatus(
      validatorResult('x/1/20', 'limited', [
        { doc_id: '10', ...VP, date: '2021-02-01T22:00:00.000Z', outcome: 'змінено', effect: 'modified' },
        { doc_id: '9', ...APPEAL, date: '2020-02-01T22:00:00.000Z', outcome: 'скасовано', effect: 'overruled' },
      ], ['9'], ['10']),
    );
    expect(out.status).toBe('limited');
    expect(out.overruled_by).toEqual([]);
    expect(out.distinguished_in).toEqual(['10']);
  });

  it('136/2117/18: upheld everywhere → valid with empty lists', () => {
    const out: any = reconcilePrecedentStatus(
      validatorResult('136/2117/18', 'valid', [
        { doc_id: '116172879', instance: 'Апеляція', court: 'Вінницький апеляційний суд', date: '2024-01-08T22:00:00.000Z', outcome: 'залишено без змін', effect: 'upheld' },
        { doc_id: '91968169', instance: 'Апеляція', court: 'Вінницький апеляційний суд', date: '2020-09-30T21:00:00.000Z', outcome: 'залишено без змін', effect: 'upheld' },
      ]),
    );
    expect(out.status).toBe('valid');
    expect(out.overruled_by).toEqual([]);
    expect(out.other_reversals).toEqual([]);
    expect(out.decided_by.doc_id).toBe('116172879');
  });

  it('invariant: non-empty overruled_by ⇔ explicitly_overruled, for every fixture shape', () => {
    const effects = ['upheld', 'modified', 'overruled', 'remanded', 'closed'];
    for (const top of effects) {
      for (const lower of effects) {
        const out: any = reconcilePrecedentStatus(
          validatorResult('inv', 'unknown', [
            { doc_id: 'a', instance: 'Касація (КГС ВС)', court: 'КГС', date: '2022-01-01T22:00:00.000Z', outcome: top, effect: top },
            { doc_id: 'b', instance: 'Апеляція', court: 'АС', date: '2021-01-01T22:00:00.000Z', outcome: lower, effect: lower },
          ]),
        );
        expect(out.overruled_by.length > 0).toBe(out.status === 'explicitly_overruled');
        if (out.status === 'valid') expect(out.distinguished_in).toEqual([]);
      }
    }
  });

  it('a non-date string never wins the decisive-date pick', () => {
    const out: any = reconcilePrecedentStatus(
      validatorResult('d/1/20', 'unknown', [
        { doc_id: 'bad', instance: 'Апеляція', court: 'АС', date: 'не встановлено', outcome: 'скасовано', effect: 'overruled' },
        { doc_id: 'good', instance: 'Апеляція', court: 'АС', date: '2023-03-21T22:00:00.000Z', outcome: 'залишено без змін', effect: 'upheld' },
      ]),
    );
    expect(out.decided_by.doc_id).toBe('good');
    expect(out.status).toBe('valid');
    expect(out.overruled_by).toEqual([]);
    expect(out.other_reversals).toEqual([expect.objectContaining({ doc_id: 'bad', date: undefined })]);
    expect(out.summary).toContain('дата невідома');
  });

  it('no higher-court evidence: keeps status, empties lists, explains', () => {
    const out: any = reconcilePrecedentStatus(validatorResult('n/1/20', 'valid', []));
    expect(out.status).toBe('valid');
    expect(out.decided_by).toBeNull();
    expect(out.summary).toMatch(/не знайдено/);
  });

  it('leaves results without shepardization (local fallback) untouched', () => {
    const local = { case_id: 'abc', status: 'explicitly_overruled', overruled_by: ['x'], confidence: 0.9 };
    expect(reconcilePrecedentStatus(local)).toBe(local);
    const fallback = validatorResult('l', 'explicitly_overruled', [{ doc_id: 'x', instance: 'Невідомо', court: '', outcome: 'overrules', effect: 'overruled' }], ['x']);
    fallback.shepardization.check_source = 'local';
    expect(reconcilePrecedentStatus(fallback)).toBe(fallback);
  });

  it('helpers', () => {
    expect(instanceLevel('Велика Палата ВС')).toBe(4);
    expect(instanceLevel('Касація (КЦС ВС)')).toBe(3);
    expect(instanceLevel('Апеляція')).toBe(2);
    expect(instanceLevel('Перша інстанція')).toBe(1);
    expect(statusForEffect('remanded')).toBe('explicitly_overruled');
    expect(statusForEffect('closed')).toBe('limited');
    expect(statusForEffect('upheld')).toBe('valid');
  });
});
