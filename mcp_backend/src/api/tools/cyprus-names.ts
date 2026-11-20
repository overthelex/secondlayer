/**
 * Name and number helpers for the Cyprus DRCOR register (cy_companies, migration 288).
 *
 * Pure functions, shared by search_cyprus_companies and the Cyprus section of
 * get_company_dossier:
 *   - parseCyRegistrationNumber: «HE123456», «НЕ 123456» (Cyrillic), «ΗΕ123456» (Greek),
 *     «AE1234», bare digits;
 *   - cyNameKey: exact comparison key of a Latin/Greek company name (case, punctuation,
 *     LTD = LIMITED, PLC = PUBLIC LIMITED);
 *   - cyNameSkeleton: a lossy consonant key that lets a Ukrainian transliteration from ЄДР
 *     («ЕЙНТРІВУД ІНВЕСТМЕНТС ЛІМІТЕД») meet the Latin original («AINTREEWOOD INVESTMENTS
 *     LIMITED»). Used only as a last resort and always labelled as such.
 */

/** Cyrillic and Greek letters that look like H, E, A (founders' codes are typed in any script). */
const LOOKALIKE: Record<string, string> = {
  'Н': 'H', 'н': 'H', 'Η': 'H', 'η': 'H',
  'Е': 'E', 'е': 'E', 'Ε': 'E', 'ε': 'E',
  'А': 'A', 'а': 'A', 'Α': 'A', 'α': 'A',
};

export interface CyRegistrationNumber {
  /** HE / AE prefix when given, else null (digits match any organisation type). */
  prefix: 'HE' | 'AE' | null;
  /** Digits without leading zeros, as cy_companies.registration_no stores them. */
  digits: string;
  /** registration_code form (HE123456) when the prefix is known. */
  code: string | null;
}

/** «HE 123456», «НЕ123456», «ΗΕ-123456», «AE1234», «123456» → parts; anything else → null. */
export function parseCyRegistrationNumber(input: unknown): CyRegistrationNumber | null {
  if (input == null) return null;
  const s = [...String(input).trim()].map((ch) => LOOKALIKE[ch] ?? ch).join('').toUpperCase();
  const m = /^(?:(HE|AE|ΗΕ)\s*[-.№#]?\s*)?0*(\d{1,7})$/.exec(s);
  if (!m) return null;
  const prefix = m[1] ? (m[1] === 'AE' ? 'AE' : 'HE') : null;
  const digits = m[2] === '' ? '0' : m[2];
  return { prefix, digits, code: prefix ? `${prefix}${digits}` : null };
}

/** HE/AE number written anywhere in a founder line of ЄДР («...ЛТД НЕ 287592; ...», «ІДЕНТИФІКАЦІЙНИЙ КОД - НЕ378731»). */
export function findCyRegistrationCode(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const m = /(?<![\p{L}\d])([HНΗ][EЕΕ]|[AАΑ][EЕΕ])\s*[-.№#]?\s*(\d{2,7})(?!\d)/u.exec(text);
  if (!m) return null;
  return parseCyRegistrationNumber(`${m[1]}${m[2]}`)?.code ?? null;
}

const LEGAL_TOKENS: Record<string, string> = {
  LTD: 'LIMITED', LIMITED: 'LIMITED', LIMITE: 'LIMITED', LTE: 'LIMITED',
  PLC: 'PUBLIC LIMITED', CO: 'COMPANY', 'Λ.Τ.Δ': 'LIMITED', ΛΤΔ: 'LIMITED', ΛΙΜΙΤΕΔ: 'LIMITED',
};

/**
 * Exact comparison key: upper case, accents and punctuation removed, & = AND,
 * LTD = LIMITED, PLC = PUBLIC LIMITED. «Toldex Ltd.» and «TOLDEX LIMITED» share a key.
 */
export function cyNameKey(name: unknown): string {
  if (typeof name !== 'string') return '';
  const s = name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (!s) return '';
  return s.split(/\s+/).map((t) => LEGAL_TOKENS[t] ?? t).join(' ').replace(/\s+/g, ' ');
}

/** Words that only state a legal form; they do not narrow a name search. */
export const LEGAL_FORM_WORDS = new Set([
  'LIMITED', 'LTD', 'PLC', 'PUBLIC', 'COMPANY', 'CO', 'HOLDINGS', 'ΛΙΜΙΤΕΔ', 'ΛΤΔ', 'ΕΤΑΙΡΕΙΑ',
]);

// ─── Founders from ЄДР ──────────────────────────────────────────────────────

/** Ukrainian legal-form words ЄДР puts before a foreign company's name. */
const UA_FORM_PREFIX = new RegExp(
  '^(?:(?:ІНШІ ОРГАНІЗАЦІЙНО-ПРАВОВІ ФОРМИ|ВЛАСНИК ІСТОТНОЇ УЧАСТІ|ПРИВАТНА|ПУБЛІЧНА|ЗАКРИТА|ВІДКРИТА|АКЦІОНЕРНА|'
  + 'КОМПАНІЯ|ТОВАРИСТВО|З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ|ФІРМА|КОРПОРАЦІЯ|ЮРИДИЧНА ОСОБА|НЕРЕЗИДЕНТ)\\s+)+',
  'iu',
);

export interface CyFounderNames {
  /** The name as ЄДР gives it, legal-form prefix removed. */
  name: string;
  /** Latin spellings found in the line (the whole name, or the part in brackets/quotes). */
  latin: string[];
  /** Cyrillic spelling, when the name is (also) written in Cyrillic. */
  cyrillic: string | null;
}

/** Name parts of a founder line «КОМПАНІЯ "ТОЛДЕКС ЛІМІТЕД" (TOLDEX LIMITED); резиденство: Кіпр; ...». */
export function founderNames(founderInfo: string): CyFounderNames | null {
  let head = String(founderInfo || '').split(';')[0].trim();
  // Comma-separated layouts (older ЄДР dumps): name, [code,] country, address...
  if (!founderInfo.includes(';')) head = head.split(',')[0].trim();
  // A registration number written after the name is not part of it.
  head = head.replace(/[,(]?\s*(?:ІДЕНТИФІКАЦІЙНИЙ КОД|РЕЄСТРАЦІЙНИЙ (?:НОМЕР|КОД)|КОД)?\s*[-:]?\s*(?:[HНΗ][EЕΕ]|[AАΑ][EЕΕ])\s*[-.№#]?\s*\d{2,7}\)?\s*$/iu, '').trim();
  if (!head) return null;
  const parts: string[] = [];
  const bracket = /[(«"“]([^()«»"“”]+)[)»"”]/gu;
  let m: RegExpExecArray | null;
  while ((m = bracket.exec(head))) parts.push(m[1].trim());
  const outside = head.replace(/\([^)]*\)/g, ' ').replace(/[«»"“”]/g, ' ').replace(UA_FORM_PREFIX, '').replace(/\s+/g, ' ').trim();
  parts.push(outside.replace(UA_FORM_PREFIX, '').trim());
  const clean = (p: string) => p.replace(UA_FORM_PREFIX, '').replace(/^[\s,.-]+|[\s,.-]+$/g, '').trim();
  const isLatin = (p: string) => /[A-Za-z]{2,}/.test(p) && !/[А-Яа-яІіЇїЄєҐґ]/.test(p);
  const isCyr = (p: string) => /[А-Яа-яІіЇїЄєҐґ]{2,}/.test(p);
  const cleaned = [...new Set(parts.map(clean).filter((p) => p.length >= 2))];
  const latin = cleaned.filter(isLatin);
  const cyr = cleaned.filter(isCyr).sort((a, b) => b.length - a.length);
  const name = clean(head.replace(/[«»"“”]/g, '').replace(UA_FORM_PREFIX, '')) || head;
  return { name, latin, cyrillic: cyr.find((c) => !/\(/.test(c)) ?? cyr[0] ?? null };
}

// ─── Transliteration skeleton ───────────────────────────────────────────────

const UA_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', є: 'ye', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'yi',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h',
  ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'yu', я: 'ya', ъ: '', ы: 'y', э: 'e', ё: 'yo',
};

/** Ukrainian Cyrillic → plain Latin (English-oriented; ДЖ → j). Latin input passes through. */
export function uaToLatin(s: string): string {
  const lower = s.toLowerCase().replace(/дж/g, 'j');
  return [...lower].map((ch) => UA_LATIN[ch] ?? ch).join('');
}

/** Legal-form words in either script, after uaToLatin. */
export const SKELETON_STOP = [
  'limited', 'ltd', 'limitid', 'plc', 'pls', 'public', 'pablik', 'pablyk', 'company', 'co', 'kompani',
  'kompaniya', 'inc', 'ink', 'llc',
];
const SKELETON_STOP_SET = new Set(SKELETON_STOP);
const STOP_RE = new RegExp(`(?<![a-z0-9])(?:${SKELETON_STOP.join('|')})(?![a-z0-9])`, 'g');

/** Letter folding shared by the JS skeleton and the SQL function cy_name_skeleton (migration 294). */
function foldLetters(s: string): string {
  return s
    .replace(/ph/g, 'f').replace(/th/g, 't').replace(/ck/g, 'k').replace(/x/g, 'ks')
    .replace(/c(?=[eiy])/g, 's').replace(/[cq]/g, 'k').replace(/z/g, 's').replace(/w/g, 'v').replace(/j/g, 'g')
    .replace(/[aeiouyh ]/g, '')
    .replace(/(.)\1+/g, '$1');
}

/**
 * Consonant skeleton of a company name, legal-form words dropped: vowels, h, spaces and
 * doubled letters removed; c/k/q, s/z, ph/f, x/ks, w/v, j/g folded. «AINTREEWOOD
 * INVESTMENTS» and «ЕЙНТРІВУД ІНВЕСТМЕНТС» both give «ntrvdnvstmnts». Lossy by design: a
 * skeleton match is a candidate for a human to check, never an identification.
 *
 * Must stay identical to cy_name_skeleton() in migration 294 for Latin input (the
 * register side); the test suite checks the two on sample names.
 */
export function cyNameSkeleton(name: unknown): string {
  if (typeof name !== 'string') return '';
  const s = uaToLatin(name)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(STOP_RE, ' ');
  return foldLetters(s);
}

function skeletonWord(w: string): string {
  return foldLetters(w);
}

/** Minimum skeleton length for a transliteration match to be tried at all. */
export const MIN_SKELETON = 3;

/** Business words that say nothing about which company it is («holdings», «trading»). */
const GENERIC_WORDS = new Set([
  'holding', 'holdings', 'investment', 'investments', 'invest', 'trading', 'trade', 'enterprise', 'enterprises',
  'group', 'management', 'services', 'service', 'ventures', 'venture', 'capital', 'international', 'consulting',
  'commercial', 'development', 'developments', 'properties', 'property', 'finance', 'financial', 'overseas', 'global',
  'consultants', 'solutions', 'systems', 'technologies', 'shipping',
]);

/** Generic words in any spelling («холдінгз», «holdings»), compared by skeleton. */
const GENERIC_SKELETONS = new Set([...GENERIC_WORDS].map(skeletonWord));

/** Lower-case Latin form of a name without legal-form and generic words, for similarity scoring. */
export function cyNameCore(name: unknown): string {
  if (typeof name !== 'string') return '';
  return uaToLatin(name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
    .filter((w) => w && !SKELETON_STOP_SET.has(w) && !GENERIC_SKELETONS.has(skeletonWord(w)))
    .join(' ');
}

/** Levenshtein similarity in [0, 1]. */
export function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/** Thresholds for accepting a transliteration match (see pickTransliterated). */
export const TRANSLIT_MIN_SCORE = 0.6;
export const TRANSLIT_MARGIN = 0.15;

/**
 * Of the register names that share the founder's skeleton, the one whose distinctive part
 * spells closest to the transliteration; null when none is close enough or two are equally
 * close. «КІМОНАР ХОЛДІНГЗ ЛТД» → KIMONAR HOLDINGS LTD, not CUMNOR HOLDINGS LIMITED.
 */
export function pickTransliterated<T extends { name: string }>(founderName: string, candidates: T[]): { company: T; score: number } | null {
  const core = cyNameCore(founderName);
  if (!core) return null;
  const scored = candidates
    .map((c) => ({ company: c, score: similarity(core, cyNameCore(c.name)) }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (!best || best.score < TRANSLIT_MIN_SCORE) return null;
  if (second && best.score - second.score < TRANSLIT_MARGIN && cyNameKey(second.company.name) !== cyNameKey(best.company.name)) return null;
  return best;
}
