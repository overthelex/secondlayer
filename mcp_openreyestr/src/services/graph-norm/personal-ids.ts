import { uaMatchKey } from '../edr-history/norm';
/**
 * Personal identification numbers in ЄДР entry texts (LEXAI-2322). Some founder / beneficiary /
 * head entries carry the person's РНОКПП (10 digits) glued into the name: 'ТЕСТЕНКО ТЕСТ
 * ТЕСТОВИЧ (1234567890)', '... ІНД.КОД 1234567890', '... РНОКПП: 1234567890', '.../1234567890/АА123456'
 * (with a passport series), and beneficiary influence texts name intermediaries the same way. The
 * graph must not store or expose them, so the builder strips them from person / organisation names
 * (before the node key is computed, so the same person with and without the number is one node)
 * and from the free-text edge attributes.
 *
 * What counts as a personal number:
 *   - in a name: any run of 9 or more digits (a person's name has no digits; 10 = РНОКПП, 9 = an
 *     ID-card number, longer runs are a РНОКПП glued to a postcode or a 12-digit foreign tax
 *     number), and a passport series: a two-letter word with six digits ('АА123456', 'АА №123456');
 *   - in free text (influence, share, role): a standalone 10-digit run only. An 8-digit ЄДРПОУ is a
 *     company code and stays everywhere; amounts (contribution 1234567890,00 грн) are not text
 *     attributes and are not touched.
 *   - in a name, since LEXAI-2321: dates of birth ('01.02.1980 р.н.') and the word 'паспорт' with
 *     the passport data after it.
 * Foreign entities are not cleaned: their codes are registration numbers ('RU|code:1234567890' is
 * a Russian company's 10-digit ИНН), kept as the key or in attrs.codes.
 * A marker before the number goes with it: 'РНОКПП', 'РНКПП', 'ІПН', 'ІНН', 'інд. код',
 * 'ідентифікаційний код / номер', 'реєстраційний номер облікової картки платника податків', 'код',
 * 'номер', '№', 'паспорт серії', and the brackets / punctuation around it.
 */

const L = 'A-Za-zА-ЯҐЄІЇа-яґєіїЁёЫыЭэЪъ';
const SEP = '[\\s.,:;#=№/\\\\()\\[\\]"«»-]*';
/** marker words matched as prefixes ('ідентифікаційний', 'реєстраційного'): long enough not to start a name */
const STEMS = ['рнокп', 'рнкпп', 'ідентифікац', 'идентификац', 'ідентиф', 'облік', 'картк', 'платник', 'податк', 'реєстрац',
  'регистрац', 'паспорт'];
/** marker words matched whole */
const WORDS = ['рнкп', 'рнкпо', 'рнокпо', 'рнопп', 'іпн', 'інн', 'ипн', 'инн', 'ідн', 'інд', 'ід', 'id', 'код', 'кодом', 'коду', 'номер', 'номером', 'номеру', 'номера',
  'дрфо', 'сері[яїи]', 'серия', 'сер', 'ser', 'no', 'n', '№'];
const MARKERS = `(?:(?<![${L}])(?:(?:${STEMS.join('|')})[${L}]*|(?:${WORDS.join('|')})(?![${L}])`
  // 'серіяАА123456': the series glued to the word
  + `|(?:сері[яїи]|серия)(?=[${L}]{2}[\\s№]*[0-9]{6,8}))\\.?${SEP})*`;
const LONG_DIGITS = '(?<![0-9])[0-9]{9,}(?![0-9])';
const TEN_DIGITS = '(?<![0-9])[0-9]{10}(?![0-9])';
/** a two-letter word (or two letters right after 'серія' / 'паспорт') with six to eight digits (seven and eight seen on prod; in a person's name any such token is a document number);
 *  quotes, dots, '/' or '-' may separate the letters from the digits and one '/' may split the digits
 *  ('АА" 12345678', '(АА 1/2345678'): the person key drops that punctuation, so the check would find it there */
const PASSPORT = `(?:(?<![${L}])|(?<=(?:сері|сери|сер|паспорт)[${L}]*))[${L}]{2}[\\s№"'«».\\/-]*[0-9](?:\\/?[0-9]){5,8}(?![0-9])`;
/** an opening bracket or a dot right before the number or its marker ('(1234567890)', ' .1234567890'), not the dot of initials */
const LEAD = '\\s*[(\\[]?\\s*\\.?';
const TAIL = '[)\\]/.]*';

/**
 * LEXAI-2321: a date of birth in a name ('01.02.1980 р.н.', 'д.н. 01/02/1980', '01.02.1980РН') with
 * its markers, and the word 'паспорт' itself: after a name everything from it on is passport data
 * ('ТЕСТЕНКО ТЕСТ ПАСПОРТ СЕРІЯ №', 'ТЕСТ ТЕСТЕР - ПАСПОРТ ГРОМАДЯНИНА ... ВИДАНИЙ ...'); at the start
 * of an entry only the marker goes. Names only: an amount or a date in a free-text attribute is kept.
 */
const DATE = '(?<![0-9])[0-3]?[0-9][./][01]?[0-9][./](?:19|20)[0-9]{2}(?![0-9])';
const DOB = `(?:(?<![${L}])(?:д\\.?\\s?н\\.?|дата\\s+народж[${L}]*|народж[${L}]*|р\\.?\\s?н\\.?)[\\s:.,-]*)?${DATE}`
  + `(?:\\s*(?:р\\.?\\s?н(?![${L}])\\.?|рн(?![${L}])\\.?|(?:року|дата)\\s+народж[${L}]*|р\\.(?![${L}])|року(?![${L}])))?`;
const PASSPORT_WORD = `(?<![${L}])(?:паспорт|passport|pasport)[${L}]*`;
const PASSPORT_TAIL = `(?<=[${L}][^]*?)\\s*[-,(/]?\\s*${PASSPORT_WORD}[^]*$`;
const PASSPORT_LEAD = `^[\\s,.:;/-]*${PASSPORT_WORD}${SEP}(?:(?:сері[яїи]|серия|сер|№|no)(?![${L}])\\.?${SEP})*`;

const NAME_ID_RE = new RegExp(`${LEAD}${MARKERS}(?:${LONG_DIGITS}|${PASSPORT})${TAIL}`, 'gi');
const NAME_DOB_RE = new RegExp(`\\s*[,(]?\\s*${DOB}\\s*\\)?`, 'gi');
const NAME_PASSPORT_RE = new RegExp(`${PASSPORT_TAIL}|${PASSPORT_LEAD}`, 'i');
const TEXT_ID_RE = new RegExp(`${LEAD}${MARKERS}${TEN_DIGITS}${TAIL}`, 'gi');
/** JS twin of NAME_ID_PROBE_SQL: names without any of these are returned unchanged */
const NAME_PROBE_RE = new RegExp(`[0-9]{6}|[0-9]/[0-9]|${PASSPORT}|${DATE}|${PASSPORT_WORD}`, 'i');
const TEXT_PROBE_RE = /[0-9]{10}/;

/**
 * Prefilters for PostgreSQL: the builder sends only the values matching them through the JS
 * cleaners (a superset of what the cleaners change). POSIX classes, so both engines read them alike
 * (PostgreSQL '~' is case-sensitive: the passport word is spelled out in both cases).
 */
const PASSPORT_WORD_SQL = '[Пп][Аа][Сс][Пп][Оо][Рр][Тт]|[Pp][Aa][Ss][Ss]?[Pp][Oo][Rr][Tt]';
const DATE_SQL = '[0-9][./][01]?[0-9][./](19|20)[0-9]{2}';
/**
 * SQL pre-filter of the names sent to stripPersonIds in the build. Names it misses keep their raw label and
 * key (name_latn from the source row), so it must be a superset of what the post-build checks find:
 * any six digits in a row, a digit/digit pair (a number split by '/'), a date or the passport word.
 * The test 'NAME_ID_PROBE_SQL covers every check' pins that.
 */
export const NAME_ID_PROBE_SQL = `[0-9]{6}|[0-9]/[0-9]|${DATE_SQL}|${PASSPORT_WORD_SQL}`;
export const TEXT_ID_PROBE_SQL = '[0-9]{10}';

/** The check after a build (builder.ts): a 10-digit run left in a label, a key or a text attribute. */
export const TEN_DIGITS_SQL = '(^|[^0-9])[0-9]{10}([^0-9]|$)';
/**
 * The passport check after a build (LEXAI-2321), for person / organisation labels and keys: a
 * passport series ('АА123456', 'АА № 123456') or the word 'паспорт' (the key spells it 'pasport').
 * Not for foreign entities, whose registration numbers look like series ('HE 123456', 'FN 123456 z'):
 * those are checked with PASSPORT_WORD_CHECK_SQL / DOB_CHECK_SQL only.
 */
export const PASSPORT_CHECK_SQL = `(^|[^${L}])[${L}]{2}[ №]*[0-9]{6,8}([^0-9]|$)|(^|[^${L}])(${PASSPORT_WORD_SQL})`;
export const PASSPORT_WORD_CHECK_SQL = `(^|[^${L}])(${PASSPORT_WORD_SQL})`;
/** A date of birth left in a person's label (any full date: a person's name has none) or written with 'р.н.' / 'д.н.' elsewhere. */
export const DATE_CHECK_SQL = '(^|[^0-9])[0-3]?[0-9][./][01]?[0-9][./](19|20)[0-9]{2}([^0-9]|$)';
export const DOB_CHECK_SQL = `${DATE_SQL} ?([Рр]\\.? ?[Нн]([^${L}]|$)|[Рр][Оо][Кк][Уу] [Нн][Аа][Рр])|([Дд]\\. ?[Нн]\\.|[Рр]\\. ?[Нн]\\.) ?[0-9]{1,2}[./][0-9]{1,2}[./](19|20)[0-9]{2}`;

function tidy(s: string): string {
  let out = s;
  for (let i = 0; i < 3; i++) {
    const prev = out;
    out = out
      .replace(/\(\s*\)|\[\s*\]|«\s*»|"\s*"/g, ' ')
      .replace(/\s+([,;:)\]])/g, '$1')
      .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
      .replace(/\s+/g, ' ')
      .replace(/^[\s,;:/\\-]+|[\s,;:/\\(-]+$/g, '');
    if (out === prev) break;
  }
  return out;
}

/** A name without the personal numbers in it (unchanged when it has none). */
export function stripPersonIds(name: string): string;
export function stripPersonIds(name: string | null | undefined): string | null | undefined;
export function stripPersonIds(name: string | null | undefined): string | null | undefined {
  if (!name || !NAME_PROBE_RE.test(name)) return name;
  NAME_ID_RE.lastIndex = 0;
  NAME_DOB_RE.lastIndex = 0;
  let out = name.replace(NAME_ID_RE, ' ').replace(NAME_DOB_RE, ' ').replace(NAME_PASSPORT_RE, ' ');
  out = out === name ? name : tidy(out);
  // Safety net: whatever the post-build checks would still find in the name or in its key (uaMatchKey
  // turns '№' into two letters, drops quotes and brackets) goes with every run of six or more digits:
  // a person's name has none of its own (decree numbers, codes, documents glued to it on prod).
  if (failsNameChecks(out)) {
    LONG_RUN_RE.lastIndex = 0;
    out = tidy(out.replace(LONG_RUN_RE, ' '));
  }
  return out;
}

const LONG_RUN_RE = /(?:[№#]\s*)?(?<![0-9])[0-9](?:[\/.\s-]?[0-9]){5,}(?![0-9])/g;
function failsNameChecks(s: string): boolean {
  if (!s) return false;
  const key = uaMatchKey(s) || '';
  return NAME_CHECK_RES.some(r => r.test(s) || r.test(key));
}

/** A free-text attribute (influence, share, role) without the 10-digit personal numbers in it; 8-digit codes stay. */
export function stripIdNumbers(text: string): string;
export function stripIdNumbers(text: string | null | undefined): string | null | undefined;
export function stripIdNumbers(text: string | null | undefined): string | null | undefined {
  if (!text || !TEXT_PROBE_RE.test(text)) return text;
  TEXT_ID_RE.lastIndex = 0;
  const out = text.replace(TEXT_ID_RE, ' ');
  return out === text ? text : tidy(out);
}

/**
 * Passport data or a date of birth in a foreign founder's code or name (LEXAI-2321): the entry names
 * an individual. A code: the word 'паспорт', any full date ('01.02.1980', '01.02.1980 Р.Н.'), a date
 * glued to 'РН' ('01021980РН'), a Russian passport ('1234 567890', '12 34 567890'; an ИНН has no
 * space and is a company's). A name: the word 'паспорт' or a date marked as a birth date.
 */
const COMPACT_DOB = `(?<![0-9])[0-3][0-9][01][0-9](?:19|20)[0-9]{2}\\s*(?:р\\.?\\s?н|рн|д\\.?\\s?н)(?![${L}])`;
const MARKED_DOB = `${DATE}\\s*(?:р\\.?\\s?н(?![${L}])|рн(?![${L}])|року\\s+народж)|(?:д\\.?\\s?н\\.?|р\\.\\s?н\\.|дата\\s+народж[${L}]*|народж[${L}]*)[\\s:.,-]*${DATE}`;
const CODE_MARK_RE = new RegExp(`${PASSPORT_WORD}|${DATE}|${COMPACT_DOB}`, 'i');
const NAME_MARK_RE = new RegExp(`${PASSPORT_WORD}|${MARKED_DOB}|${COMPACT_DOB}`, 'i');
const RU_PASSPORT_CODE_RE = /^\s*(?:сері[яї]\s*)?[0-9]{2}\s?[0-9]{2}\s+(?:№\s*)?[0-9]{6}\s*$/i;

export function hasPersonalIdMarker(code: string | null | undefined, as: 'code' | 'name' = 'code'): boolean {
  if (!code) return false;
  return as === 'code' ? CODE_MARK_RE.test(code) || RU_PASSPORT_CODE_RE.test(code) : NAME_MARK_RE.test(code);
}

/** A foreign entity's name without dates of birth and passport words; its registration numbers stay. */
export function stripPersonalMarkers(name: string): string;
export function stripPersonalMarkers(name: string | null | undefined): string | null | undefined;
export function stripPersonalMarkers(name: string | null | undefined): string | null | undefined {
  if (!name || !NAME_MARK_RE.test(name)) return name;
  NAME_DOB_RE.lastIndex = 0;
  const out = name.replace(NAME_DOB_RE, ' ').replace(NAME_PASSPORT_RE, ' ');
  return out === name ? name : tidy(out);
}

/** True when a value still carries a standalone 10-digit run (the post-build check, in JS). */
export function hasTenDigits(s: string | null | undefined): boolean {
  return !!s && new RegExp(TEN_DIGITS_SQL).test(s);
}

/** True when a person's label still carries a passport series, the word 'паспорт' or a full date (the LEXAI-2321 checks, in JS). */
export function hasPassportOrDob(s: string | null | undefined): boolean {
  return !!s && (new RegExp(PASSPORT_CHECK_SQL).test(s) || new RegExp(DATE_CHECK_SQL).test(s));
}

const NAME_CHECK_RES = [new RegExp(PASSPORT_CHECK_SQL), new RegExp(DATE_CHECK_SQL), new RegExp(TEN_DIGITS_SQL)];
