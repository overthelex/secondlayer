/**
 * The codes published as public SEO pages under /zakon (v1: the 13 main
 * codes). Slugs are fixed by hand: they are permanent URLs, so they must not
 * change if a transliteration rule ever does.
 */

export interface ZakonCode {
  slug: string;
  /** npa.act.nreg / Rada number. */
  nreg: string;
  /** Full name, e.g. "Цивільний кодекс України". */
  name: string;
  /** Used in article headings: "Стаття 625 ЦК України". */
  articleRef: string;
  /** Short label for navigation. */
  abbr: string;
  /** false when articles have no headings (the Constitution). */
  articleTitles: boolean;
}

export const ZAKON_CODES: ZakonCode[] = [
  { slug: 'konstytutsiia', nreg: '254к/96-вр', name: 'Конституція України', articleRef: 'Конституції України', abbr: 'Конституція', articleTitles: false },
  { slug: 'tsyvilnyi-kodeks', nreg: '435-15', name: 'Цивільний кодекс України', articleRef: 'ЦК України', abbr: 'ЦК', articleTitles: true },
  { slug: 'tsyvilnyi-protsesualnyi-kodeks', nreg: '1618-15', name: 'Цивільний процесуальний кодекс України', articleRef: 'ЦПК України', abbr: 'ЦПК', articleTitles: true },
  { slug: 'kryminalnyi-kodeks', nreg: '2341-14', name: 'Кримінальний кодекс України', articleRef: 'КК України', abbr: 'КК', articleTitles: true },
  { slug: 'kryminalnyi-protsesualnyi-kodeks', nreg: '4651-17', name: 'Кримінальний процесуальний кодекс України', articleRef: 'КПК України', abbr: 'КПК', articleTitles: true },
  { slug: 'hospodarskyi-protsesualnyi-kodeks', nreg: '1798-12', name: 'Господарський процесуальний кодекс України', articleRef: 'ГПК України', abbr: 'ГПК', articleTitles: true },
  { slug: 'kodeks-administratyvnoho-sudochynstva', nreg: '2747-15', name: 'Кодекс адміністративного судочинства України', articleRef: 'КАС України', abbr: 'КАС', articleTitles: true },
  { slug: 'kodeks-zakoniv-pro-pratsiu', nreg: '322-08', name: 'Кодекс законів про працю України', articleRef: 'КЗпП України', abbr: 'КЗпП', articleTitles: true },
  { slug: 'podatkovyi-kodeks', nreg: '2755-17', name: 'Податковий кодекс України', articleRef: 'ПК України', abbr: 'ПКУ', articleTitles: true },
  { slug: 'simeinyi-kodeks', nreg: '2947-14', name: 'Сімейний кодекс України', articleRef: 'СК України', abbr: 'СК', articleTitles: true },
  { slug: 'zemelnyi-kodeks', nreg: '2768-14', name: 'Земельний кодекс України', articleRef: 'ЗК України', abbr: 'ЗК', articleTitles: true },
  { slug: 'kupap', nreg: '8073-10', name: 'Кодекс України про адміністративні правопорушення', articleRef: 'КУпАП', abbr: 'КУпАП', articleTitles: true },
  { slug: 'hospodarskyi-kodeks', nreg: '436-15', name: 'Господарський кодекс України', articleRef: 'ГК України', abbr: 'ГК', articleTitles: true },
];

const BY_SLUG = new Map(ZAKON_CODES.map(c => [c.slug, c]));

export function codeBySlug(slug: string): ZakonCode | undefined {
  return BY_SLUG.get(slug);
}

/** "625" → "stattia-625", "111-1" → "stattia-111-1". */
export function articleSlug(artNo: string): string {
  return `stattia-${artNo}`;
}

/** Inverse of articleSlug; undefined for anything that is not a canonical article slug. */
export function artNoFromSlug(slug: string): string | undefined {
  const m = /^stattia-(\d{1,4}(?:-\d{1,3})?)$/.exec(slug);
  return m ? m[1] : undefined;
}
