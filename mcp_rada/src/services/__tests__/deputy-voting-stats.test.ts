jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));
import { DeputyService } from '../deputy-service';

// LEXAI-2152: include_voting_record always returned zeros (placeholder).
describe('DeputyService voting statistics', () => {
  it('aggregates the stored roll calls for the deputy', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ total: 10, voted_for: 6, voted_against: 1, abstained: 1, not_voted: 1, not_present: 1,
               first_vote: '2019-08-29', last_vote: '2026-10-29' }],
    });
    const service = new DeputyService({ query } as any, {} as any);
    const stats = await (service as any).getVotingStatistics('412');
    expect(query.mock.calls[0][1]).toEqual(['412']);
    expect(query.mock.calls[0][0]).toContain('votes ? $1');
    expect(stats.total_votes).toBe(10);
    expect(stats.not_voted).toBe(1);
    expect(stats.not_present).toBe(1);
    expect(stats.attendance_rate).toBe(90);
  });

  it('returns zeros when the deputy has no stored votes', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ total: 0 }] });
    const service = new DeputyService({ query } as any, {} as any);
    const stats = await (service as any).getVotingStatistics('1');
    expect(stats.total_votes).toBe(0);
  });
});
