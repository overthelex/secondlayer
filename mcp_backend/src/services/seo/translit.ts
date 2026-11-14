/**
 * Ukrainian → Latin transliteration by the official KMU resolution №55 of
 * 27.01.2010, used to build URL slugs. Slugs are stored once generated, so a
 * change here never rewrites an existing URL.
 */
const MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia',
  // Russian letters occasionally present in old court names
  ё: 'io', ы: 'y', э: 'e', ъ: '',
};
const WORD_START: Record<string, string> = { є: 'ye', ї: 'yi', й: 'y', ю: 'yu', я: 'ya' };

export function translit(input: string): string {
  const s = input.toLocaleLowerCase('uk-UA').replace(/['’ʼ`]/g, '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const atStart = i === 0 || !/\p{L}/u.test(s[i - 1]);
    if (ch === 'г' && s[i - 1] === 'з') { out += 'gh'; continue; } // "зг" → "zgh"
    if (atStart && WORD_START[ch]) { out += WORD_START[ch]; continue; }
    out += ch in MAP ? MAP[ch] : ch;
  }
  return out;
}

/** "Печерський районний суд м. Києва" → "pecherskyi-raionnyi-sud-m-kyieva". */
export function slugify(input: string, maxLen = 90): string {
  const slug = translit(input).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length <= maxLen) return slug;
  return slug.slice(0, maxLen).replace(/-[^-]*$/, '');
}
