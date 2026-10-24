import { LegislationTools } from '../legislation-tools';
import { LegislationService } from '../../services/legislation-service';

/**
 * LEXAI-2106: list_legislation_editions for ЦПК (1618-15) reported
 * article_count 500 for every edition from 2020 on and listed a 2028-01-01
 * edition with no hint that it is not yet in force.
 *  - the stored legislation_editions.article_count is never refreshed on
 *    re-import, so the count must come from the article rows themselves;
 *  - 01.01.2028 is Rada's real deferred edition (підстава 3585-IX) → future;
 *  - editions imported by the pre-LEXAI-1957 parser have no indexed articles
 *    (350-1 …) and must be flagged as incomplete.
 */

function buildTools(editions: any[], structure: any = { title: 'Цивільний процесуальний кодекс України' }) {
  const renderer: any = { renderArticleHTML: jest.fn(), renderMultipleArticlesHTML: jest.fn() };
  return new LegislationTools({
    getEditionDates: jest.fn().mockResolvedValue(editions),
    getLegislationStructure: jest.fn().mockResolvedValue(structure),
  } as any, renderer);
}

function ed(date: string, article_count: number, indexed: number, extra: Partial<Record<string, unknown>> = {}) {
  return {
    edition_date: date,
    article_count,
    stored_article_count: article_count,
    indexed_article_count: indexed,
    future: false,
    rada_total_editions: 121,
    ...extra,
  };
}

describe('list_legislation_editions (LEXAI-2106)', () => {
  // Newest first, as the service returns them.
  const cpk = [
    ed('2028-01-01', 500, 0, { future: true }),
    ed('2025-07-17', 523, 23, { stored_article_count: 500 }),
    ed('2025-07-16', 500, 0),
    ed('2009-06-12', 410, 5),
    ed('2004-03-18', 400, 0),
  ];

  it('marks a deferred (not yet in force) edition as future', async () => {
    const res = await buildTools(cpk).listLegislationEditions({ rada_id: '1618-15' });
    expect(res.editions[0]).toMatchObject({ date: '2028-01-01', future: true, status: 'набирає чинності' });
    expect(res.editions[1].future).toBeUndefined();
    expect(res.note).toContain('ще не набрали чинності');
  });

  it('reports the live article count, not the stale stored one', async () => {
    const res = await buildTools(cpk).listLegislationEditions({ rada_id: '1618-15' });
    expect(res.editions[1]).toEqual({ date: '2025-07-17', article_count: 523 });
  });

  it('flags editions missing indexed articles only after one that had them', async () => {
    const res = await buildTools(cpk).listLegislationEditions({ rada_id: '1618-15' });
    const flagged = res.editions.filter((e: any) => e.indexed_articles_missing).map((e: any) => e.date);
    // 2004-03-18 precedes any indexed article → genuinely none, not flagged.
    expect(flagged).toEqual(['2028-01-01', '2025-07-16']);
    expect(res.note).toContain('2 редакц. завантажено без статей з індексом');
  });

  it('notes editions Rada has that are not loaded yet', async () => {
    const res = await buildTools(cpk).listLegislationEditions({ rada_id: '1618-15' });
    expect(res.total_editions).toBe(5);
    expect(res.rada_total_editions).toBe(121);
    expect(res.note).toContain('На zakon.rada.gov.ua 121 редакц., у базі 5');
  });

  it('keeps the empty-state note', async () => {
    const res = await buildTools([], null).listLegislationEditions({ rada_id: '9999-99' });
    expect(res.total_editions).toBe(0);
    expect(res.note).toBe('Історичні редакції ще не завантажені для цього акту');
  });
});

describe('LegislationService.getEditionDates (LEXAI-2106)', () => {
  function serviceWithRows(rows: any[]) {
    const db = { query: jest.fn().mockResolvedValue({ rows }) };
    const svc = Object.create(LegislationService.prototype) as LegislationService;
    (svc as any).db = db;
    return { svc, db };
  }

  it('counts stored article rows per edition instead of trusting the column', async () => {
    const { svc, db } = serviceWithRows([
      { edition_date: '2025-07-17', stored_article_count: 500, live_article_count: 523, indexed_article_count: 23, future: false, rada_total_editions: 121 },
    ]);
    const [e] = await svc.getEditionDates('1618-15');
    expect(e).toEqual({
      edition_date: '2025-07-17',
      article_count: 523,
      stored_article_count: 500,
      indexed_article_count: 23,
      future: false,
      rada_total_editions: 121,
    });
    const sql: string = db.query.mock.calls[0][0];
    expect(sql).toMatch(/count\(\*\)/i);
    expect(sql).not.toMatch(/LIMIT/i);
    expect(sql).toContain("AT TIME ZONE 'Europe/Kyiv'");
  });

  it('falls back to the stored count when an edition has no article rows', async () => {
    const { svc } = serviceWithRows([
      { edition_date: '2028-01-01', stored_article_count: 500, live_article_count: 0, indexed_article_count: 0, future: true, rada_total_editions: null },
    ]);
    const [e] = await svc.getEditionDates('1618-15');
    expect(e.article_count).toBe(500);
    expect(e.future).toBe(true);
    expect(e.rada_total_editions).toBeNull();
  });
});
