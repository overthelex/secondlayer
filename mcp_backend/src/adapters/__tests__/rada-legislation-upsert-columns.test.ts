/**
 * Re-extracting an act must refresh everything the parser produces.
 *
 * The article upsert listed only some columns in its DO UPDATE. title, notes,
 * part_number, paragraph_number and metadata were missing, so a re-import rewrote the
 * text of an existing article and left the rest as the first import had stored it. Any
 * parser fix for those fields reached newly inserted rows only.
 *
 * That is not a subtle failure. A corpus pass refreshed 22,756 articles and the number
 * of titles carrying a stray part number moved by zero, and ЦК ст. 625 kept reporting
 * extraction_date 2026-06-09 long after being re-extracted — the tell I walked past
 * twice before measuring instead of assuming.
 *
 * Rather than pin today's column list, this derives it from the INSERT itself, so a
 * column added later cannot quietly go unrefreshed.
 */

import { RadaLegislationAdapter } from '../rada-legislation-adapter';

/** Set once by the parser and never rewritten on conflict, each for its own reason. */
const INTENTIONALLY_NOT_UPDATED = new Set([
  'legislation_id',   // part of the conflict key
  'article_number',   // part of the conflict key
  'version_date',     // part of the conflict key
  'is_current',       // retiring a superseded edition must not be undone by a re-import
]);

describe('legislation_articles upsert', () => {
  const captured: string[] = [];

  const db: any = {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async (cb: (client: any) => Promise<any>) => cb({
      query: async (sql: string) => {
        captured.push(sql);
        return { rows: [{ id: 1 }], rowCount: 1 };
      },
    }),
  };

  beforeAll(async () => {
    await new RadaLegislationAdapter(db).saveLegislationToDatabase(
      { rada_id: 'test-act', type: 'law', title: 'Тест', full_url: 'https://example.test', status: 'active' } as any,
      [{
        article_number: '1', title: 'Назва', full_text: 'Текст норми', byte_size: 11,
        section_number: '1', section_title: 'РОЗДІЛ', chapter_number: '1', chapter_title: 'ГЛАВА',
      } as any],
    );
  });

  it('refreshes every column the insert writes', () => {
    const sql = captured.find((q) => q.includes('INSERT INTO legislation_articles'));
    expect(sql).toBeDefined();

    const insertColumns = /INSERT INTO legislation_articles\s*\(([\s\S]*?)\)\s*VALUES/i
      .exec(sql!)?.[1]
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean) ?? [];
    expect(insertColumns.length).toBeGreaterThan(10);

    const doUpdate = sql!.slice(sql!.indexOf('DO UPDATE SET'));
    const missing = insertColumns.filter(
      (c) => !INTENTIONALLY_NOT_UPDATED.has(c) && !new RegExp(`\\b${c}\\s*=\\s*EXCLUDED\\.${c}\\b`).test(doUpdate),
    );

    expect(missing).toEqual([]);
  });

  it('does not resurrect a retired edition by rewriting is_current', () => {
    const sql = captured.find((q) => q.includes('INSERT INTO legislation_articles'))!;
    const doUpdate = sql.slice(sql.indexOf('DO UPDATE SET'));
    expect(doUpdate).not.toMatch(/is_current\s*=\s*EXCLUDED\.is_current/);
  });
});
