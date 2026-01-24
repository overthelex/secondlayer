import { BaseCostTracker } from '../src/services/base-cost-tracker';
import type { CostEstimate } from '../src/types/cost';

class FakeDB {
  query = jest.fn(async (_text: string, _params?: any[]) => ({ rows: [] as any[] }));
}

class TestCostTracker extends BaseCostTracker {
  async estimateCost(): Promise<CostEstimate> {
    return {
      openai_estimated_tokens: 0,
      openai_estimated_cost_usd: 0,
      secondlayer_estimated_calls: 0,
      secondlayer_estimated_cost_usd: 0,
      total_estimated_cost_usd: 0,
      estimation_notes: [],
    };
  }
}

describe('BaseCostTracker', () => {
  test('createTrackingRecord inserts pending record with JSON params', async () => {
    const db = new FakeDB();
    const tracker = new TestCostTracker(db as any);

    await tracker.createTrackingRecord({
      requestId: 'req-1',
      toolName: 'tool',
      clientKey: 'key',
      userQuery: 'hello',
      queryParams: { a: 1 },
    });

    expect(db.query).toHaveBeenCalledTimes(1);
    const call = db.query.mock.calls[0];
    expect(call[0]).toContain('INSERT INTO cost_tracking');
    expect(call[1]).toEqual([
      'req-1',
      'tool',
      'key',
      'hello',
      JSON.stringify({ a: 1 }),
      'pending',
    ]);
  });

  test('recordSecondLayerCall skips cached calls', async () => {
    const db = new FakeDB();
    const tracker = new TestCostTracker(db as any);

    await tracker.recordSecondLayerCall({
      requestId: 'req-2',
      operation: 'op',
      cached: true,
    });

    expect(db.query).not.toHaveBeenCalled();
  });
});
