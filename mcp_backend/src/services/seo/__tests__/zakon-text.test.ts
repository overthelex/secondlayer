import { parseArticleBody, parseStructure, sentenceCase } from '../zakon-text.js';
import { artNoFromSlug, articleSlug, codeBySlug, ZAKON_CODES } from '../zakon-codes.js';

describe('parseArticleBody', () => {
  it('splits heading and paragraphs, marks amendment notes', () => {
    const a = parseArticleBody(
      "Стаття 625. Відповідальність за порушення грошового зобов'язання\n1. Боржник не звільняється.\n2. Боржник сплачує три проценти річних.\n{Стаття 625 із змінами}",
      true,
    )!;
    expect(a.artNo).toBe('625');
    expect(a.title).toBe("Відповідальність за порушення грошового зобов'язання");
    expect(a.paragraphs.map(p => p.note)).toEqual([false, false, true]);
  });

  it('normalises spaced article numbers and treats the Constitution heading line as text', () => {
    const a = parseArticleBody('Стаття 129 - 1 . Суд ухвалює рішення іменем України.\nДругий абзац.', false)!;
    expect(a.artNo).toBe('129-1');
    expect(a.title).toBeNull();
    expect(a.paragraphs[0].text).toBe('Суд ухвалює рішення іменем України.');
  });

  it('rejects a body that does not start with an article line', () => {
    expect(parseArticleBody('Прикінцеві положення', true)).toBeNull();
  });
});

describe('parseStructure', () => {
  const text = [
    '{У тексті Кодексу слова замінено}',
    'КНИГА ПЕРША',
    'ЗАГАЛЬНІ ПОЛОЖЕННЯ',
    'Розділ I',
    'ОСНОВНІ ПОЛОЖЕННЯ',
    'Глава 1',
    'ЦИВІЛЬНЕ ЗАКОНОДАВСТВО УКРАЇНИ',
    'Стаття 1. Відносини',
    '1. Текст, де згадано Розділ II цього Кодексу.',
    'Стаття 2. Учасники',
    "КНИГА П'ЯТА",
    "ЗОБОВ'ЯЗАЛЬНЕ ПРАВО",
    'РОЗДІЛ I. ЗАГАЛЬНІ ПОЛОЖЕННЯ ПРО ЗОБОВ\'ЯЗАННЯ',
    'ГЛАВА 51. ПРАВОВІ НАСЛІДКИ ПОРУШЕННЯ ЗОБОВ\'ЯЗАННЯ',
    '§ 1. Загальні положення',
    'Стаття 625. Відповідальність',
    'Стаття 625. Повтор у прикінцевих положеннях',
  ].join('\n');
  const s = parseStructure(text);

  it('builds heading paths, resetting deeper levels on a new book', () => {
    expect(s.pathByArt['2'].map(h => h.label)).toEqual(['Книга перша', 'Розділ I', 'Глава 1']);
    expect(s.pathByArt['625'].map(h => h.label)).toEqual(["Книга п'ята", 'Розділ I', 'Глава 51', '§ 1']);
    expect(s.pathByArt['2'][2].title).toBe('Цивільне законодавство України');
  });

  it('ignores headings cited inside article text and duplicate article lines', () => {
    expect(s.entries.filter(e => e.type === 'heading' && e.heading.label === 'Розділ II')).toHaveLength(0);
    expect(s.entries.filter(e => e.type === 'article').map(e => (e as { artNo: string }).artNo)).toEqual(['1', '2', '625']);
  });
});

describe('sentenceCase', () => {
  it('keeps proper names capitalised', () => {
    expect(sentenceCase('КАБІНЕТ МІНІСТРІВ УКРАЇНИ. ІНШІ ОРГАНИ ВИКОНАВЧОЇ ВЛАДИ')).toBe('Кабінет Міністрів України. Інші органи виконавчої влади');
    expect(sentenceCase('ВЕРХОВНА РАДА УКРАЇНИ')).toBe('Верховна Рада України');
  });
  it('leaves mixed-case text alone', () => {
    expect(sentenceCase("Відповідальність за порушення грошового зобов'язання")).toBe("Відповідальність за порушення грошового зобов'язання");
  });
});

describe('zakon codes', () => {
  it('round-trips article slugs and rejects junk', () => {
    expect(artNoFromSlug(articleSlug('111-1'))).toBe('111-1');
    for (const bad of ['stattia-', 'stattia-1x', 'stattia-1-', '625', 'stattia-12345', 'stattia-1-2-3']) expect(artNoFromSlug(bad)).toBeUndefined();
  });
  it('has 13 unique slugs and Rada numbers', () => {
    expect(ZAKON_CODES).toHaveLength(13);
    expect(new Set(ZAKON_CODES.map(c => c.slug)).size).toBe(13);
    expect(new Set(ZAKON_CODES.map(c => c.nreg)).size).toBe(13);
    expect(codeBySlug('tsyvilnyi-kodeks')?.nreg).toBe('435-15');
  });
});
