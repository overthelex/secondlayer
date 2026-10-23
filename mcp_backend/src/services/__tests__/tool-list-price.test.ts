import { CostTracker } from '../cost-tracker';
import { resetToolListPriceCache } from '../tool-list-price';
import { resetFixedToolPriceCache } from '../tool-fixed-price';

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

type Row = Record<string, any>;

const PRICING: Row[] = [
  { tool_name: 'get_legislation_articles', base_cost_usd: '0.00100000', markup_percent: '0.0000', fixed_price: null },
  { tool_name: 'search_court_decisions', base_cost_usd: '0.01000000', markup_percent: '0.0000', fixed_price: null },
  { tool_name: 'marked_up_tool', base_cost_usd: '0.01000000', markup_percent: '50.0000', fixed_price: null },
  { tool_name: 'ai_chat', base_cost_usd: '0.05000000', markup_percent: '0.0000', fixed_price: null },
  { tool_name: 'uk_get_act', base_cost_usd: '0.00000000', markup_percent: '0.0000', fixed_price: '0.02', fixed_price_currency: 'GBP' },
];

/** In-memory stand-in for cost_tracking + tool_pricing as CostTracker queries them. */
function fakeDb(record: Row) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('FROM cost_tracking WHERE request_id')) return { rows: [record] };
    if (sql.includes('base_cost_usd, markup_percent') && sql.includes('FROM tool_pricing')) {
      return { rows: PRICING.filter((r) => r.fixed_price === null && Number(r.base_cost_usd) > 0) };
    }
    if (sql.includes('fixed_price, fixed_price_currency') && sql.includes('FROM tool_pricing')) {
      return { rows: PRICING.filter((r) => r.fixed_price !== null) };
    }
    if (sql.includes('UPDATE cost_tracking')) return { rows: [] };
    if (sql.includes('monthly_api_usage')) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  });
  return { db: { query } as any, query };
}

function trackerFor(record: Row) {
  const { db } = fakeDb({ request_id: 'r1', user_id: 'u1', user_query: 'q', ...record });
  const tracker = new CostTracker(db);
  const chargeUser = jest.fn(async () => undefined);
  tracker.setBillingService({ chargeUser } as any);
  return { tracker, chargeUser };
}

beforeEach(() => {
  resetToolListPriceCache();
  resetFixedToolPriceCache();
});

describe('CostTracker list-price billing', () => {
  it('charges the list price for a DB lookup with no usage cost', async () => {
    const { tracker, chargeUser } = trackerFor({ tool_name: 'get_legislation_articles' });
    const breakdown = await tracker.completeTrackingRecord({ requestId: 'r1', executionTimeMs: 5, status: 'completed' });
    expect(breakdown.totals.cost_usd).toBeCloseTo(0.001, 9);
    expect(chargeUser).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: expect.closeTo(0.001, 9) }));
  });

  it('applies the per-tool markup_percent to the list price', async () => {
    const { tracker, chargeUser } = trackerFor({ tool_name: 'marked_up_tool' });
    await tracker.completeTrackingRecord({ requestId: 'r1', executionTimeMs: 5, status: 'completed' });
    expect(chargeUser).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: expect.closeTo(0.015, 9) }));
  });

  it('tops usage up to the list price when usage is lower', async () => {
    const { tracker, chargeUser } = trackerFor({ tool_name: 'search_court_decisions', openai_cost_usd: '0.003' });
    await tracker.completeTrackingRecord({ requestId: 'r1', executionTimeMs: 5, status: 'completed' });
    expect(chargeUser).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: expect.closeTo(0.01, 9) }));
  });

  it('charges actual usage when it exceeds the list price', async () => {
    const { tracker, chargeUser } = trackerFor({
      tool_name: 'search_court_decisions', openai_cost_usd: '0.012', secondlayer_cost_usd: '0.004',
    });
    await tracker.completeTrackingRecord({ requestId: 'r1', executionTimeMs: 5, status: 'completed' });
    expect(chargeUser).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: expect.closeTo(0.016, 9) }));
  });

  it('leaves ai_chat on token billing (its row is an average cost, not a price)', async () => {
    const { tracker, chargeUser } = trackerFor({ tool_name: 'ai_chat', anthropic_cost_usd: '0.02' });
    await tracker.completeTrackingRecord({ requestId: 'r1', executionTimeMs: 5, status: 'completed' });
    expect(chargeUser).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: expect.closeTo(0.02, 9) }));
  });

  it('does not charge a tool without a list price and without usage', async () => {
    const { tracker, chargeUser } = trackerFor({ tool_name: 'unpriced_tool' });
    await tracker.completeTrackingRecord({ requestId: 'r1', executionTimeMs: 5, status: 'completed' });
    expect(chargeUser).not.toHaveBeenCalled();
  });

  it('never charges a failed call', async () => {
    const { tracker, chargeUser } = trackerFor({ tool_name: 'search_court_decisions' });
    await tracker.completeTrackingRecord({ requestId: 'r1', executionTimeMs: 5, status: 'failed' });
    expect(chargeUser).not.toHaveBeenCalled();
  });

  it('leaves fixed-price tools to FixedPriceBilling', async () => {
    const { tracker, chargeUser } = trackerFor({ tool_name: 'uk_get_act' });
    await tracker.completeTrackingRecord({ requestId: 'r1', executionTimeMs: 5, status: 'completed' });
    expect(chargeUser).not.toHaveBeenCalled();
  });

  it('pre-flight estimate is at least the list price', async () => {
    const { tracker } = trackerFor({});
    const est = await tracker.estimateCost({ toolName: 'marked_up_tool', queryLength: 10, reasoningBudget: 'quick' });
    expect(est.total_estimated_cost_usd).toBeGreaterThanOrEqual(0.015);
  });
});
