import { parseTrailingHeadings, withRecoveredHierarchy } from '../legislation-heading-recovery.js';

describe('parseTrailingHeadings', () => {
  it('reads a chain of headings glued to the end of an article', () => {
    expect(
      parseTrailingHeadings(
        '2. Боржник … три проценти річних. Розділ II ЗАГАЛЬНІ ПОЛОЖЕННЯ ПРО ДОГОВІР Глава 52 ПОНЯТТЯ ТА УМОВИ ДОГОВОРУ'
      )
    ).toEqual([
      { level: 'section', number: 'II', title: 'ЗАГАЛЬНІ ПОЛОЖЕННЯ ПРО ДОГОВІР' },
      { level: 'chapter', number: '52', title: 'ПОНЯТТЯ ТА УМОВИ ДОГОВОРУ' },
    ]);
  });

  it('reads subsections and § headings with lower-case titles', () => {
    expect(
      parseTrailingHeadings('… вважаються погашеними. Глава 8 ПІДПРИЄМНИЦЬКІ ТОВАРИСТВА § 1. Господарські товариства')
    ).toEqual([
      { level: 'chapter', number: '8', title: 'ПІДПРИЄМНИЦЬКІ ТОВАРИСТВА' },
      { level: 'paragraph', number: '1', title: 'Господарські товариства' },
    ]);
    expect(parseTrailingHeadings('… до суду. Підрозділ 2 ЮРИДИЧНА ОСОБА Глава 7 ЗАГАЛЬНІ ПОЛОЖЕННЯ ПРО ЮРИДИЧНУ ОСОБУ'))
      .toEqual([
        { level: 'subsection', number: '2', title: 'ЮРИДИЧНА ОСОБА' },
        { level: 'chapter', number: '7', title: 'ЗАГАЛЬНІ ПОЛОЖЕННЯ ПРО ЮРИДИЧНУ ОСОБУ' },
      ]);
  });

  it('ignores in-sentence references and plain texts', () => {
    expect(parseTrailingHeadings('Порядок визначається відповідно до Глава 3 цього Кодексу')).toEqual([]);
    expect(parseTrailingHeadings('Апеляційна скарга подається безпосередньо до суду апеляційної інстанції.')).toEqual([]);
    expect(parseTrailingHeadings(null)).toEqual([]);
  });
});

describe('withRecoveredHierarchy', () => {
  const art = (n: string, full_text: string, extra: Record<string, any> = {}) => ({
    article_number: n, title: `ст. ${n}`, full_text, section_number: null, chapter_number: null, metadata: {}, ...extra,
  });

  it('assigns each heading to the articles that follow it', () => {
    const out = withRecoveredHierarchy([
      art('1', 'Текст. Розділ II ОСОБИ Глава 4 ФІЗИЧНА ОСОБА'),
      art('2', 'Текст. Глава 5 ПІДПРИЄМЕЦЬ'),
      art('3', 'Текст. Книга 2 ОСОБИСТІ ПРАВА Розділ I ЗАГАЛЬНІ ПОЛОЖЕННЯ'),
      art('4', 'Текст.'),
    ]);
    expect(out[0].section_number).toBeNull();
    expect(out[1]).toMatchObject({ section_number: 'II', section_title: 'ОСОБИ', chapter_number: '4' });
    expect(out[2]).toMatchObject({ section_number: 'II', chapter_number: '5', chapter_title: 'ПІДПРИЄМЕЦЬ' });
    // A new book resets section and chapter; section keys carry the book so they stay unique.
    expect(out[3]).toMatchObject({ section_number: '2.I', chapter_number: null });
    expect(out[3].metadata).toMatchObject({ book_number: '2', book_title: 'ОСОБИСТІ ПРАВА' });
  });

  it('leaves acts with stored hierarchy or no headings untouched', () => {
    const stored = [art('1', 'Текст. Глава 2 ІНШЕ', { chapter_number: '1' })];
    expect(withRecoveredHierarchy(stored)).toBe(stored);
    const plain = [art('1', 'Текст.'), art('2', 'Ще текст.')];
    expect(withRecoveredHierarchy(plain)).toBe(plain);
  });
});

describe('parseTrailingHeadings: dotted sentence-case style (ЦПК)', () => {
  it('reads "Глава N. Title" and "§ N. Title"', () => {
    expect(parseTrailingHeadings('… інтереси. Глава 2. Цивільна юрисдикція § 1. Предметна та суб’єктна юрисдикція')).toEqual([
      { level: 'chapter', number: '2', title: 'Цивільна юрисдикція' },
      { level: 'paragraph', number: '1', title: 'Предметна та суб’єктна юрисдикція' },
    ]);
    expect(parseTrailingHeadings('… цим Кодексом. Глава 3. Склад суду. Відводи')).toEqual([
      { level: 'chapter', number: '3', title: 'Склад суду. Відводи' },
    ]);
  });
});
