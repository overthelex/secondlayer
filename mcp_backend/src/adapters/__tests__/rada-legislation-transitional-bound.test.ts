/**
 * Bounding the article scan at "Прикінцеві та перехідні положення".
 *
 * The bound existed only for headings wrapped in an rvts15/23 span. Two other shapes
 * occur across the corpus and had no bound at all, so the last article of those acts
 * absorbed the whole transitional block:
 *
 *   (a) the heading is the entire paragraph, unwrapped:
 *       <p class=rvps2><a name="n2639"></a>II. ПРИКІНЦЕВІ ПОЛОЖЕННЯ</p>
 *   (b) older acts render as fixed-width <pre> text and are read by the fallback parser,
 *       which works on $('body').text() — no markup to anchor on at all.
 *
 * Both new shapes demand structural isolation and ALL CAPS, because the danger is real:
 * a mixed-case citation of another act's section once cut КУпАП at 53% and ПКУ at 2%
 * (LEXAI-1821). The position guard is the second line of defence against exactly that.
 */

import * as cheerio from 'cheerio';
import { RadaLegislationAdapter } from '../rada-legislation-adapter';

const db: any = { query: async () => ({ rows: [], rowCount: 0 }), transaction: async () => ({}) };
const adapter = () => new RadaLegislationAdapter(db) as any;

const extract = (html: string, id = 'test-act') => {
  const $ = cheerio.load(RadaLegislationAdapter.normalizeSuperscriptIndexes(html));
  return adapter().extractArticles($, id) as Array<{ article_number: string; full_text: string }>;
};

/** Filler so the transitional block lands in the tail, past the position guard. */
const filler = (n: number) => Array.from({ length: n }, (_v, i) =>
  `<p class=rvps2><span class=rvts9>Стаття ${i + 1}. Норма ${i + 1}</span></p>` +
  `<p class=rvps2>1. Текст норми ${i + 1}, достатньо довгий, щоб зайняти місце в документі.</p>`,
).join('\n');

describe('transitional bound, heading as a whole paragraph', () => {
  it('keeps the block out of the last article', () => {
    const arts = extract(`<html><body>
      ${filler(20)}
      <p class=rvps2><a name="n999"></a>
      II. ПРИКІНЦЕВІ ПОЛОЖЕННЯ</p>
      <p class=rvps2>1. Цей Закон набирає чинності з дня його опублікування.</p>
    </body></html>`);

    const last = arts.find((a) => a.article_number === '20');
    expect(last).toBeDefined();
    expect(last!.full_text).not.toContain('ПРИКІНЦЕВІ');
    expect(last!.full_text).not.toContain('набирає чинності');
    expect(arts).toHaveLength(20);
  });

  it('ignores a mixed-case citation sharing a paragraph with other text', () => {
    const arts = extract(`<html><body>
      ${filler(20)}
      <p class=rvps2>1. Застосовується з урахуванням пункту 8 розділу II "Прикінцеві та перехідні положення" іншого закону.</p>
    </body></html>`);

    // The citation must not cut the scan: every article survives.
    expect(arts).toHaveLength(20);
  });
});

describe('transitional bound, <pre> acts read by the fallback parser', () => {
  const preAct = (tail: string) => `<html><body><pre>${
    Array.from({ length: 12 }, (_v, i) => `     Стаття ${i + 1}. Норма ${i + 1} <br>\n     Текст норми ${i + 1}, достатньо довгий рядок для заповнення. <br>`).join('\n')
  }</pre><pre>${tail}</pre></body></html>`;

  it('keeps the block out of the last article', () => {
    const arts = extract(preAct(
      `                            <b>Розділ VII</b> <br>\n                       ПРИКІНЦЕВІ ПОЛОЖЕННЯ <br>\n     1. Цей Закон набирає чинності з дня його опублікування. <br>`,
    ));

    const last = arts.find((a) => a.article_number === '12');
    expect(last).toBeDefined();
    expect(last!.full_text).not.toContain('ПРИКІНЦЕВІ');
    expect(last!.full_text).not.toContain('набирає чинності');
  });

  it('ignores a mixed-case citation on a line with other words', () => {
    const arts = extract(preAct(
      `     Стаття 13. Остання <br>\n     1. Крім пункту 8 розділу II "Прикінцеві та перехідні положення" цього Закону. <br>`,
    ));

    expect(arts.find((a) => a.article_number === '13')).toBeDefined();
  });
});

describe('position guard', () => {
  it('ignores a heading that would cut the body rather than the tail', () => {
    // Heading right at the top: a real transitional section never sits there.
    const arts = extract(`<html><body>
      <p class=rvps2>ПРИКІНЦЕВІ ПОЛОЖЕННЯ</p>
      ${filler(20)}
    </body></html>`);

    expect(arts).toHaveLength(20);
  });
});
