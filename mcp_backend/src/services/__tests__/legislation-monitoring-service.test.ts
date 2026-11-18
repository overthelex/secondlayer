/**
 * checkForChanges reads and retires articles by legislation_id: legislation_articles has no
 * rada_id column, and filtering on it failed with 42703 on every monitoring run.
 */

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { LegislationMonitoringService } from '../legislation-monitoring-service.js';

describe('LegislationMonitoringService.checkForChanges', () => {
  it('reads and retires articles by legislation_id, not rada_id', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const db: any = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        if (sql.startsWith('SELECT id FROM legislation')) return { rows: [{ id: 42 }] };
        if (sql.includes('FROM legislation_articles')) {
          return { rows: [{ article_number: '1', full_text: 'old text' }] };
        }
        if (sql.startsWith('INSERT INTO legislation_changes')) return { rows: [{ id: 7 }] };
        return { rows: [] };
      }),
    };
    const adapter: any = {
      fetchLegislation: jest.fn(async () => ({
        metadata: {},
        articles: [{ article_number: '1', full_text: 'new text' }],
      })),
      saveLegislationToDatabase: jest.fn(async () => undefined),
    };
    const service = new LegislationMonitoringService(db, adapter, {} as any);

    const changes = await service.checkForChanges('435-15');

    expect(changes).toHaveLength(1);
    const articleSql = calls.filter((c) => c.sql.includes('legislation_articles'));
    expect(articleSql).toHaveLength(2);
    for (const c of articleSql) {
      expect(c.sql).not.toMatch(/rada_id/);
      expect(c.sql).toMatch(/legislation_id = \$1/);
      expect(c.params).toEqual([42]);
    }
    expect(adapter.saveLegislationToDatabase).toHaveBeenCalled();
  });
});
