/**
 * A chapter header whose title wraps across two spans.
 *
 * The usual shape puts the number in one span and the title in the next:
 *   <span class=rvts15>Глава 5 </span><br><span class=rvts15>НАЗВА</span>
 *
 * ЦПК (1618-15) writes Глава 14 differently — number and the START of the title share
 * the first span, the remainder wraps into the second:
 *   <span class=rvts15>Глава 14. Розгляд судом справ про розкриття інформації…</span>
 *   <br><span class=rvts15>на ринках капіталу та організованих товарних ринках</span>
 *
 * Read as the usual shape, the entire first span became the chapter NUMBER: 82
 * characters into a varchar(50). The insert rejected it and the whole act was lost —
 * 546 parsed articles discarded, and ЦПК was the one act of 367 that failed the corpus
 * re-extraction. The title was wrong too, keeping only the wrapped remainder.
 */

import * as cheerio from 'cheerio';
import { RadaLegislationAdapter } from '../rada-legislation-adapter';

const db: any = { query: async () => ({ rows: [], rowCount: 0 }), transaction: async () => ({}) };

const extract = (html: string) => {
  const $ = cheerio.load(RadaLegislationAdapter.normalizeSuperscriptIndexes(html));
  return (new RadaLegislationAdapter(db) as any).extractArticles($, 'test-act') as Array<{
    article_number: string; chapter_number?: string; chapter_title?: string; section_number?: string;
  }>;
};

const body = (headerHtml: string) => `<html><body>
  ${headerHtml}
  <p class=rvps2><span class=rvts9>Стаття 350. Підсудність</span></p>
  <p class=rvps2>1. Заява подається до суду за місцезнаходженням відповідача.</p>
</body></html>`;

describe('chapter header with a wrapped title', () => {
  it('takes the number from the first span and joins both halves of the title', () => {
    const arts = extract(body(
      `<p class=rvps7><span class=rvts15>Глава 14. Розгляд судом справ про розкриття інформації, що становить професійну таємницю</span>
       <br><span class=rvts15>на ринках капіталу та організованих товарних ринках</span></p>`,
    ));

    const a = arts.find((x) => x.article_number === '350');
    expect(a).toBeDefined();
    expect(a!.chapter_number).toBe('14');
    expect(a!.chapter_title).toBe(
      'Розгляд судом справ про розкриття інформації, що становить професійну таємницю ' +
      'на ринках капіталу та організованих товарних ринках',
    );
  });

  it('leaves the ordinary two-span header alone', () => {
    const arts = extract(body(
      `<p class=rvps7><span class=rvts15>Глава 5 </span><br><span class=rvts15>ПІДСУДНІСТЬ</span></p>`,
    ));

    const a = arts.find((x) => x.article_number === '350');
    expect(a!.chapter_number).toBe('5');
    expect(a!.chapter_title).toBe('ПІДСУДНІСТЬ');
  });

  it('keeps a roman section number readable', () => {
    const arts = extract(body(
      `<p class=rvps7><span class=rvts15>Розділ III. Позовне провадження</span>
       <br><span class=rvts15>у судах першої інстанції</span></p>`,
    ));

    const a = arts.find((x) => x.article_number === '350');
    expect(a!.section_number).toBe('3');
  });

  it('never emits a structure number longer than the column allows', () => {
    const arts = extract(body(
      `<p class=rvps7><span class=rvts15>Глава ${'Д'.repeat(80)}</span><br><span class=rvts15>НАЗВА</span></p>`,
    ));

    const a = arts.find((x) => x.article_number === '350');
    expect((a!.chapter_number ?? '').length).toBeLessThanOrEqual(50);
  });
});
