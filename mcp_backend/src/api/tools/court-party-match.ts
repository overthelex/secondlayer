/**
 * Party matching for search_case_status_by_party.
 *
 * The ДСА "стан розгляду справ" dataset and the hearing archive both keep the parties of a
 * case as one free-text field: "відповідач: Яворська Лариса Григорівна,  позивач: ПАТ КБ
 * \"Приватбанк\",  Представник позивача: …". Postgres narrows the rows with
 * to_tsvector('simple', …) @@ to_tsquery (a GIN index on both tables); this module then
 * splits the field into "role: name" segments and keeps a row only when ONE segment holds
 * every word of the query, so "Іван Петренко" does not match "Петренко Олег, Іван Сидоренко".
 * Initials ("Яворська Л.Г.") cannot be lexemes, so SQL only asks for some word starting with
 * each initial (prefix query) and the order is checked here against the words that follow
 * (or precede) the surname.
 */

/** Abbreviated legal forms: written differently in the source ("ПАТ КБ", "АТ КБ", spelled out). */
const LEGAL_FORMS = new Set([
  'тов', 'тзов', 'пат', 'прат', 'ат', 'кб', 'пп', 'фоп', 'спд', 'дп', 'кп', 'ват', 'зат',
  'оп', 'сг', 'фг', 'гс', 'ооо', 'пао', 'зао', 'оао', 'llc', 'ltd',
]);

export interface PartyQuery {
  /** Lower-cased full words that must all occur in one party segment. */
  words: string[];
  /** Initials in the order written ("Л.Г." → ['л', 'г']). */
  initials: string[];
  /** Legal-form abbreviations dropped from the required words. */
  droppedForms: string[];
  /** Words are stems: match any word that starts with them (fallback for inflected names). */
  prefix?: boolean;
}

/** Lexeme-like tokens, the way the 'simple' text-search parser splits Cyrillic text. */
export function tokenize(text: string): string[] {
  return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function parsePartyQuery(raw: string): PartyQuery {
  const tokens = tokenize(raw);
  const initials = tokens.filter((t) => t.length === 1 && /\p{L}/u.test(t));
  let words = tokens.filter((t) => !(t.length === 1 && /\p{L}/u.test(t)));
  const droppedForms = words.filter((w) => LEGAL_FORMS.has(w));
  const meaningful = words.filter((w) => !LEGAL_FORMS.has(w));
  if (meaningful.length > 0) words = meaningful;
  return { words: [...new Set(words)], initials, droppedForms: meaningful.length > 0 ? droppedForms : [] };
}

/** to_tsquery('simple', …) text. Tokens are letters/digits only, so quoting is enough. */
export function buildTsQuery(q: PartyQuery): string {
  return [...q.words.map((w) => (q.prefix ? `'${w}':*` : `'${w}'`)), ...[...new Set(q.initials)].map((i) => `'${i}':*`)].join(' & ');
}

export interface PartySegment { label: string | null; name: string }

/** A label that continues the previous words of the role ("особа, яка …", "особа, що …"). */
const CONTINUATION_LABEL = /^\s*(яка|який|які|що)\s/u;

/**
 * "роль: ім'я" segments. A label is the text between a comma (or the start) and a colon;
 * a comma inside a company name is kept because no colon follows it.
 */
export function splitParticipants(text: string): PartySegment[] {
  const s = String(text || '');
  const re = /(?:^|,)\s*([^,:]{2,80}?)\s*:\s*/gu;
  const marks: { label: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    marks.push({ label: m[1], start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  if (marks.length === 0) return s.trim() ? [{ label: null, name: s.trim() }] : [];
  // "особа, яка притягається до адміністративної відповідальності: …": the role label itself
  // has a comma, so the regex only captured "яка …". Pull the chunk before that comma back into
  // the label instead of emitting "особа" as a party of its own.
  marks.forEach((mk, i) => {
    if (!CONTINUATION_LABEL.test(mk.label)) return;
    const from = i > 0 ? marks[i - 1].end : 0;
    const before = s.slice(from, mk.start);
    const cut = before.lastIndexOf(',');
    // After another label the chunk must follow a comma, or it is that party's name.
    if (i > 0 && cut < 0) return;
    const head = before.slice(cut + 1).trim();
    if (!head || head.length > 40 || /\d/u.test(head)) return;
    mk.label = `${head}, ${mk.label.trim()}`;
    mk.start = from + (cut >= 0 ? cut : 0);
  });
  const out: PartySegment[] = [];
  if (marks[0].start > 0) {
    const lead = s.slice(0, marks[0].start).replace(/[\s,]+$/u, '').trim();
    if (lead) out.push({ label: null, name: lead });
  }
  marks.forEach((mk, i) => {
    const stop = i + 1 < marks.length ? marks[i + 1].start : s.length;
    const name = s.slice(mk.end, stop).replace(/[\s,]+$/u, '').trim();
    if (name) out.push({ label: mk.label, name });
  });
  return out;
}

/** Canonical role from a source label ("Представник позивача", "Позивач (заявник)", "3-я особа"…). */
export function canonicalRole(label: string | null): string | null {
  if (!label) return null;
  let l = label.toLowerCase().replace(/\s+/g, ' ').trim();
  // "особа, яка притягається до адмін. відповідальності" loses "особа" at the comma.
  if (/^(яка|який|які|що)\s/u.test(l)) l = `особа, ${l}`;
  if (l.includes('представник')) return l;
  if (l.startsWith('позивач')) return 'позивач';
  if (l.startsWith('відповідач')) return 'відповідач';
  if (/^(третя|3-я|3-тя)\s+особа/u.test(l)) return 'третя особа';
  return l;
}

export const MATCH_VARIANT = {
  full: 'повний збіг',
  initials: 'прізвище + ініціали',
  tokens: 'усі слова запиту',
  stem: 'інша форма слова (відмінок)',
} as const;

/** Shortest stem kept: shorter ones ("іван") would match unrelated surnames. */
const MIN_STEM = 5;

/**
 * Fallback for inflected input ("Яворської", "Шевченка", "Петренку"): the source writes names
 * in the nominative, so each word of 6+ letters is cut by its last two letters and matched as a
 * prefix. Returns null when no word can be shortened (nothing new to try).
 */
export function stemQuery(q: PartyQuery): PartyQuery | null {
  let changed = false;
  const words = q.words.map((w) => {
    if (/\p{N}/u.test(w) || w.length - 2 < MIN_STEM) return w;
    changed = true;
    return w.slice(0, -2);
  });
  return changed ? { ...q, words: [...new Set(words)], prefix: true } : null;
}

function wordMatches(token: string, w: string, prefix?: boolean): boolean {
  return prefix ? token.startsWith(w) : token === w;
}

export type MatchVariant = (typeof MATCH_VARIANT)[keyof typeof MATCH_VARIANT];

export interface PartyMatch {
  role: string | null;
  role_label: string | null;
  name: string;
  match_variant: MatchVariant;
}

/** Name words split on spaces and punctuation but NOT apostrophes ("Мар'яна" stays one word). */
function nameWords(name: string): string[] {
  return name.toLowerCase().split(/[\s,.;()«»]+/u)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter(Boolean);
}

function initialsFollow(words: string[], from: number, initials: string[]): boolean {
  if (from < 0 || from + initials.length > words.length) return false;
  return initials.every((ini, k) => words[from + k].startsWith(ini));
}

function hasInitials(segmentName: string, q: PartyQuery): boolean {
  const ws = nameWords(segmentName);
  const last = q.words[q.words.length - 1];
  const first = q.words[0];
  for (let i = 0; i < ws.length; i++) {
    const parts = tokenize(ws[i]);
    // Participants are "Прізвище Ім'я По-батькові": initials after the surname.
    if (parts.some((t) => wordMatches(t, last, q.prefix)) && initialsFollow(ws, i + 1, q.initials)) return true;
    // "Л.Г. Яворська" style written in the source.
    if (parts.some((t) => wordMatches(t, first, q.prefix)) && initialsFollow(ws, i - q.initials.length, q.initials)) return true;
  }
  return false;
}

function containsSequence(hay: string[], needle: string[]): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}

export function matchSegment(segment: PartySegment, q: PartyQuery): PartyMatch | null {
  if (q.words.length === 0) return null;
  const toks = tokenize(segment.name);
  const set = new Set(toks);
  if (!q.words.every((w) => (q.prefix ? toks.some((t) => t.startsWith(w)) : set.has(w)))) return null;
  let variant: MatchVariant;
  if (q.prefix) {
    if (q.initials.length > 0 && !hasInitials(segment.name, q)) return null;
    variant = MATCH_VARIANT.stem;
  } else if (q.initials.length > 0) {
    if (!hasInitials(segment.name, q)) return null;
    variant = MATCH_VARIANT.initials;
  } else {
    const core = toks.filter((t) => !LEGAL_FORMS.has(t));
    // A company's own name is the quoted part: АТ КБ «ПРИВАТБАНК» is a full match for «Приватбанк».
    const quoted = [...segment.name.matchAll(/[«"“]([^«»"“”]+)[»"”]/gu)].map((m) => tokenize(m[1]));
    const whole = (core.length === q.words.length && containsSequence(core, q.words))
      || quoted.some((qt) => qt.length === q.words.length && containsSequence(qt, q.words));
    variant = (q.words.length >= 2 && containsSequence(toks, q.words)) || whole ? MATCH_VARIANT.full : MATCH_VARIANT.tokens;
  }
  return { role: canonicalRole(segment.label), role_label: segment.label, name: segment.name, match_variant: variant };
}

/** Every party segment of the field that matches the query; empty when none does. */
export function matchParticipants(text: string | null | undefined, q: PartyQuery): PartyMatch[] {
  if (!text) return [];
  const out: PartyMatch[] = [];
  for (const seg of splitParticipants(text)) {
    const m = matchSegment(seg, q);
    if (m) out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Regions: court names carry the oblast in the genitive ("… Вінницької області"); appellate
// and district administrative courts carry it as an adjective ("Вінницький апеляційний суд").

interface RegionDef { name: string; stems: string[]; patterns: string[] }

const oblast = (name: string, stems: string[], genitive: string, adjective: string, appellate = adjective): RegionDef => ({
  name,
  stems,
  patterns: [`%${genitive} області%`, `%${appellate} апеляційний%`, `%${adjective} окружний%`],
});

export const REGIONS: RegionDef[] = [
  // Київський апеляційний суд hears appeals from both the city and the oblast, so it is in both
  // regions. «Київський окружний адміністративний суд» is the oblast's; the city's is
  // «Окружний адміністративний суд міста Києва» (covered by «міста Києва»).
  { name: 'м. Київ', stems: ['київ', 'києв', 'kyiv', 'kiev'], patterns: ['%міста Києва%', '%м. Києва%', '%м.Києва%', '%м. Київ%', '%Київський апеляційний%'] },
  { name: 'м. Севастополь', stems: ['севастопол'], patterns: ['%Севастопол%'] },
  { name: 'Автономна Республіка Крим', stems: ['крим', 'арк', 'автономна'], patterns: ['%Автономної Республіки Крим%'] },
  oblast('Київська область', ['київськ'], 'Київської', 'Київський'),
  oblast('Вінницька область', ['вінниц'], 'Вінницької', 'Вінницький'),
  oblast('Волинська область', ['волин', 'луцьк'], 'Волинської', 'Волинський'),
  oblast('Дніпропетровська область', ['дніпр'], 'Дніпропетровської', 'Дніпропетровський', 'Дніпровський'),
  oblast('Донецька область', ['донец'], 'Донецької', 'Донецький'),
  oblast('Житомирська область', ['житомир'], 'Житомирської', 'Житомирський'),
  oblast('Закарпатська область', ['закарпат', 'ужгород'], 'Закарпатської', 'Закарпатський'),
  oblast('Запорізька область', ['запоріз', 'запоріж'], 'Запорізької', 'Запорізький'),
  oblast('Івано-Франківська область', ['івано', 'франків'], 'Івано-Франківської', 'Івано-Франківський'),
  oblast('Кіровоградська область', ['кіровоград', 'кропивниц'], 'Кіровоградської', 'Кіровоградський', 'Кропивницький'),
  oblast('Луганська область', ['луган'], 'Луганської', 'Луганський'),
  oblast('Львівська область', ['львів'], 'Львівської', 'Львівський'),
  oblast('Миколаївська область', ['миколаїв'], 'Миколаївської', 'Миколаївський'),
  oblast('Одеська область', ['одес'], 'Одеської', 'Одеський'),
  oblast('Полтавська область', ['полтав'], 'Полтавської', 'Полтавський'),
  oblast('Рівненська область', ['рівн'], 'Рівненської', 'Рівненський'),
  oblast('Сумська область', ['сум'], 'Сумської', 'Сумський'),
  oblast('Тернопільська область', ['терноп'], 'Тернопільської', 'Тернопільський'),
  oblast('Харківська область', ['харків'], 'Харківської', 'Харківський'),
  oblast('Херсонська область', ['херсон'], 'Херсонської', 'Херсонський'),
  oblast('Хмельницька область', ['хмельниц'], 'Хмельницької', 'Хмельницький'),
  oblast('Черкаська область', ['черка'], 'Черкаської', 'Черкаський'),
  oblast('Чернівецька область', ['чернівец', 'чернівц'], 'Чернівецької', 'Чернівецький'),
  oblast('Чернігівська область', ['чернігів'], 'Чернігівської', 'Чернігівський'),
];

/** Region input ("Київ", "м. Київ", "Київська обл.", "Львівська область") → definition, or null. */
export function resolveRegion(raw: string): RegionDef | null {
  // Word list rather than \b: JS \b is ASCII-only and never fires next to Cyrillic.
  const s = String(raw || '').toLowerCase()
    .split(/[^\p{L}-]+/u)
    .filter((w) => w && !['область', 'обл', 'місто', 'м'].includes(w))
    .join(' ');
  if (!s) return null;
  // Oblasts first: "київськ…" must not resolve to the city.
  const ordered = [...REGIONS.slice(3), ...REGIONS.slice(0, 3)];
  return ordered.find((r) => r.stems.some((st) => s.startsWith(st))) ?? null;
}
