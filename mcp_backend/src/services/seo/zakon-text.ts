/**
 * Parsing of npa.* texts for the public code pages: the article heading
 * line, article bodies, and the book/section/chapter/§ structure of an
 * edition (npa.edition_text.body, one line per paragraph).
 */

/** "Стаття 625. Назва", "Стаття 19 - 1 . Назва" → art "625" / "19-1", rest. */
const ARTICLE_LINE = /^Стаття\s+(\d+(?:\s*-\s*\d+)?)\s*\.\s*(.*)$/;

export function normArtNo(raw: string): string {
  return raw.replace(/\s+/g, '');
}

export interface ParsedArticle {
  artNo: string;
  /** Heading after "Стаття N." (null for codes whose articles have none). */
  title: string | null;
  /** Body paragraphs, in order. */
  paragraphs: Array<{ text: string; note: boolean }>;
}

/**
 * npa.article.body starts with "Стаття N. <title>". For codes without
 * article headings (the Constitution) the rest of that line is the first
 * paragraph instead.
 */
export function parseArticleBody(body: string, hasTitles: boolean): ParsedArticle | null {
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  const m = lines.length ? ARTICLE_LINE.exec(lines[0]) : null;
  if (!m) return null;
  const rest = m[2].trim();
  const paragraphs: ParsedArticle['paragraphs'] = [];
  let title: string | null = null;
  if (hasTitles) title = rest || null;
  else if (rest) paragraphs.push({ text: rest, note: false });
  for (const line of lines.slice(1)) {
    paragraphs.push({ text: line, note: line.startsWith('{') && line.endsWith('}') });
  }
  return { artNo: normArtNo(m[1]), title, paragraphs };
}

export type HeadingKind = 'book' | 'section' | 'chapter' | 'paragraph';

export interface Heading {
  kind: HeadingKind;
  /** "Книга перша", "Розділ II", "Глава 5", "§ 1". */
  label: string;
  title: string;
}

export type StructureEntry =
  | { type: 'heading'; heading: Heading; depth: number }
  | { type: 'article'; artNo: string };

export interface CodeStructure {
  entries: StructureEntry[];
  /** Heading path (outermost first) for every article seen in the text. */
  pathByArt: Record<string, Heading[]>;
}

const LEVEL: Record<HeadingKind, number> = { book: 1, section: 2, chapter: 3, paragraph: 4 };

const BOOK = /^(КНИГА\s+[А-ЯІЇЄҐ'’ʼ]+|ЗАГАЛЬНА ЧАСТИНА|ОСОБЛИВА ЧАСТИНА)\s*$/;
const SECTION = /^(?:Розділ|РОЗДІЛ)\s+([IVXLC]+(?:\s*-\s*\d+)?|\d+(?:\s*-\s*\d+)?)\s*\.?\s*(.*)$/;
const CHAPTER = /^(?:Глава|ГЛАВА)\s+(\d+(?:\s*-\s*\d+)?)\s*\.?\s*(.*)$/;
const PARA = /^§\s*(\d+(?:\s*-\s*\d+)?)\s*\.?\s*(.*)$/;

function capsRatio(s: string): number {
  const letters = s.match(/\p{L}/gu) || [];
  if (!letters.length) return 0;
  return letters.filter(ch => ch === ch.toUpperCase() && ch !== ch.toLowerCase()).length / letters.length;
}

/** A heading's inline title must look like a title, not a sentence citing it. */
function plausibleInlineTitle(rest: string): boolean {
  return !rest.startsWith('{') && rest.length < 250 && !/[;:]$/.test(rest) && !/^(цього|цієї|до|та|і|з|у|в)(?!\p{L})/u.test(rest);
}

/**
 * Proper names that must keep their capitals after an ALL-CAPS heading is
 * lower-cased. (\b is ASCII-only in JS, hence the \p{L} lookarounds.)
 */
const PROPER: Array<[RegExp, string]> = [
  [/(?<!\p{L})президент(а|ові)? україни(?!\p{L})/gu, 'Президент$1 України'],
  [/(?<!\p{L})україн(а|и|і|у|ою)(?!\p{L})/gu, 'Україн$1'],
  [/(?<!\p{L})верховн(а|ої|ій|у) рад(а|и|і|у)(?!\p{L})/gu, 'Верховн$1 Рад$2'],
  [/(?<!\p{L})кабінет(у)? міністрів(?!\p{L})/gu, 'Кабінет$1 Міністрів'],
  [/(?<!\p{L})конституці(я|ї|ю|єю)(?!\p{L})/gu, 'Конституці$1'],
  [/(?<!\p{L})конституційн(ий|ого|ому) суд(у)?(?!\p{L})/gu, 'Конституційн$1 Суд$2'],
  [/(?<!\p{L})вищ(а|ої) рад(а|и) правосуддя(?!\p{L})/gu, 'Вищ$1 Рад$2 правосуддя'],
  [/(?<!\p{L})автономн(а|ої|ій) республік(а|и|і) крим(?!\p{L})/gu, 'Автономн$1 Республік$2 Крим'],
];

/** Headings are ALL CAPS in the source; render them in sentence case. */
export function sentenceCase(s: string): string {
  if (capsRatio(s) < 0.8) return s;
  let out = s.toLocaleLowerCase('uk-UA');
  for (const [re, rep] of PROPER) out = out.replace(re, rep);
  // capital letter at the start and after a sentence break
  out = out.replace(/(^|[.!?]\s+)(\p{Ll})/gu, (_m, pre: string, ch: string) => pre + ch.toLocaleUpperCase('uk-UA'));
  return out;
}

function bookLabel(raw: string): string {
  return sentenceCase(raw.replace(/\s+/g, ' '));
}

export function parseStructure(editionBody: string): CodeStructure {
  const lines = editionBody.split('\n').map(l => l.trim());
  const entries: StructureEntry[] = [];
  const pathByArt: Record<string, Heading[]> = {};
  let path: Heading[] = [];
  let seenArticle = false;

  const nextTitle = (i: number): string | null => {
    const nxt = lines[i + 1];
    if (!nxt || ARTICLE_LINE.test(nxt) || nxt.startsWith('{')) return null;
    if (BOOK.test(nxt) || SECTION.test(nxt) || CHAPTER.test(nxt) || PARA.test(nxt)) return null;
    if (nxt.length > 300 || capsRatio(nxt) < 0.6) return null;
    return nxt;
  };

  const push = (h: Heading) => {
    const level = LEVEL[h.kind];
    path = path.filter(p => LEVEL[p.kind] < level);
    path.push(h);
    entries.push({ type: 'heading', heading: h, depth: path.length });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith('{')) continue;

    const art = ARTICLE_LINE.exec(line);
    if (art) {
      const artNo = normArtNo(art[1]);
      if (!(artNo in pathByArt)) {
        pathByArt[artNo] = [...path];
        entries.push({ type: 'article', artNo });
      }
      seenArticle = true;
      continue;
    }

    let m: RegExpExecArray | null;
    if ((m = BOOK.exec(line))) {
      const t = nextTitle(i);
      push({ kind: 'book', label: bookLabel(m[1]), title: t ? sentenceCase(t) : '' });
      if (t) i++;
    } else if ((m = SECTION.exec(line)) && (m[2] === '' || plausibleInlineTitle(m[2]))) {
      const t = m[2] || nextTitle(i);
      push({ kind: 'section', label: `Розділ ${normArtNo(m[1])}`, title: t ? sentenceCase(t) : '' });
      if (!m[2] && t) i++;
    } else if ((m = CHAPTER.exec(line)) && (m[2] === '' || plausibleInlineTitle(m[2]))) {
      const t = m[2] || nextTitle(i);
      push({ kind: 'chapter', label: `Глава ${normArtNo(m[1])}`, title: t ? sentenceCase(t) : '' });
      if (!m[2] && t) i++;
    } else if ((m = PARA.exec(line))) {
      push({ kind: 'paragraph', label: `§ ${normArtNo(m[1])}`, title: sentenceCase(m[2]) });
    }
  }
  return { entries, pathByArt };
}
