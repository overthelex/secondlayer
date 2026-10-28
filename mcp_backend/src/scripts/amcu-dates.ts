/**
 * Date resolution for the АМКУ importers (LEXAI-2118).
 *
 * opendata_amcu_decisions used to take decision_date from the FIRST dd.mm.yyyy
 * found anywhere in the archive path. Two failure modes followed:
 *   - the file name itself is mistyped by АМКУ: «Рішення від 11.08.2026 № 447-р»
 *     sits in rish_сherven_2026.zip and its text says «11 червня 2026 р.»;
 *   - the first date in the path is a batch FOLDER («Рішення від 20.01.2018
 *     №742-768/Рішення від 20 12 2018 № 758-р»), not the document.
 * The signed date in the document header is authoritative, so it now wins, with the
 * file name as fallback and the archive/folder name as tie-breaker.
 *
 * opendata_amcu_bid_rigging stores dateOfDecision verbatim from the source XLSX.
 * Some rows are yyyy-dd-mm (decision 70/54-р/к: «2026-09-04» first appears in the
 * list published 13.04.2026, i.e. 9 April) — a date after the list's own
 * publication date is impossible, so the day/month swap is taken when it fits.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD only if (y, m, d) is a real calendar date, else null. */
export function isoIfValid(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2100) return null;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > dim[m - 1]) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

// Latin letters that are visually identical to Cyrillic ones. АМКУ archive and
// document names mix them («rish_сherven» has a Cyrillic с; headers may carry a
// Latin «c»/«o»/«p» inside a Ukrainian word).
const LATIN_TO_CYR: Record<string, string> = {
  a: 'а', c: 'с', e: 'е', i: 'і', o: 'о', p: 'р', x: 'х', y: 'у', k: 'к',
};
const CYR_TO_LATIN: Record<string, string> = {
  а: 'a', с: 'c', е: 'e', і: 'i', о: 'o', р: 'p', х: 'x', у: 'y', к: 'k',
};

// Ukrainian month stems: cover nominative (червень), genitive (червня) and
// other case forms. Order matters only in that no stem is a prefix of another.
const UA_MONTH_STEMS: Array<[RegExp, number]> = [
  [/^січ/, 1], [/^лют/, 2], [/^берез/, 3], [/^квіт/, 4], [/^трав/, 5], [/^черв/, 6],
  [/^лип/, 7], [/^серп/, 8], [/^верес/, 9], [/^жовт/, 10], [/^листопад/, 11], [/^груд/, 12],
];

// Transliterated month names as АМКУ spells them in archive names
// (rish_sichen, rish_lutiy/lyutyy/lutuy, rishena_berezen, rish_kviten, rish_traven,
// rish_cherven/sherven, lypen, rish_serpen, rish_veres, zhovten/zovten,
// listopad/lystopad/lustopad, hruden/gruden).
const LATIN_MONTH_STEMS: Array<[RegExp, number]> = [
  [/^sich/, 1], [/^(?:lut|lyut|liut)/, 2], [/^berez/, 3], [/^kvit/, 4], [/^trav/, 5],
  [/^(?:cherv|sherv|cerv)/, 6], [/^(?:lyp|lip)/, 7], [/^serp/, 8], [/^veres/, 9],
  [/^(?:zhovt|zovt|jovt)/, 10], [/^(?:listop|lystop|lustop)/, 11], [/^(?:hrud|grud)/, 12],
];

/**
 * Month number for a Ukrainian month word (any case form, Cyrillic or
 * transliterated, with Latin/Cyrillic look-alike letters mixed in), else null.
 */
export function monthFromToken(token: string): number | null {
  const t = token.toLowerCase().trim();
  if (!t) return null;
  const cyr = t.replace(/[aceiopxyk]/g, ch => LATIN_TO_CYR[ch] ?? ch);
  if (/^[а-яіїєґ']+$/.test(cyr)) {
    for (const [rx, m] of UA_MONTH_STEMS) if (rx.test(cyr)) return m;
  }
  const lat = t.replace(/[асеіорхук]/g, ch => CYR_TO_LATIN[ch] ?? ch);
  if (/^[a-z]+$/.test(lat)) {
    for (const [rx, m] of LATIN_MONTH_STEMS) if (rx.test(lat)) return m;
  }
  return null;
}

/**
 * The date in a decision's header: «РІШЕННЯ 11 червня 2026 р. Київ № 447-р» or
 * «РІШЕННЯ 23.10.2025 Київ № 697-р». Only the header (text before the first «№»,
 * at most 300 chars) is searched, and the date must be followed by «(р.) Київ»:
 * some extracted texts start mid-preamble («…подання Департаменту … від 17.10.2018
 * № 500-…»), and such a cited date is not the decision date.
 */
const KYIV_AFTER = /^\s*(?:р\.?|року|p\.?)?\s*[,.]?\s*(?:м\.\s*)?[КK]иїв/;

export function headerDateOf(body: string | null | undefined): string | null {
  if (!body) return null;
  const flat = body.replace(/\s+/g, ' ').slice(0, 400);
  const no = flat.indexOf('№');
  const head = no >= 0 && no <= 300 ? flat.slice(0, no) : flat.slice(0, 300);

  const cands: Array<{ at: number; iso: string }> = [];
  const kyivAfter = (end: number) => KYIV_AFTER.test(head.slice(end, end + 30));
  const verbal = /(\d{1,2})\s*[»"”']?\s*([A-Za-zА-Яа-яІіЇїЄєҐґ']{3,})\s*,?\s*(\d{4})/g;
  for (let m; (m = verbal.exec(head)); ) {
    const mon = monthFromToken(m[2]);
    const iso = mon ? isoIfValid(+m[3], mon, +m[1]) : null;
    if (iso && kyivAfter(m.index + m[0].length)) cands.push({ at: m.index, iso });
  }
  const numeric = /(\d{1,2})\s*[./]\s*(\d{1,2})\s*[./]\s*(\d{4})/g;
  for (let m; (m = numeric.exec(head)); ) {
    const iso = isoIfValid(+m[3], +m[2], +m[1]);
    if (iso && kyivAfter(m.index + m[0].length)) cands.push({ at: m.index, iso });
  }
  cands.sort((a, b) => a.at - b.at);
  return cands[0]?.iso ?? null;
}

/** Last component of an `outer.zip!dir/inner!dir/doc.docx` chain. */
function baseOf(docPath: string): string {
  const parts = docPath.split(/[!/\\]/);
  return parts[parts.length - 1] || docPath;
}

function firstDate(s: string, sep: string): string | null {
  const dmy = new RegExp(`(?:^|\\D)(\\d{2})\\s*[${sep}]\\s*(\\d{2})\\s*[${sep}]\\s*((?:19|20)\\d{2})(?!\\d)`, 'g');
  for (let m; (m = dmy.exec(s)); ) {
    const iso = isoIfValid(+m[3], +m[2], +m[1]);
    if (iso) return iso;
  }
  const ymd = new RegExp(`(?:^|\\D)((?:19|20)\\d{2})\\s*[${sep}]\\s*(\\d{2})\\s*[${sep}]\\s*(\\d{2})(?!\\d)`, 'g');
  for (let m; (m = ymd.exec(s)); ) {
    const iso = isoIfValid(+m[1], +m[2], +m[3]);
    if (iso) return iso;
  }
  return null;
}

/**
 * Date from the document's own file name (dd.mm.yyyy, dd mm yyyy, dd_mm_yyyy,
 * yyyy.mm.dd), else — as before — the first dd-mm-yyyy / dd.mm.yyyy anywhere in
 * the path. Underscore/space separators are accepted only in the file name: on the
 * outer archive they are the publication date of the batch, not of the decision.
 */
export function fileDateOf(docPath: string): string | null {
  return firstDate(baseOf(docPath), '-._ ') ?? firstDate(docPath, '-.');
}

/** Month implied by a transliterated/Ukrainian month word in the archive/folder path. */
export function monthHintOf(docPath: string): number | null {
  const dirs = docPath.slice(0, docPath.length - baseOf(docPath).length);
  for (const tok of dirs.split(/[^A-Za-zА-Яа-яІіЇїЄєҐґ']+/)) {
    if (tok.length < 4) continue;
    const m = monthFromToken(tok);
    if (m) return m;
  }
  return null;
}

function yearHintsOf(docPath: string): Set<number> {
  const dirs = docPath.slice(0, docPath.length - baseOf(docPath).length);
  const out = new Set<number>();
  for (const m of dirs.matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/g)) out.add(+m[1]);
  return out;
}

/**
 * decision_date for an opendata_amcu_decisions row.
 *   - header date and file-name date agree, or only one exists → that one;
 *   - they differ only in the year (the January «old year» slip happens on both
 *     sides) → the one whose year the archive/folder path names, else the file name;
 *   - day/month differ → the one whose month the archive name names
 *     («rish_сherven_2026»), else the header.
 */
export function resolveDecisionDate(docPath: string, body: string | null | undefined): string | null {
  const b = headerDateOf(body);
  const f = fileDateOf(docPath);
  if (!b || !f || b === f) return b ?? f;
  if (b.slice(5) === f.slice(5)) {
    const years = yearHintsOf(docPath);
    return years.has(+b.slice(0, 4)) && !years.has(+f.slice(0, 4)) ? b : f;
  }
  const hint = monthHintOf(docPath);
  if (hint) {
    const bm = +b.slice(5, 7), fm = +f.slice(5, 7);
    if (fm === hint && bm !== hint) return f;
  }
  return b;
}

// ─── bid-rigging (zvedeni-vidomosti) ────────────────────────────────────────

/** Publication date of a «zvedeni-vidomosti_dd_mm_yyyy.xlsx» list, else null. */
export function sourceFileDateOf(sourceFile: string): string | null {
  const m = sourceFile.match(/(\d{2})_(\d{2})_(\d{4})/);
  return m ? isoIfValid(+m[3], +m[2], +m[1]) : null;
}

const EN_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Parse a dateOfDecision cell value (already stringified) without context. */
function parseCellDate(s: string): string | null {
  let m = s.match(/^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{1,2}) (\d{4})/); // JS Date#toString()
  if (m) {
    const mon = EN_MONTHS.indexOf(m[1].toLowerCase()) + 1;
    return mon ? isoIfValid(+m[3], mon, +m[2]) : null;
  }
  m = s.match(/(\d{1,2})\s*[.\/ ]\s*(\d{1,2})\s*[.\/ ]\s*(\d{4})/); // d.m.yyyy, d/m/yyyy, d m yyyy
  if (m) return isoIfValid(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); // yyyy-m-d (some files store yyyy-d-m)
  if (m) return isoIfValid(+m[1], +m[2], +m[3]) ?? isoIfValid(+m[1], +m[3], +m[2]);
  m = s.match(/^(\d{5})(?:\.0+)?$/); // Excel serial day number stored as text
  if (m) {
    const n = +m[1];
    if (n < 20000 || n > 80000) return null;
    return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
  }
  return null;
}

/**
 * dateOfDecision → YYYY-MM-DD. When `notAfter` (the list's publication date) is
 * known and the parsed date lies after it, the day/month swap is used instead if
 * that is a valid date not after `notAfter`.
 */
export function parseBidRiggingDate(s: string | null | undefined, notAfter?: string | null): string | null {
  if (!s) return null;
  const iso = parseCellDate(String(s).trim());
  if (!iso || !notAfter || iso <= notAfter) return iso;
  const swapped = isoIfValid(+iso.slice(0, 4), +iso.slice(8, 10), +iso.slice(5, 7));
  return swapped && swapped <= notAfter ? swapped : iso;
}
