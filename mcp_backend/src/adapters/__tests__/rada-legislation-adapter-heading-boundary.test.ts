/**
 * An article body must stop at the next structural heading.
 *
 * The article regex has always carried an alternative terminating on a
 * Розділ/Підрозділ/Глава/Книга heading, but it ended in `\b` — and JavaScript defines
 * `\b` over [A-Za-z0-9_] only, so after the Cyrillic «л» of «Розділ» it sits between two
 * non-word characters and never matches. The alternative was dead from the day it was
 * written; only the next «Стаття N.» or end-of-input ever terminated a body.
 *
 * On the Civil Code that put «Розділ II ЗАГАЛЬНІ ПОЛОЖЕННЯ ПРО ДОГОВІР Глава 52 ПОНЯТТЯ
 * ТА УМОВИ ДОГОВОРУ» inside ст. 625, and made ст. 1086 — a repealed article — consist of
 * nothing but the heading of Глава 74.
 *
 * These tests use the same markup shape zakon.rada.gov.ua/print emits.
 */

import * as cheerio from 'cheerio';
import { RadaLegislationAdapter } from '../rada-legislation-adapter';

const db: any = { query: async () => ({ rows: [], rowCount: 0 }), transaction: async () => ({}) };

const extract = (html: string) => {
  const $ = cheerio.load(RadaLegislationAdapter.normalizeSuperscriptIndexes(html));
  return (new RadaLegislationAdapter(db) as any).extractArticles($, 'test-act') as Array<{
    article_number: string; full_text: string;
  }>;
};

const article = (n: string, title: string, body: string) =>
  `<p class=rvps2><span class=rvts9>Стаття ${n}. ${title}</span></p>\n<p class=rvps2>${body}</p>\n`;

const heading = (kind: string, num: string, title: string) =>
  `<p class=rvps7><span class=rvts15>${kind} ${num} </span>\n<br><span class=rvts15>${title}</span></p>\n`;

describe('article bodies stop at a structural heading', () => {
  it.each([
    ['Розділ', 'II', 'ЗАГАЛЬНІ ПОЛОЖЕННЯ ПРО ДОГОВІР'],
    ['Глава', '52', 'ПОНЯТТЯ ТА УМОВИ ДОГОВОРУ'],
    ['Підрозділ', '1', 'ДОГОВІРНІ ЗОБОВ’ЯЗАННЯ'],
    ['Книга', 'п’ята', 'ЗОБОВ’ЯЗАЛЬНЕ ПРАВО'],
  ])('does not swallow a %s heading into the preceding article', (kind, num, title) => {
    const html = `<html><body>
      ${article('625', 'Відповідальність за порушення грошового зобов’язання', '1. Боржник не звільняється від відповідальності за неможливість виконання ним грошового зобов’язання.')}
      ${heading(kind, num, title)}
      ${article('626', 'Поняття та види договору', '1. Договором є домовленість двох або більше сторін.')}
    </body></html>`;

    const arts = extract(html);
    const a625 = arts.find((a) => a.article_number === '625');

    expect(a625).toBeDefined();
    expect(a625!.full_text).not.toContain(title);
    expect(a625!.full_text).not.toContain(`${kind} ${num}`);
    // The article keeps its own text; only the heading is cut.
    expect(a625!.full_text).toContain('Боржник не звільняється');
    // And the article after the heading is still found.
    expect(arts.find((a) => a.article_number === '626')).toBeDefined();
  });

  it('still runs a body to the next article when no heading intervenes', () => {
    const html = `<html><body>
      ${article('624', 'Збитки і неустойка', '1. Якщо за порушення зобов’язання встановлено неустойку.')}
      ${article('625', 'Відповідальність', '1. Боржник не звільняється від відповідальності.')}
    </body></html>`;

    const arts = extract(html);
    expect(arts.map((a) => a.article_number)).toEqual(expect.arrayContaining(['624', '625']));
    expect(arts.find((a) => a.article_number === '624')!.full_text).toContain('неустойку');
    expect(arts.find((a) => a.article_number === '624')!.full_text).not.toContain('Боржник');
  });
});

describe('fetchLegislation rejects an id that would fetch the wrong page', () => {
  const adapter = () => new RadaLegislationAdapter(db);

  it.each(['', '   '])('refuses %p instead of fetching /laws/show//print', async (id) => {
    // RADA answers that URL 200 with its search homepage, the parser reads one "article"
    // out of it, and the caller stores «Універсальний пошук» as a law with an empty
    // rada_id — a row nothing downstream can tell from a real act.
    await expect(adapter().fetchLegislation(id)).rejects.toThrow(/empty id/i);
  });

  it('still rejects ids with characters a law id cannot contain', async () => {
    await expect(adapter().fetchLegislation('435-15?x=1')).rejects.toThrow(/Invalid legislation ID/);
    await expect(adapter().fetchLegislation('../etc/passwd')).rejects.toThrow(/Invalid legislation ID/);
  });
});
