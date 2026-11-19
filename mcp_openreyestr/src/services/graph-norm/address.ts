/**
 * Ukrainian address normalisation for the relationship graph (LEXAI-2302): companies that
 * share a registered address are linked by an edge, so two spellings of one address must give
 * one key.
 *
 * normAddress('Україна, 09100, ВУЛ. СХІДНА, 32-А, КВ. 41, М.БІЛА ЦЕРКВА, КИЇВСЬКА ОБЛАСТЬ')
 *   parts: postcode 09100, oblast київська (UA-32), settlement місто біла церква,
 *          street вулиця східна, building 32а, premises квартира 41
 *   keys:  settlementKey 'UA-32|м|била церква'
 *          streetKey     'UA-32|м|била церква|вул|схидна'
 *          addressKey    'UA-32|м|била церква|вул|схидна|32а'          (same building)
 *          premisesKey   'UA-32|м|била церква|вул|схидна|32а|кв41'     (same flat / office)
 *
 * Both ЄДР layouts are read: the current one ('Україна, 01001, Х обл., Х р-н, місто Х, ВУЛИЦЯ Х,
 * будинок 1, квартира 2') and the pre-2016 one ('Україна, 01001, ВУЛ.Х, 1, КВ.2, М.Х, Х ОБЛАСТЬ':
 * reversed, bare building number). Parts keep a readable lower-case Ukrainian spelling; keys fold
 * spelling noise: case, apostrophes, і/и/ї/ы, е/є/э, ґ/г, soft signs, doubled letters, a few
 * Russian adjective endings (-ская = -ська), initials and given names / titles in street names
 * ('вул. І. Франка' = 'вулиця Івана Франка' = 'вул. Франка'), word order ('Липинського
 * В'ячеслава'). Renamed settlements (Дніпропетровськ -> Дніпро, a '(п)' marker) and, when an index
 * is passed, renamed streets are keyed by their current name.
 *
 * Keys omit the raion (the 2020 reform changed most of them) and the oblast name spelling (an
 * ISO 3166-2 code instead; from the postcode when the text has none). A village or селище adds
 * its postcode to the settlement key, since village names repeat within an oblast.
 */

import { countryIso } from '../edr-history/norm';

export type SettlementType = 'місто' | 'смт' | 'селище' | 'село' | 'хутір';
export type StreetType =
  | 'вулиця' | 'провулок' | 'проспект' | 'бульвар' | 'площа' | 'майдан' | 'узвіз' | 'спуск'
  | 'набережна' | 'шосе' | 'проїзд' | 'тупик' | 'алея' | 'дорога' | 'лінія' | 'вїзд'
  | 'мікрорайон' | 'квартал' | 'масив' | 'урочище' | 'територія';
export type PremisesType = 'квартира' | 'офіс' | 'кімната' | 'приміщення';
export type ParseStatus = 'full' | 'partial' | 'failed';

export interface AddressParts {
  raw: string;
  country: string | null;          // ISO alpha-2 ('UA')
  postcode: string | null;         // 5 digits
  oblast: string | null;           // 'київська', 'автономна республіка крим', 'київ'
  oblastCode: string | null;       // ISO 3166-2: 'UA-32'
  raion: string | null;            // 'шполянський' (first raion named; may be a city district)
  settlementType: SettlementType | null;
  settlement: string | null;       // current name: 'кропивницький'
  settlementRenamedFrom: string | null; // 'кіровоград' when the text has the old name
  streetType: StreetType | null;
  street: string | null;           // current name when a renaming applied
  streetRenamedFrom: string | null;
  building: string | null;         // '32а', '45/24', '102-104'
  corpus: string | null;
  liter: string | null;
  premisesType: PremisesType | null;
  premises: string | null;
  /** components that were not recognised */
  unparsed: string[];
  status: ParseStatus;
}

export interface AddressKeys {
  settlementKey: string | null;
  streetKey: string | null;
  addressKey: string | null;
  premisesKey: string | null;
}

export type NormalisedAddress = AddressParts & AddressKeys;

export interface StreetRef { type: StreetType; name: string }

/** Old -> current street names; see street-renamings.ts. */
export interface StreetRenamingLookup {
  lookup(settlementKey: string | null, type: StreetType, core: string): StreetRef | null;
}

export interface NormAddressOptions {
  streetRenamings?: StreetRenamingLookup | null;
}

// ---------------------------------------------------------------- text preparation

const APOS = /['’ʼ`´‘]/g;
const LAT2CYR: Record<string, string> = {
  a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', i: 'і', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у',
};
const HAS_CYR = /[а-яіїєґё]/;

/** Lower case, apostrophes dropped, quotes to spaces, Latin look-alikes inside Cyrillic words. */
export function prepText(s: string): string {
  let t = s.normalize('NFC')
    .replace(/(\p{L})["“”]\s?(?=[яюєїЯЮЄЇ])/gu, '$1') // СЛОВ"ЯНСЬКИЙ: a quote for the apostrophe
    .replace(APOS, '')
    .replace(/["«»“”„]/g, ' ')
    .toLowerCase()
    .replace(/ё/g, 'е');
  t = t.replace(/[0-9a-zа-яіїєґ]+/g, (w) =>
    HAS_CYR.test(w) || /^\d+[a-z]$/.test(w) ? w.replace(/[a-z]/g, (c) => LAT2CYR[c] ?? c) : w);
  return t.replace(/\s+/g, ' ').trim();
}

/** Spelling fold of one word for keys: і/и/ї/ы, е/є/э, ґ/г, soft signs, doubled letters. */
export function foldWord(w: string): string {
  return w
    .replace(/ая$/, 'а').replace(/яя$/, 'я').replace(/ый$/, 'ий')
    .replace(/[іїы]/g, 'и').replace(/[єэ]/g, 'е').replace(/ґ/g, 'г').replace(/[ьъ]/g, '')
    .replace(/(.)\1+/g, '$1');
}

const foldPhrase = (s: string) => s.split(/[\s-]+/).filter(Boolean).map(foldWord).join(' ');

// ---------------------------------------------------------------- dictionaries

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

function prefixRe(alts: string[]): RegExp {
  const a = [...alts].sort((x, y) => y.length - x.length).map(esc).join('|');
  return new RegExp(`^(${a})(?:\\.\\s*|\\s+)(.+)$`);
}
function suffixRe(alts: string[]): RegExp {
  const a = [...alts].sort((x, y) => y.length - x.length).map(esc).join('|');
  return new RegExp(`^(.+?)\\s+(${a})\\.?$`);
}

const SETTLEMENT_WORDS: Record<string, SettlementType> = {
  'місто': 'місто', 'м': 'місто', 'город': 'місто', 'г': 'місто', 'міста': 'місто',
  'селище міського типу': 'смт', 'смт': 'смт', 'пгт': 'смт', 'поселок городского типа': 'смт',
  'селище': 'селище', 'с-ще': 'селище', 'сел': 'селище', 'поселок': 'селище', 'пос': 'селище', 'п': 'селище',
  'село': 'село', 'с': 'село',
  'хутір': 'хутір', 'хутор': 'хутір', 'х': 'хутір',
};
const SETTLEMENT_PREFIX = prefixRe(Object.keys(SETTLEMENT_WORDS));

const STREET_WORDS: Record<string, StreetType> = {
  'вулиця': 'вулиця', 'вул': 'вулиця', 'улица': 'вулиця', 'ул': 'вулиця', 'вулиці': 'вулиця', 'вулица': 'вулиця',
  'провулок': 'провулок', 'пров': 'провулок', 'пер': 'провулок', 'переулок': 'провулок', 'пров-к': 'провулок',
  'проспект': 'проспект', 'просп': 'проспект', 'пр-т': 'проспект', 'пр-кт': 'проспект', 'пр': 'проспект',
  'бульвар': 'бульвар', 'бул': 'бульвар', 'б-р': 'бульвар', 'бульв': 'бульвар', 'б': 'бульвар', // 'б.' + a number is the building, read first
  'площа': 'площа', 'пл': 'площа', 'площадь': 'площа',
  'майдан': 'майдан',
  'узвіз': 'узвіз', 'спуск': 'спуск',
  'набережна': 'набережна', 'наб': 'набережна', 'набережная': 'набережна',
  'шосе': 'шосе', 'шоссе': 'шосе',
  'проїзд': 'проїзд', 'проезд': 'проїзд', 'пр-д': 'проїзд',
  'тупик': 'тупик', 'туп': 'тупик',
  'алея': 'алея', 'аллея': 'алея',
  'дорога': 'дорога',
  'лінія': 'лінія', 'линия': 'лінія',
  'вїзд': 'вїзд', 'въезд': 'вїзд',
  'мікрорайон': 'мікрорайон', 'мкр': 'мікрорайон', 'мкрн': 'мікрорайон', 'мікр': 'мікрорайон', 'м-н': 'мікрорайон',
  'микрорайон': 'мікрорайон',
  'квартал': 'квартал', 'кв-л': 'квартал', 'кв': 'квартал',
  'житловий масив': 'масив', 'масив': 'масив', 'ж/м': 'масив', 'жм': 'масив', 'жилмассив': 'масив',
  'урочище': 'урочище',
  'територія': 'територія', 'тер': 'територія',
};
const STREET_PREFIX = prefixRe(Object.keys(STREET_WORDS));
// postfix types ('ЖОВТНЕВА ВУЛ.', 'Московський проспект'): only unambiguous words
const STREET_SUFFIX = suffixRe([
  'вулиця', 'вул', 'улица', 'ул', 'провулок', 'пров', 'переулок', 'пер', 'проспект', 'просп', 'пр-т',
  'бульвар', 'бул', 'б-р', 'площа', 'пл', 'майдан', 'узвіз', 'спуск', 'набережна', 'шосе', 'проїзд',
  'тупик', 'алея', 'дорога', 'лінія', 'масив', 'житловий масив', 'мікрорайон', 'квартал',
]);

export const STREET_SHORT: Record<StreetType, string> = {
  'вулиця': 'вул', 'провулок': 'пров', 'проспект': 'просп', 'бульвар': 'бул', 'площа': 'пл',
  'майдан': 'майд', 'узвіз': 'узв', 'спуск': 'сп', 'набережна': 'наб', 'шосе': 'ш', 'проїзд': 'пр-д',
  'тупик': 'туп', 'алея': 'ал', 'дорога': 'дор', 'лінія': 'лін', 'вїзд': 'вїзд', 'мікрорайон': 'мкр',
  'квартал': 'кв-л', 'масив': 'мас', 'урочище': 'ур', 'територія': 'тер',
};

const PREMISES: Array<[RegExp, PremisesType]> = [
  [/^(?:квартира|кварт|кв)(?:\.\s*|\s+)?(?:№\s*)?(\d.*)$/, 'квартира'],
  [/^(?:офіс|офис|оф|office)(?:\.\s*|\s+)?(?:№\s*)?(.+)$/, 'офіс'],
  [/^(?:кімната|кімн|кім|комната|комн|кабінет|каб)(?:\.\s*|\s+)?(?:№\s*)?(.+)$/, 'кімната'],
  [/^(?:нежитлове приміщення|нежиле приміщення|приміщення|прим|пом|помещение)(?:\.\s*|\s+)?(?:№\s*)?(.+)$/, 'приміщення'],
];
const BUILDING_RE = /^(?:будинок|буд|б|дом|д)(?:\.\s*|\s+)?(?:№\s*)?(\d.*)$/;
const CORPUS_RE = /^(?:корпус|корп)(?:\.\s*|\s+)?(?:№\s*)?(.+)$/;
const LITER_RE = /^(?:літера|літ|литера|лит)(?:\.\s*|\s+)?(.+)$/;
const BARE_NUMBER = /^№?\s*\d+\s*(?:[-\s]?[а-яіїєґ](?![а-яіїєґ]))?(?:\s*[/-]\s*\d+\s*[а-яіїєґ]?)*$/;
// a component break before an inner marker: 'ВУЛ. ШЕВЧЕНКА 5 КВ. 3'
const INNER_SPLIT = /\s+(?=(?:будинок|буд\.|б\.|квартира|кв\.|офіс|оф\.|корпус|корп\.|кімната|кімн\.|приміщення|прим\.)\s*\d)/;

// oblast adjective (after foldPhrase) -> ISO 3166-2
const OBLAST_LIST: Array<[string, string, string[]]> = [
  ['вінницька', 'UA-05', ['винницкая']], ['волинська', 'UA-07', ['волынская']],
  ['луганська', 'UA-09', []], ['дніпропетровська', 'UA-12', ['днепропетровская']],
  ['донецька', 'UA-14', []], ['житомирська', 'UA-18', []], ['закарпатська', 'UA-21', []],
  ['запорізька', 'UA-23', ['запорожская']], ['івано-франківська', 'UA-26', ['ивано-франковская']],
  ['київська', 'UA-32', ['киевская']], ['кіровоградська', 'UA-35', ['кировоградская']],
  ['львівська', 'UA-46', ['львовская']], ['миколаївська', 'UA-48', ['николаевская']],
  ['одеська', 'UA-51', ['одесская']], ['полтавська', 'UA-53', []], ['рівненська', 'UA-56', ['ровенская']],
  ['сумська', 'UA-59', []], ['тернопільська', 'UA-61', ['тернопольская']],
  ['харківська', 'UA-63', ['харьковская']], ['херсонська', 'UA-65', []],
  ['хмельницька', 'UA-68', []], ['черкаська', 'UA-71', []], ['чернігівська', 'UA-74', ['черниговская']],
  ['чернівецька', 'UA-77', ['черновицкая']],
];
const OBLAST_BY_FOLD = new Map<string, [string, string]>();
for (const [name, code, alts] of OBLAST_LIST) {
  for (const n of [name, ...alts]) OBLAST_BY_FOLD.set(foldPhrase(prepText(n)), [name, code]);
}
const CRIMEA = /^(?:автономна республіка крим|автономная республика крым|ар крим|арк|республіка крим|крим)$/;
const CITY_REGION: Record<string, [string, string]> = { 'київ': ['київ', 'UA-30'], 'севастополь': ['севастополь', 'UA-40'] };

// first two digits of the postcode -> oblast (Укрпошта ranges)
const POSTCODE_OBLAST: Array<[number, number, string]> = [
  [1, 6, 'UA-30'], [7, 9, 'UA-32'], [10, 13, 'UA-18'], [14, 17, 'UA-74'], [18, 20, 'UA-71'],
  [21, 24, 'UA-05'], [25, 28, 'UA-35'], [29, 32, 'UA-68'], [33, 35, 'UA-56'], [36, 39, 'UA-53'],
  [40, 42, 'UA-59'], [43, 45, 'UA-07'], [46, 48, 'UA-61'], [49, 53, 'UA-12'], [54, 57, 'UA-48'],
  [58, 60, 'UA-77'], [61, 64, 'UA-63'], [65, 68, 'UA-51'], [69, 72, 'UA-23'], [73, 75, 'UA-65'],
  [76, 78, 'UA-26'], [79, 82, 'UA-46'], [83, 87, 'UA-14'], [88, 90, 'UA-21'], [91, 94, 'UA-09'],
  [95, 98, 'UA-43'], [99, 99, 'UA-40'],
];
export function oblastFromPostcode(pc: string | null | undefined): string | null {
  if (!pc || !/^\d{5}$/.test(pc)) return null;
  const p = Number(pc.slice(0, 2));
  for (const [a, b, code] of POSTCODE_OBLAST) if (p >= a && p <= b) return code;
  return null;
}

// renamed settlements (2016 decommunisation and later), oblast-qualified: old -> current
const SETTLEMENT_RENAMES: Array<[string, string, string]> = [
  ['UA-12', 'дніпропетровськ', 'дніпро'], ['UA-12', 'дніпродзержинськ', 'камянське'],
  ['UA-12', 'орджонікідзе', 'покров'],
  ['UA-35', 'кіровоград', 'кропивницький'],
  ['UA-14', 'артемівськ', 'бахмут'], ['UA-14', 'красноармійськ', 'покровськ'],
  ['UA-14', 'дзержинськ', 'торецьк'], ['UA-14', 'димитров', 'мирноград'], ['UA-14', 'красний лиман', 'лиман'],
  ['UA-09', 'стаханов', 'кадіївка'], ['UA-09', 'свердловськ', 'довжанськ'], ['UA-09', 'кіровськ', 'голубівка'],
  ['UA-09', 'краснодон', 'сорокине'], ['UA-09', 'красний луч', 'хрустальний'],
  ['UA-53', 'комсомольськ', 'горішні плавні'],
  ['UA-51', 'іллічівськ', 'чорноморськ'], ['UA-51', 'котовськ', 'подільськ'], ['UA-51', 'южне', 'південне'],
  ['UA-65', 'цюрупинськ', 'олешки'],
  ['UA-74', 'щорс', 'сновськ'],
  ['UA-56', 'кузнецовськ', 'вараш'],
  ['UA-18', 'новоград-волинський', 'звягель'],
  ['UA-32', 'переяслав-хмельницький', 'переяслав'],
  ['UA-46', 'червоноград', 'шептицький'],
];
const SETTLEMENT_RENAME = new Map<string, string>(
  SETTLEMENT_RENAMES.map(([ob, old, cur]) => [`${ob}|${foldPhrase(old)}`, cur]),
);

// words dropped from a street name in its key: titles and given names (genitive)
const STREET_STOP = new Set([
  'імені', 'ім', 'академіка', 'генерала', 'маршала', 'адмірала', 'гетьмана', 'професора', 'князя',
  'княгині', 'святого', 'святої', 'полковника', 'отамана', 'лейтенанта', 'капітана', 'майора',
  'художника', 'композитора', 'письменника', 'поета', 'льотчика', 'космонавта', 'митрополита',
  'патріарха', 'кардинала', 'сотника', 'архітектора',
  'івана', 'петра', 'павла', 'миколи', 'тараса', 'василя', 'михайла', 'богдана', 'ярослава',
  'володимира', 'олександра', 'андрія', 'степана', 'юрія', 'григорія', 'дмитра', 'сергія', 'олега',
  'лесі', 'марії', 'ольги', 'олени', 'анни', 'романа', 'віктора', 'якова', 'остапа', 'левка',
  'пантелеймона', 'федора', 'антона', 'олекси', 'кирила', 'мефодія', 'костянтина', 'вячеслава',
  'леоніда', 'євгена', 'бориса', 'ігоря', 'гната', 'олексія', 'данила', 'максима', 'семена',
  'панаса', 'марка', 'миколая', 'ігната', 'оксани', 'катерини', 'софії', 'людмили', 'ліни',
  'ивана', 'николая', 'андрея', 'александра', 'владимира', 'михаила', 'сергея', 'алексея',
].map((w) => foldWord(prepText(w))));

// ---------------------------------------------------------------- street name helpers

function cleanName(s: string): string {
  return s.replace(/\.(?=[^\s.])/g, '. ').replace(/\s*\/\s*/g, '/').replace(/[\s.]+$/, '')
    .replace(/^[\s.]+/, '').replace(/\s+/g, ' ').trim();
}

/** 'вул.Липинського В'ячеслава' -> {вулиця, 'липинського вячеслава'}; null without a type word. */
export function parseStreetName(s: string): StreetRef | null {
  const t = prepText(s).replace(/[,\s]+$/, '');
  // an ordinal before the type: '3-й провулок кривоноса' -> провулок '3-й кривоноса'
  const ord = t.match(/^(\d+(?:-?[а-яії]{1,3})?)\s+(.+)$/);
  if (ord && STREET_PREFIX.test(ord[2])) {
    const r = parseStreetName(ord[2]);
    if (r) return { type: r.type, name: `${ord[1]} ${r.name}` };
  }
  let m = t.match(STREET_PREFIX);
  if (m && /[0-9а-яіїєґ]/.test(m[2])) {
    const type = STREET_WORDS[m[1]];
    // 'кв' is a квартал only before a name, never before a flat number
    if (!(m[1] === 'кв' && /^\d/.test(m[2]))) return { type, name: cleanName(m[2]) };
  }
  m = t.match(STREET_SUFFIX);
  if (m) {
    const w = m[2].replace(/\.$/, '');
    const type = STREET_WORDS[w];
    if (type && /[а-яіїєґ]/.test(m[1])) return { type, name: cleanName(m[1]) };
  }
  return null;
}

/** Street name key: folded words without initials, titles and given names, in sorted order. */
export function streetCoreKey(name: string): string {
  const words = prepText(name).split(/[\s.\-–,]+/).filter(Boolean).map(foldWord);
  const noInit = words.filter((w) => w.length > 1 || /\d/.test(w));
  const core = noInit.filter((w) => !STREET_STOP.has(w));
  return (core.length ? core : noInit.length ? noInit : words).sort().join(' ');
}

export function normBuilding(v: string): string {
  return prepText(v)
    .replace(/№/g, '')
    .replace(/(\d)\s*[-\s]?\s*([а-яіїєґ])(?![а-яіїєґ])/g, '$1$2') // '4 а', '11-Б' -> 4а, 11б
    .replace(/\s*([/-])\s*/g, '$1')
    .replace(/[\s.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// '(п)' / '(з)' after a settlement name marks a renamed or merged place; the name is kept
function cleanSettlement(s: string): string {
  return cleanName(s.replace(/\s*\((?:п|з|с|ч)\)\s*$/, '')).replace(/\s*-\s*/g, '-');
}

// ---------------------------------------------------------------- main

function emptyParts(raw: string): AddressParts {
  return {
    raw, country: null, postcode: null, oblast: null, oblastCode: null, raion: null,
    settlementType: null, settlement: null, settlementRenamedFrom: null,
    streetType: null, street: null, streetRenamedFrom: null,
    building: null, corpus: null, liter: null, premisesType: null, premises: null,
    unparsed: [], status: 'failed',
  };
}

const IGNORE = /(?:територіальна громада|\bтг|\bотг|сільська рада|селищна рада|міська рада|сільрада|громада)$/;

export function parseAddressParts(raw: string | null | undefined): AddressParts {
  const p = emptyParts(raw ?? '');
  const text = prepText(raw ?? '');
  if (!text) return p;
  const comps = text.split(/\s*[,;]\s*/).flatMap((c) => c.split(INNER_SPLIT)).map((c) => c.trim())
    .filter((c) => c && !/^[.\-/]+$/.test(c));
  let lastWasStreet = false;
  let bareBuildingWord = false; // 'БУДИНОК,2': the word and the number in two components

  for (let i = 0; i < comps.length; i++) {
    const c = comps[i];
    const wasStreet = lastWasStreet;
    lastWasStreet = false;
    let m: RegExpMatchArray | null;

    if (i === 0 || !p.country) {
      if (/^(?:україна|украина|ukraine)$/.test(c)) { p.country = 'UA'; continue; }
    }
    if (/^\d{5}$/.test(c) && !p.postcode) { p.postcode = c; continue; }

    if ((m = c.match(/^(.+?)\s+(?:обл\.?|область|области)$/)) || (m = c.match(/^(?:область|обл\.)\s*(.+)$/))) {
      const hit = OBLAST_BY_FOLD.get(foldPhrase(m[1].replace(/\.$/, '')));
      if (hit) { if (!p.oblast) [p.oblast, p.oblastCode] = hit; continue; }
    }
    if (CRIMEA.test(c)) { if (!p.oblast) { p.oblast = 'автономна республіка крим'; p.oblastCode = 'UA-43'; } continue; }
    if ((m = c.match(/^(.+?)\s+(?:р-н|р-он|район|районі)\.?$/)) || (m = c.match(/^(?:р-н|район)\.?\s+(.+)$/))) {
      if (!p.raion) p.raion = cleanName(m[1]);
      continue;
    }
    if (IGNORE.test(c)) continue;

    if (/^(?:будинок|буд\.?)$/.test(c) && !p.building) { bareBuildingWord = true; continue; }
    if (bareBuildingWord && BARE_NUMBER.test(c)) { bareBuildingWord = false; p.building = normBuilding(c); continue; }
    // '42,Б': the building letter split off by a comma
    const prev = comps[i - 1] ?? '';
    if (/^[а-яіїєґ]$/.test(c) && p.building && /\d$/.test(p.building)
      && (BUILDING_RE.test(prev) || BARE_NUMBER.test(prev))) { p.building += c; continue; }
    if ((m = c.match(BUILDING_RE))) {
      if (!p.building) { p.building = normBuilding(m[1]); continue; }
    }
    if ((m = c.match(CORPUS_RE)) && !p.corpus) { p.corpus = normBuilding(m[1]); continue; }
    if ((m = c.match(LITER_RE)) && !p.liter) { p.liter = normBuilding(m[1]); continue; }
    let prem = false;
    for (const [re, type] of PREMISES) {
      if ((m = c.match(re)) && !p.premises) { p.premisesType = type; p.premises = normBuilding(m[1]); prem = true; break; }
    }
    if (prem) continue;

    if ((m = c.match(SETTLEMENT_PREFIX)) && /^[а-яіїєґ]/.test(m[2])) {
      const type = SETTLEMENT_WORDS[m[1]];
      const name = cleanSettlement(m[2]);
      if (!p.settlement) {
        p.settlementType = type; p.settlement = name;
      } else if (foldPhrase(name) !== foldPhrase(p.settlement)) {
        // 'місто Львів, місто Винники' / 'місто Дружківка, смт Олексієво-Дружківка': in the current
        // layout (settlement before street) the later, smaller place wins
        if (!p.street) {
          p.settlementType = type; p.settlement = name;
        } else {
          p.unparsed.push(c);
        }
      }
      continue;
    }

    const st = parseStreetName(c);
    if (st && !p.street) {
      // a trailing house number inside the street component: 'вул. шевченка 5'
      const tail = st.name.match(/^(.*[а-яіїєґ].*?)\s+(\d+(?:\s*[-]?\s*[а-яіїєґ](?![а-яіїєґ]))?(?:\s*[/-]\s*\d+[а-яіїєґ]?)?)$/);
      if (tail && !p.building && !/^\d/.test(st.name)) { st.name = tail[1]; p.building = normBuilding(tail[2]); }
      p.streetType = st.type; p.street = st.name;
      lastWasStreet = true;
      continue;
    }

    if (BARE_NUMBER.test(c)) {
      if (!p.building && (wasStreet || p.street)) { p.building = normBuilding(c); continue; }
      // old layout: 'ВУЛ. Х, 32, 41' — a second bare number right after the building is the flat
      if (p.building && !p.premises && comps[i - 1] && BARE_NUMBER.test(comps[i - 1])) {
        p.premisesType = 'квартира'; p.premises = normBuilding(c); continue;
      }
    }

    if (i === 0 && !p.country) {
      const iso = countryIso(c); // a foreign founder's address: 'Кіпр, Нікосія, ...'
      if (iso) { p.country = iso; continue; }
    }
    p.unparsed.push(c);
  }

  // Kyiv / Sevastopol are oblast-level cities
  if (p.settlement && p.settlementType === 'місто') {
    const cr = CITY_REGION[p.settlement];
    if (cr && !p.oblast) [p.oblast, p.oblastCode] = cr;
    if (cr && p.oblastCode !== cr[1]) p.oblastCode = cr[1];
  }
  if (!p.oblastCode) p.oblastCode = oblastFromPostcode(p.postcode);
  if (!p.country && (p.oblastCode || p.postcode)) p.country = 'UA';

  if (p.settlement && p.oblastCode) {
    const cur = SETTLEMENT_RENAME.get(`${p.oblastCode}|${foldPhrase(p.settlement)}`);
    if (cur) { p.settlementRenamedFrom = p.settlement; p.settlement = cur; }
  }

  p.status = !p.settlement ? 'failed'
    : p.street && p.building && p.unparsed.length === 0 ? 'full' : 'partial';
  return p;
}

export function settlementKeyOf(p: Pick<AddressParts, 'oblastCode' | 'settlementType' | 'settlement' | 'postcode'>): string | null {
  if (!p.settlement) return null;
  const city = p.settlementType === 'місто';
  const base = `${p.oblastCode ?? 'UA-?'}|${city ? 'м' : 'н'}|${foldPhrase(p.settlement)}`;
  return city ? base : `${base}|${p.postcode ?? ''}`;
}

export function normAddress(raw: string | null | undefined, opts: NormAddressOptions = {}): NormalisedAddress {
  const p = parseAddressParts(raw);
  const settlementKey = settlementKeyOf(p);
  let streetKey: string | null = null;
  if (settlementKey && p.street && p.streetType) {
    let core = streetCoreKey(p.street);
    const ren = opts.streetRenamings?.lookup(settlementKey, p.streetType, core) ?? null;
    if (ren) {
      p.streetRenamedFrom = `${p.streetType} ${p.street}`;
      p.streetType = ren.type; p.street = ren.name;
      core = streetCoreKey(ren.name);
    }
    streetKey = `${settlementKey}|${STREET_SHORT[p.streetType]}|${core}`;
  }
  let addressKey: string | null = null;
  if (settlementKey && p.building) {
    addressKey = `${streetKey ?? `${settlementKey}|-|`}|${p.building}`
      + (p.corpus ? `|к${p.corpus}` : '') + (p.liter ? `|л${p.liter}` : '');
  }
  const PREM_SHORT: Record<PremisesType, string> = { 'квартира': 'кв', 'офіс': 'оф', 'кімната': 'кім', 'приміщення': 'прим' };
  const premisesKey = addressKey && p.premises && p.premisesType
    ? `${addressKey}|${PREM_SHORT[p.premisesType]}${p.premises}` : null;
  return { ...p, settlementKey, streetKey, addressKey, premisesKey };
}

/** Readable canonical form: 'Київська обл., м. Біла Церква, вул. Східна, буд. 32а, кв. 41'. */
export function formatAddress(p: AddressParts): string {
  const cap = (s: string) => s.replace(/(^|[\s-])([а-яіїєґ])/g, (_, a, b) => a + b.toUpperCase());
  const SETT_SHORT: Record<SettlementType, string> = { 'місто': 'м.', 'смт': 'смт', 'селище': 'с-ще', 'село': 'с.', 'хутір': 'х.' };
  const out: string[] = [];
  if (p.postcode) out.push(p.postcode);
  if (p.oblast && !(p.oblastCode === 'UA-30' || p.oblastCode === 'UA-40')) {
    out.push(p.oblastCode === 'UA-43' ? 'АР Крим' : `${cap(p.oblast)} обл.`);
  }
  if (p.settlement && p.settlementType) out.push(`${SETT_SHORT[p.settlementType]} ${cap(p.settlement)}`);
  if (p.street && p.streetType) out.push(`${STREET_SHORT[p.streetType]}. ${cap(p.street)}`);
  if (p.building) out.push(`буд. ${p.building}` + (p.corpus ? `, корп. ${p.corpus}` : '') + (p.liter ? `, літ. ${p.liter}` : ''));
  if (p.premises && p.premisesType) out.push(`${p.premisesType === 'квартира' ? 'кв.' : p.premisesType === 'офіс' ? 'оф.' : p.premisesType === 'кімната' ? 'кімн.' : 'прим.'} ${p.premises}`);
  return out.join(', ');
}
