/**
 * Where an article title comes from.
 *
 * Acts write the header two ways. Some keep the title inside the header span:
 *   <span class=rvts9>Стаття 14. Визначення понять</span>
 * Most close the paragraph with it instead:
 *   <span class=rvts9>Стаття 625.</span> Відповідальність за порушення грошового зобов'язання</p>
 *
 * Only the first was read from the markup. The second fell back to splitting the body on
 * its first "." — and a body reads «НАЗВА 1. Текст частини першої», so the split returned
 * the title with the part number attached: «Крадіжка 1», «Розірвання спадкового договору
 * 1». 11,549 of 25,383 stored articles carried one. Where the first sentence ran long the
 * heuristic stored no title at all despite the markup having one (2,746 more).
 *
 * The paragraph slot is not always a title, though: in acts whose articles are untitled —
 * the Constitution among them — it holds the first sentence of the body. A title is a noun
 * phrase and does not end in sentence punctuation, which is the only signal available.
 */

import * as cheerio from 'cheerio';
import { RadaLegislationAdapter } from '../rada-legislation-adapter';

const db: any = { query: async () => ({ rows: [], rowCount: 0 }), transaction: async () => ({}) };

/**
 * extractArticles hands the whole document to a text-based fallback parser when it finds
 * fewer than five articles, so a one-article fixture silently tests the wrong code path.
 * Pad every fixture past that threshold.
 */
const padding = Array.from({ length: 8 }, (_v, i) =>
  `<p class=rvps2><span class=rvts9>Стаття ${900 + i}.</span> Заповнення ${i}</p>` +
  `<p class=rvps2>1. Текст норми ${i}, достатньо довгий, щоб документ не був порожнім.</p>`,
).join('\n');

const titleOf = (headerHtml: string, body: string, num = '625') => {
  const html = `<html><body>
    <p class=rvps2>${headerHtml}</p>
    <p class=rvps2>${body}</p>
    ${padding}
  </body></html>`;
  const $ = cheerio.load(RadaLegislationAdapter.normalizeSuperscriptIndexes(html));
  const arts = (new RadaLegislationAdapter(db) as any).extractArticles($, 'test-act');
  expect(arts.length).toBeGreaterThanOrEqual(5); // the main parser ran, not the fallback
  return arts.find((a: any) => a.article_number === num)?.title;
};

describe('article title', () => {
  it('reads the title that closes the header paragraph', () => {
    expect(titleOf(
      `<span class=rvts9>Стаття 625.</span> Відповідальність за порушення грошового зобов'язання`,
      '1. Боржник не звільняється від відповідальності за неможливість виконання.',
    )).toBe("Відповідальність за порушення грошового зобов'язання");
  });

  it('never leaves the part number attached to it', () => {
    const title = titleOf(
      `<span class=rvts9>Стаття 185.</span> Крадіжка`,
      '1. Таємне викрадення чужого майна (крадіжка) - карається штрафом.',
      '185',
    );
    expect(title).toBe('Крадіжка');
    expect(title).not.toMatch(/ \d+$/);
  });

  it('still prefers a title written inside the span', () => {
    expect(titleOf(
      `<span class=rvts9>Стаття 14. Визначення понять</span>`,
      '1. У цьому Кодексі терміни вживаються в такому значенні.',
      '14',
    )).toBe('Визначення понять');
  });

  it('stores no title when the slot holds the body, not a title', () => {
    // The Constitution: ст. 1 has no title, and its first sentence sits where a title
    // would. Storing it produced 158 articles "titled" with their own opening line.
    expect(titleOf(
      `<span class=rvts9>Стаття 1.</span> Україна є суверенна і незалежна, демократична, соціальна, правова держава.`,
      'Стаття 2. Суверенітет України поширюється на всю її територію.',
      '1',
    )).toBeUndefined();
  });

  it('stores no title when the header paragraph ends right after the number', () => {
    expect(titleOf(
      `<span class=rvts9>Стаття 350.</span>`,
      '1. Заява подається до суду за місцезнаходженням відповідача.',
      '350',
    )).toBeUndefined();
  });
});

describe('transitional points carry no title', () => {
  it('does not label a point with its own truncated first line', () => {
    const html = `<html><body>
      ${Array.from({ length: 12 }, (_v, i) =>
        `<p class=rvps2><span class=rvts9>Стаття ${i + 1}.</span> Норма ${i + 1}</p>` +
        `<p class=rvps2>1. Текст норми ${i + 1}, достатньо довгий для заповнення документа.</p>`).join('\n')}
      <p class=rvps7><span class=rvts15>ПРИКІНЦЕВІ ТА ПЕРЕХІДНІ ПОЛОЖЕННЯ</span></p>
      <p class=rvps2><a name="n5001"></a>
      1. Закони та інші нормативні акти, прийняті до набуття чинності цією Конституцією, є чинними у частині, що не суперечить Конституції України, довгий текст який раніше різали посеред слова.</p>
    </body></html>`;
    const $ = cheerio.load(RadaLegislationAdapter.normalizeSuperscriptIndexes(html));
    const arts = (new RadaLegislationAdapter(db) as any).extractArticles($, 'test-act');

    const point = arts.find((a: any) => a.article_number.startsWith('п.'));
    expect(point).toBeDefined();
    expect(point.title).toBeUndefined();
  });
});
