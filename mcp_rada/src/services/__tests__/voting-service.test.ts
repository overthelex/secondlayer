jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../adapters/rada-api-adapter', () => ({ RadaAPIAdapter: class {} }));
jest.mock('../../utils/llm-client-manager', () => ({ getLLMManager: jest.fn() }));
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { VotingService } from '../voting-service';

// LEXAI-2094: trimmed from data.rada.gov.ua/ogd/zal/ppz/skl9/json/12032026.json,
// question 202603123 (bill №13071). One question, three roll-calls, plus a
// speech event with empty-string tallies. id_mp 412 = Железняк Я.І. (rada_id).
const TITLE =
  'Поіменне голосування про підтвердження поправки №2 до проекту Закону про внесення змін до Закону України "Про правовий статус іноземців та осіб без громадянства" (№13071)';

function rollCall(id_event: number, name_event: string, voting_result: number, results: Array<[number, number]>) {
  return {
    date_event: '12.03.2026 10:57:59',
    name_event,
    type_event: 0,
    result_event: [
      {
        id_event,
        absent: 87,
        abstain: 19,
        against: 0,
        for: 219,
        not_voting: 67,
        presence: 305,
        total: 392,
        voting_result,
        result_by_name: results.map(([id_mp, result]) => ({ id_mp, faction: 1, komment: '', result })),
      },
    ],
  };
}

const QUESTION = {
  id_question: 202603123,
  date_question: '12.03.2026 10:54:21',
  event_question: [
    {
      date_event: '12.03.2026 10:54:57',
      name_event: 'Цимбалюк М.М.',
      type_event: 8,
      result_event: [
        {
          id_event: '', absent: '', abstain: '', against: '', for: '', not_voting: '',
          presence: '', result_by_name: [], total: '', voting_result: '',
        },
      ],
    },
    rollCall(34191, TITLE, 0, [[412, 1], [2, 2], [4, 0], [6, 3], [7, 4]]),
    rollCall(34192, TITLE.replace('№2', '№3'), 0, [[412, 1], [4, 0]]),
    rollCall(34193, 'Поіменне голосування про проект Закону ... в цілому (№13071)', 1, [[412, 1]]),
  ],
};

describe('VotingService.transformRawQuestion', () => {
  const records = VotingService.transformRawQuestion(QUESTION, '2026-03-12');

  it('emits one record per roll-call, keyed by id_event, skipping speeches', () => {
    expect(records.map((r) => r.event_id)).toEqual([34191, 34192, 34193]);
    expect(records.every((r) => r.question_number === 202603123)).toBe(true);
  });

  it('maps id_mp to rada_id and numeric result codes to vote labels', () => {
    expect(records[0].votes).toEqual({
      '412': 'За',
      '2': 'Проти',
      '4': 'Відсутній',
      '6': 'Утримався',
      '7': 'Не голосував',
    });
  });

  it('takes the roll-call title, bill number and outcome', () => {
    expect(records[0].question_text).toBe(TITLE);
    expect(records[0].bill_number).toBe('13071');
    expect(records[0].result).toBe('Не прийнято');
    expect(records[2].result).toBe('Прийнято');
    expect(records[0].voted_for).toBe(219);
    expect(records[0].voted_not_present).toBe(67 + 87);
  });

  it('keeps per-deputy votes out of metadata', () => {
    expect(JSON.stringify(records[0].metadata)).not.toContain('result_by_name');
    expect(records[0].metadata.event.result.id_event).toBe(34191);
  });

  it('keeps a single agenda row for a question with no roll-call', () => {
    const agenda = VotingService.transformRawQuestion(
      { id_question: 202603121, event_question: [QUESTION.event_question[0]] },
      '2026-03-12'
    );
    expect(agenda).toHaveLength(1);
    expect(agenda[0].event_id).toBeUndefined();
    expect(agenda[0].question_number).toBe(202603121);
  });
});

describe('VotingService.extractBillNumber', () => {
  it('prefers the parenthesised bill number over an amendment number', () => {
    expect(VotingService.extractBillNumber('поправки №2 до проекту (№13071)')).toBe('13071');
  });
  it('accepts suffixed numbers and ignores short ones', () => {
    expect(VotingService.extractBillNumber('проект Закону №3196-д в цілому')).toBe('3196-д');
    expect(VotingService.extractBillNumber('поправки №12')).toBeUndefined();
    expect(VotingService.extractBillNumber(undefined)).toBeUndefined();
  });
});

describe('VotingService.analyzeVotingRecord', () => {
  it('reads the deputy vote by rada_id over the whole period and counts absences', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ rada_id: '412' }] })
      .mockResolvedValueOnce({
        rows: [
          { session_date: '2026-03-12', question_text: 'a', bill_number: '13071', result: 'Прийнято', vote: 'За' },
          { session_date: '2026-03-12', question_text: 'b', bill_number: null, result: 'Не прийнято', vote: 'Проти' },
          { session_date: '2026-03-11', question_text: 'c', bill_number: null, result: 'Прийнято', vote: 'Відсутній' },
        ],
      });
    const service = new VotingService({ query } as any, {} as any);

    const stats = await service.analyzeVotingRecord({
      deputy_name: 'Железняк',
      date_from: '2026-01-01',
      date_to: '2026-06-30',
    });

    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain('votes ->> $1');
    expect(sql).not.toMatch(/LIMIT/i);
    expect(params).toEqual(['412', '2026-01-01', '2026-06-30']);
    expect(stats.total_votes).toBe(3);
    expect(stats.voted_for).toBe(1);
    expect(stats.voted_against).toBe(1);
    expect(stats.not_present).toBe(1);
  });
});
