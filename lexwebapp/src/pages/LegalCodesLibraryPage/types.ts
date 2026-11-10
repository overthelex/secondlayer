export interface LegalCodesLibraryPageProps {
  onBack?: () => void;
}

export interface Code {
  id: string;
  name: string;
  number: string;
  icon: string;
  category: string;
}

export interface TOCArticleEntry {
  article_number: string;
  title: string;
  byte_size?: number;
}

export interface TOCParagraph {
  type: 'paragraph';
  number: string;
  title?: string;
  articles: TOCArticleEntry[];
}

export interface TOCChapter {
  type: 'chapter';
  number: string;
  title?: string;
  articles: TOCArticleEntry[];
  paragraphs?: TOCParagraph[];
}

export interface TOCSubsection {
  type: 'subsection';
  number: string;
  title?: string;
  articles: TOCArticleEntry[];
  chapters?: TOCChapter[];
  paragraphs?: TOCParagraph[];
}

export interface TOCSection {
  type: 'section';
  number: string;
  title?: string;
  articles: TOCArticleEntry[];
  chapters?: TOCChapter[];
  subsections?: TOCSubsection[];
  paragraphs?: TOCParagraph[];
}

export interface TOCBook {
  type: 'book';
  number: string;
  title?: string;
  children: TOCEntry[];
}

export type TOCEntry = TOCBook | TOCSection | TOCSubsection | TOCChapter | TOCParagraph | TOCArticleEntry;

export interface LegislationStructure {
  rada_id: string;
  title: string;
  short_title?: string;
  type?: string;
  total_articles: number;
  table_of_contents: TOCEntry[];
  articles_summary: TOCArticleEntry[];
}

export interface ArticleData {
  rada_id: string;
  article_number: string;
  title: string;
  full_text: string;
  url?: string;
  metadata?: any;
}

export interface SearchResult {
  rada_id: string;
  article_number: string;
  title: string;
  full_text: string;
  url?: string;
}

// Constants
export const FAVORITES_KEY = 'legislation_favorites';
export const COMMENTS_KEY = 'legislation_comments';

// Static data
export const mainCodes: Code[] = [
  { id: '435-15', name: 'Цивільний кодекс', number: '435-15', icon: '\u2696\uFE0F', category: 'main' },
  { id: '2341-14', name: 'Кримінальний кодекс', number: '2341-14', icon: '\uD83D\uDCCB', category: 'main' },
  { id: '436-15', name: 'Господарський кодекс', number: '436-15', icon: '\uD83C\uDFDB\uFE0F', category: 'main' },
  { id: '2947-14', name: 'Сімейний кодекс', number: '2947-14', icon: '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67', category: 'main' },
  { id: '2768-14', name: 'Земельний кодекс', number: '2768-14', icon: '\uD83C\uDF33', category: 'main' },
  { id: '322-08', name: 'Трудовий кодекс', number: '322-08', icon: '\uD83D\uDCBC', category: 'main' },
  { id: '8073-10', name: 'Кодекс про адміністративні правопорушення', number: '8073-10', icon: '\u2699\uFE0F', category: 'main' },
  { id: '2755-17', name: 'Податковий кодекс', number: '2755-17', icon: '\uD83D\uDCB0', category: 'main' },
];

export const proceduralCodes = [
  { name: 'Цивільний процесуальний кодекс (ЦПК)', number: '1618-15' },
  { name: 'Господарський процесуальний кодекс (ГПК)', number: '1798-12' },
  { name: 'Кримінальний процесуальний кодекс (КПК)', number: '4651-17' },
  { name: 'Кодекс адміністративного судочинства (КАС)', number: '2747-15' },
];

export const categories = [
  'Банківське',
  'Митне',
  'Виборче',
  'Бюджетне',
  'Про освіту',
  "Про охорону здоров'я",
  'Про нотаріат',
];

// Utility functions
export function loadFavorites(): Set<string> {
  try {
    const stored = localStorage.getItem(FAVORITES_KEY);
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}

export function saveFavorites(favorites: Set<string>) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]));
}

export function loadComment(radaId: string, articleNumber: string): string {
  try {
    const stored = localStorage.getItem(COMMENTS_KEY);
    const comments = stored ? JSON.parse(stored) : {};
    return comments[`${radaId}:${articleNumber}`] || '';
  } catch {
    return '';
  }
}

export function saveComment(radaId: string, articleNumber: string, text: string) {
  try {
    const stored = localStorage.getItem(COMMENTS_KEY);
    const comments = stored ? JSON.parse(stored) : {};
    if (text) {
      comments[`${radaId}:${articleNumber}`] = text;
    } else {
      delete comments[`${radaId}:${articleNumber}`];
    }
    localStorage.setItem(COMMENTS_KEY, JSON.stringify(comments));
  } catch {
    // ignore
  }
}

export function parseToolResult(result: any): any {
  if (result?.result?.content?.[0]?.text) {
    return JSON.parse(result.result.content[0].text);
  }
  return result?.result || result;
}
