/**
 * Recover the book / section / chapter hierarchy of an act from its article texts.
 *
 * Most current articles were loaded without section_number / chapter_number: the parser
 * glued each structural heading onto the END of the preceding article's text, e.g.
 * ЦК ст. 625 ends with "… Розділ II ЗАГАЛЬНІ ПОЛОЖЕННЯ ПРО ДОГОВІР Глава 52 ПОНЯТТЯ ТА УМОВИ
 * ДОГОВОРУ". The heading belongs to the next article. This module reads those trailing
 * headings back so the table of contents can be built without rewriting stored data.
 *
 * Headings before the first article (e.g. "Книга перша … Глава 1") are not in any article
 * text, so the first container of an act may be missing; articles before the first
 * recovered heading stay at the top level.
 */

export type HeadingLevel = 'book' | 'section' | 'subsection' | 'chapter' | 'paragraph';

export interface Heading {
  level: HeadingLevel;
  number: string;
  title?: string;
}

// Keyword + number (+ optional dot). Book numbers are ordinals in words ("перша") or digits.
// Two heading styles exist: "Глава 52 ПОНЯТТЯ ТА УМОВИ ДОГОВОРУ" (ЦК) and
// "Глава 2. Цивільна юрисдикція" (ЦПК); the dot after the number marks the second.
const KEYWORD =
  /(?:^|\s)(?:(КНИГА|Книга|РОЗДІЛ|Розділ|ПІДРОЗДІЛ|Підрозділ|ГЛАВА|Глава)\s+(\d+(?:[-¹]\d+)?|[IVXLC]+|[А-ЯІЇЄҐа-яіїєґ'’]+)(\.)?|(§)\s*(\d+(?:-\d+)?)\.)(?=\s)/g;

const LOWER = /[а-яіїєґ]/;
const UPPER_START = /^[A-ZА-ЯІЇЄҐ0-9«"(]/;

const LEVEL_BY_KEYWORD: Record<string, HeadingLevel> = {
  книга: 'book', розділ: 'section', підрозділ: 'subsection', глава: 'chapter',
};

function levelOf(m: RegExpExecArray): { level: HeadingLevel; number: string; dotted: boolean } {
  if (m[4]) return { level: 'paragraph', number: m[5], dotted: true };
  return { level: LEVEL_BY_KEYWORD[m[1].toLowerCase()], number: m[2], dotted: !!m[3] };
}

/**
 * Parse the run of structural headings at the end of an article text. Returns [] when the
 * text does not end in headings. A run is accepted only if every heading is either
 * "Keyword N ALL-CAPS TITLE" or "Keyword N. Title" / "§ N. Title" (dot after the number),
 * which rejects in-sentence references such as "відповідно до Глава 3 цього Кодексу".
 */
export function parseTrailingHeadings(text: string | null | undefined): Heading[] {
  if (!text) return [];
  const tail = text.length > 1500 ? text.slice(-1500) : text;
  const matches: RegExpExecArray[] = [];
  KEYWORD.lastIndex = 0;
  for (let m = KEYWORD.exec(tail); m; m = KEYWORD.exec(tail)) matches.push(m);

  // Try the earliest candidate first so the whole run is captured, not just its last part.
  for (let i = 0; i < matches.length; i++) {
    const run = matches.slice(i);
    const headings: Heading[] = [];
    let ok = true;
    for (let j = 0; j < run.length; j++) {
      const m = run[j];
      const start = m.index + m[0].length;
      const end = j + 1 < run.length ? run[j + 1].index : tail.length;
      const title = tail.slice(start, end).trim().replace(/[.;]\s*$/, '');
      const { level, number, dotted } = levelOf(m);
      // Only books are numbered in words ("Книга перша"); everything else needs digits or Roman.
      const numberOk = level === 'book' || /^(\d|[IVXLC]+$)/.test(number);
      const titleOk = dotted
        ? title.length <= 200 && (title === '' || UPPER_START.test(title))
        : !!title && !LOWER.test(title) && title.length <= 300;
      if (!numberOk || !titleOk) {
        ok = false;
        break;
      }
      headings.push({ level, number, ...(title ? { title } : {}) });
    }
    if (ok && headings.length) return headings;
  }
  return [];
}

const DEPTH: Record<HeadingLevel, number> = { book: 0, section: 1, subsection: 2, chapter: 3, paragraph: 4 };

/**
 * When no article of the act carries hierarchy fields, return copies of the articles with
 * section/chapter fields (and book/subsection/paragraph in metadata) filled from the
 * trailing headings, in the shape buildTableOfContents expects. Otherwise return the input.
 */
export function withRecoveredHierarchy<T extends Record<string, any>>(articles: T[]): T[] {
  const hasStored = articles.some(
    (a) => a.section_number || a.chapter_number || a.metadata?.book_number || a.metadata?.paragraph_number
  );
  if (hasStored || articles.length === 0) return articles;

  const state: Partial<Record<HeadingLevel, Heading>> = {};
  let pending: Heading[] = [];
  let recovered = false;

  const out = articles.map((a) => {
    for (const h of pending) {
      state[h.level] = h;
      for (const lvl of Object.keys(DEPTH) as HeadingLevel[]) {
        if (DEPTH[lvl] > DEPTH[h.level]) delete state[lvl];
      }
      recovered = true;
    }
    pending = parseTrailingHeadings(a.full_text);

    const book = state.book;
    const section = state.section;
    return {
      ...a,
      section_number: section ? (book ? `${book.number}.${section.number}` : section.number) : null,
      section_title: section?.title ?? null,
      chapter_number: state.chapter?.number ?? null,
      chapter_title: state.chapter?.title ?? null,
      metadata: {
        ...(a.metadata || {}),
        ...(book ? { book_number: book.number, book_title: book.title } : {}),
        ...(state.subsection ? { subsection_number: state.subsection.number, subsection_title: state.subsection.title } : {}),
        ...(state.paragraph ? { paragraph_number: state.paragraph.number, paragraph_title: state.paragraph.title } : {}),
      },
    };
  });
  return recovered ? out : articles;
}
