/**
 * checkForChanges reads and retires articles by legislation_id: legislation_articles has no
 * rada_id column, and filtering on it failed with 42703 on every monitoring run.
 */

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { LegislationMonitoringService, normalizeForCompare } from '../legislation-monitoring-service.js';

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

describe('normalizeForCompare', () => {
  it('ignores editorial notes, the as-of date and whitespace', () => {
    const stored = 'Поновлення  договорів оренди землі здійснюється згідно зі статтею 126-1.';
    const fresh = 'Поновлення договорів оренди землі здійснюється згідно зі статтею 126-1. '
      + '[Закон доповнено статтею 32-2 згідно із Законом № 340-IX від 05.12.2019] '
      + '{Із змінами, внесеними згідно із Законом № 1-IX від 01.01.2020}';
    expect(normalizeForCompare(fresh)).toBe(normalizeForCompare(stored));
    expect(normalizeForCompare('чинний; станом на 05.11.2026 чинний'))
      .toBe(normalizeForCompare('чинний; станом на 19.11.2026 чинний'));
    expect(normalizeForCompare('Текст. [Частина друга втратила чинність]')).toBe('Текст.');
  });

  it('still sees a change in the article text itself', () => {
    expect(normalizeForCompare('Строк оренди 7 років.')).not.toBe(normalizeForCompare('Строк оренди 10 років.'));
    // brackets that are not an editorial note are part of the text
    expect(normalizeForCompare('Ставка [5 відсотків].')).not.toBe(normalizeForCompare('Ставка.'));
  });
});

it('checkForChanges reports nothing when only notes and spacing differ', async () => {
  const db: any = {
    query: jest.fn(async (sql: string) => {
      if (sql.startsWith('SELECT id FROM legislation')) return { rows: [{ id: 1 }] };
      if (sql.includes('FROM legislation_articles')) return { rows: [{ article_number: '5', full_text: 'Текст  статті.' }] };
      return { rows: [] };
    }),
  };
  const adapter: any = {
    fetchLegislation: jest.fn(async () => ({
      metadata: {},
      articles: [{ article_number: '5', full_text: 'Текст статті. [Статтю 5 доповнено згідно із Законом № 2-IX]' }],
    })),
    saveLegislationToDatabase: jest.fn(),
  };
  const service = new LegislationMonitoringService(db, adapter, {} as any);
  expect(await service.checkForChanges('161-14')).toEqual([]);
  expect(adapter.saveLegislationToDatabase).not.toHaveBeenCalled();
});
