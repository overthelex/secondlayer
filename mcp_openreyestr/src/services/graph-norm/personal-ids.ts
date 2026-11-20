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
  + `|(?:сері[яїи]|серия)(?=[${L}]{2}[\\s№]*[0-9]{6}))\\.?${SEP})*`;
const LONG_DIGITS = '(?<![0-9])[0-9]{9,}(?![0-9])';
const TEN_DIGITS = '(?<![0-9])[0-9]{10}(?![0-9])';
/** a two-letter word (or two letters right after 'серія' / 'паспорт') with six digits */
const PASSPORT = `(?:(?<![${L}])|(?<=(?:сері|сери|сер|паспорт)[${L}]*))[${L}]{2}[\\s№]*[0-9]{6}(?![0-9])`;
/** an opening bracket or a dot right before the number or its marker ('(1234567890)', ' .1234567890'), not the dot of initials */
const LEAD = '\\s*[(\\[]?\\s*\\.?';
const TAIL = '[)\\]/.]*';

const NAME_ID_RE = new RegExp(`${LEAD}${MARKERS}(?:${LONG_DIGITS}|${PASSPORT})${TAIL}`, 'gi');
const TEXT_ID_RE = new RegExp(`${LEAD}${MARKERS}${TEN_DIGITS}${TAIL}`, 'gi');
const NAME_PROBE_RE = new RegExp(`[0-9]{9}|${PASSPORT}`, 'i');
const TEXT_PROBE_RE = /[0-9]{10}/;

/**
 * Prefilters for PostgreSQL: the builder sends only the values matching them through the JS
 * cleaners (a superset of what the cleaners change). POSIX classes, so both engines read them alike.
 */
export const NAME_ID_PROBE_SQL = `[0-9]{9}|[${L}]{2}[ №]*[0-9]{6}`;
export const TEXT_ID_PROBE_SQL = '[0-9]{10}';

/** The check after a build (builder.ts): a 10-digit run left in a label, a key or a text attribute. */
export const TEN_DIGITS_SQL = '(^|[^0-9])[0-9]{10}([^0-9]|$)';

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
  const out = name.replace(NAME_ID_RE, ' ');
  return out === name ? name : tidy(out);
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

/** True when a value still carries a standalone 10-digit run (the post-build check, in JS). */
export function hasTenDigits(s: string | null | undefined): boolean {
  return !!s && new RegExp(TEN_DIGITS_SQL).test(s);
}
