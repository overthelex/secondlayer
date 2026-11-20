/**
 * ICIJ Offshore Leaks section of get_company_dossier (LEXAI-2311).
 *
 * Checks the company and its founders and beneficiaries from ЄДР against ICIJ by exact
 * name_key, through search_offshore_leaks. A name match alone is weak evidence, so the
 * rules lean to precision:
 *   - foreign-company founders: the Latin name from the ЄДР text («KIENO HOLDINGS LTD»),
 *     exact key with legal-suffix variants (LTD/LIMITED…), at least one distinctive word
 *     beyond the legal form and generic words; corroborated when the ICIJ jurisdiction or
 *     country agrees with the residency stated in ЄДР;
 *   - natural persons (Cyrillic in ЄДР): transliterated (КМУ 2010 and the older y-forms,
 *     common given-name spellings), both name orders; a match counts only when the ICIJ
 *     node is linked to Ukraine (country UKR) or matches with the patronymic. Others are
 *     counted as suppressed, not listed;
 *   - the company itself: the transliterated core name, only with an ICIJ link to Ukraine.
 * Names shorter than two words or MIN_KEY_LEN characters are not checked.
 */
import { ICIJ_ATTRIBUTION, ICIJ_CAVEAT, ICIJ_SOURCE_NAME, icijNameKey } from './offshore-leaks-tools.js';

type Call = (name: string, args: any) => Promise<{ status: 'ok' | 'timeout' | 'error' | 'unavailable'; data: any; error?: string }>;

const MIN_KEY_LEN = 6;
const MAX_PEOPLE = 15;
const MAX_COMPANIES = 15;
const KEYS_PER_CALL = 50;
const MAX_ITEMS = 10;
const NODES_PER_NAME = 3;

export type Role = 'company' | 'founder' | 'beneficiary';
export interface Candidate {
  key: string;
  kind: 'company' | 'person';
  role: Role;
  /** The ЄДР text the key came from (name part only). */
  source_name: string;
  residency: string | null;
  /** True for a person key that includes the patronymic. */
  with_patronymic?: boolean;
  /** Person with one of the most frequent surnames: a two-word match is a namesake more often than not. */
  common_surname?: boolean;
}

// ─── Transliteration ─────────────────────────────────────────────────────

const KMU: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ё: 'e', ъ: '',
};
const KMU_INITIAL: Record<string, string> = { є: 'ye', ї: 'yi', й: 'y', ю: 'yu', я: 'ya' };
/** Older passport / Russian-style spelling: g for г, y-forms everywhere. */
const ALT: Record<string, string> = { ...KMU, г: 'g', є: 'ye', ї: 'yi', й: 'y', ю: 'yu', я: 'ya' };

export function translit(word: string, scheme: 'kmu' | 'alt' = 'kmu'): string {
  const w = word.toLowerCase().replace(/['’ʼ`"]/g, '');
  const table = scheme === 'kmu' ? KMU : ALT;
  let out = '';
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    if (scheme === 'kmu' && c === 'з' && w[i + 1] === 'г') { out += 'zgh'; i++; continue; }
    if (scheme === 'kmu' && (i === 0 || !/[а-яіїєґ]/.test(w[i - 1])) && KMU_INITIAL[c]) { out += KMU_INITIAL[c]; continue; }
    out += table[c] ?? c;
  }
  return out;
}

/** ICIJ spells Ukrainian given names many ways (Igor, Ihor; Sergii, Sergey). */
const GIVEN_NAME_SPELLINGS: Record<string, string[]> = {
  'ігор': ['ihor', 'igor'], 'сергій': ['serhii', 'sergii', 'serhiy', 'sergiy', 'sergey'],
  'олександр': ['oleksandr', 'alexander', 'aleksandr', 'alexandr'], 'дмитро': ['dmytro', 'dmitry', 'dmitriy'],
  'юрій': ['yurii', 'yuriy', 'yuri', 'iurii'], 'євген': ['yevhen', 'ievgen', 'evgeniy', 'evgeny', 'yevgen', 'yevgeniy'],
  'володимир': ['volodymyr', 'vladimir'], 'віктор': ['viktor', 'victor'], 'андрій': ['andrii', 'andriy', 'andrey'],
  'олег': ['oleh', 'oleg'], 'михайло': ['mykhailo', 'mikhail', 'mykhaylo'], 'микола': ['mykola', 'nikolai', 'nikolay'],
  'василь': ['vasyl', 'vasiliy', 'vasily'], 'петро': ['petro', 'petr', 'pyotr'], 'павло': ['pavlo', 'pavel'],
  'анатолій': ['anatolii', 'anatoliy'], 'валерій': ['valerii', 'valeriy'], 'олексій': ['oleksii', 'oleksiy', 'alexey', 'aleksey'],
  'вадим': ['vadym', 'vadim'], 'максим': ['maksym', 'maxim', 'maksim'], 'артем': ['artem', 'artyom'],
  'костянтин': ['kostiantyn', 'kostyantyn', 'konstantin'], 'григорій': ['hryhorii', 'grigoriy', 'grigory'],
  'геннадій': ['hennadii', 'gennadiy', 'gennady'], 'вячеслав': ['viacheslav', 'vyacheslav'],
  'тетяна': ['tetiana', 'tetyana', 'tatiana', 'tatyana'], 'наталія': ['nataliia', 'natalia', 'natalya', 'nataliya'],
  'олена': ['olena', 'elena'], 'юлія': ['yuliia', 'yulia', 'yuliya'], 'ірина': ['iryna', 'irina'],
  'світлана': ['svitlana', 'svetlana'], 'ольга': ['olha', 'olga'], 'катерина': ['kateryna', 'ekaterina', 'katerina'],
  'марина': ['maryna', 'marina'], 'галина': ['halyna', 'galyna', 'galina'], 'людмила': ['liudmyla', 'lyudmila', 'ludmila'],
  'оксана': ['oksana'], 'вікторія': ['viktoriia', 'victoria', 'viktoriya'], 'анна': ['anna'], 'ганна': ['hanna', 'ganna', 'anna'],
};

const uniq = <T>(xs: T[]) => [...new Set(xs)];

function wordSpellings(word: string, given: boolean): string[] {
  const w = word.toLowerCase().replace(/['’ʼ`]/g, '');
  const base = [translit(w, 'kmu'), translit(w, 'alt')];
  if (given && GIVEN_NAME_SPELLINGS[w]) base.unshift(...GIVEN_NAME_SPELLINGS[w]);
  // -ий: Kolomoiskyi (КМУ) / Kolomoisky / Kolomoiskiy
  const extra = base.flatMap((s) => (/yi$/.test(s) ? [s.replace(/yi$/, 'y'), s.replace(/yi$/, 'iy')] : []));
  return uniq([...base, ...extra]).slice(0, 6);
}

/**
 * The most frequent Ukrainian (and Russian) surnames. On a prod sample of 2,000 random
 * companies, two-word matches of these (OLEKSANDR MOROZ, SERHIY BONDARENKO) made up most
 * of the person hits and were namesakes; rare surnames (AKHMETOV, IVAKHIV) were the people
 * the leaks are about.
 */
export const COMMON_SURNAMES = new Set(('мельник шевченко коваленко бондаренко бойко ткаченко кравченко ковальчук коваль ' +
  'олійник шевчук поліщук іваненко ткачук савченко марченко бондар руденко мороз лисенко петренко клименко павленко ' +
  'кравчук кузьменко пономаренко савчук василенко левченко харченко сидоренко карпенко гончаренко мельничук литвиненко ' +
  'романенко гончар тарасенко остапенко кириченко головко юрченко кушнір демченко яковенко захарченко панченко антоненко ' +
  'білик гаврилюк нестеренко приходько тимошенко кулик мартинюк козак дмитренко семенко онищенко костенко ярошенко ' +
  'давиденко степаненко науменко борисенко ковальов гуменюк лященко фещенко пилипенко зінченко мазур гриценко бабенко ' +
  'кравець вовк литвин кучер сергієнко дорошенко ющенко федоренко власенко мисник волошин симоненко сорока ' +
  'соколов кузнецов попов іванов петров смирнов волков морозов новиков козлов лебедєв павлов семенов васильєв федоров ' +
  'михайлов павлюк гордієнко гребенюк луценко макаренко рибак швець ковтун лук\'яненко лукяненко назаренко скриник ' +
  'олексієнко мирошниченко кравцов андрієнко гнатюк проценко денисенко коломієць тищенко білоус москаленко').split(/\s+/));

const PERSON_WORD = /^[А-ЯІЇЄҐЁЫЭЪа-яіїєґёыэъ'’ʼ-]{2,}$/;

/** "ПЕТРЕНКО ІВАН ІВАНОВИЧ" → keys in the orders ICIJ uses; null when it is not a person name. */
export function personKeys(fullName: string): Array<{ key: string; with_patronymic: boolean }> | null {
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4 || !words.every((w) => PERSON_WORD.test(w))) return null;
  const [surname, given, patronymic] = words;
  const s = wordSpellings(surname, false);
  const g = wordSpellings(given, true);
  const p = patronymic ? uniq([translit(patronymic, 'kmu'), translit(patronymic, 'alt')]) : [];
  const out: Array<{ key: string; with_patronymic: boolean }> = [];
  for (const gs of g) for (const ss of s) {
    out.push({ key: `${gs} ${ss}`, with_patronymic: false }, { key: `${ss} ${gs}`, with_patronymic: false });
    for (const ps of p) out.push({ key: `${gs} ${ps} ${ss}`, with_patronymic: true }, { key: `${ss} ${gs} ${ps}`, with_patronymic: true });
  }
  const seen = new Set<string>();
  return out.map((o) => ({ ...o, key: icijNameKey(o.key)! })).filter((o) => o.key && !seen.has(o.key) && seen.add(o.key));
}

// ─── Company names ───────────────────────────────────────────────────────

const GENERIC = new Set(['limited', 'ltd', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'holdings', 'holding',
  'group', 'international', 'intl', 'investments', 'investment', 'invest', 'trading', 'trade', 'sa', 's', 'a', 'gmbh', 'ag', 'llc',
  'llp', 'lp', 'plc', 'bv', 'b', 'v', 'nv', 'n', 'management', 'services', 'service', 'capital', 'enterprises', 'enterprise',
  'ventures', 'global', 'trust', 'fund', 'foundation', 'the', 'of', 'and', 'consulting', 'partners', 'development', 'finance',
  'financial', 'industries', 'industrial', 'commercial', 'systems', 'solutions', 'technologies', 'technology', 'world', 'universal',
  'general', 'business', 'assets', 'asset', 'property', 'properties', 'resources', 'energy', 'agro', 'ukraine', 'europe', 'kft',
  'sro', 'srl', 'spa', 'oy', 'ab', 'as', 'aps', 'sp', 'z', 'o', 'oo', 'at', 'tov', 'pp', 'dp', 'ltd.', 'company.', 'est', 'fzc', 'fze', 'dmcc']);

/** LTD ↔ LIMITED and the like, applied to the last word. */
const SUFFIX_SWAPS: Array<[RegExp, string]> = [
  [/ ltd$/, ' limited'], [/ limited$/, ' ltd'], [/ inc$/, ' incorporated'], [/ incorporated$/, ' inc'],
  [/ corp$/, ' corporation'], [/ corporation$/, ' corp'], [/ sa$/, ' s a'], [/ s a$/, ' sa'], [/ co ltd$/, ' company limited'],
];

export function companyKeyVariants(latinName: string): string[] {
  const k = icijNameKey(latinName.replace(/^\s*(company|the)\s+/i, ''));
  if (!k) return [];
  const out = [k];
  for (const [re, to] of SUFFIX_SWAPS) if (re.test(k)) out.push(k.replace(re, to));
  return uniq(out);
}

/** A company key worth checking: two words, one of them distinctive, long enough. */
export function isDistinctiveCompanyKey(key: string): boolean {
  const words = key.split(' ');
  if (words.length < 2 || key.length < MIN_KEY_LEN) return false;
  return words.some((w) => w.length >= 3 && !GENERIC.has(w) && !/^\d+$/.test(w));
}

/** Latin company name inside a ЄДР founder text, e.g. КОМПАНІЯ "КІЕНО ХОЛДІНГС ЛТД" ("KIENO HOLDINGS LTD"). */
export function latinCompanyName(namePart: string): string | null {
  const runs = namePart.match(/[A-Za-z0-9][A-Za-z0-9 .,&'’\-]*[A-Za-z0-9.]/g) ?? [];
  const best = runs.map((r) => r.trim()).filter((r) => (r.match(/[A-Za-z]{2,}/g) ?? []).length >= 2)
    .sort((a, b) => b.length - a.length)[0];
  return best ?? null;
}

const RESIDENCY = /резиде[нт]*ство:\s*([^;]+)/i;
const CITIZENSHIP = /громадянство:\s*([^;]+)/i;

export function splitInfo(info: string): { name: string; residency: string | null } {
  const name = info.split(';')[0].trim();
  const res = info.match(RESIDENCY)?.[1] ?? info.match(CITIZENSHIP)?.[1] ?? null;
  return { name, residency: res ? res.trim() : null };
}

/** Ukrainian residency in ЄДР → ICIJ country codes and jurisdiction words. */
const RESIDENCY_MAP: Array<[RegExp, string[], RegExp]> = [
  [/кіпр/i, ['CYP'], /cyprus/i],
  [/віргінськ/i, ['VGB'], /virgin/i],
  [/беліз/i, ['BLZ'], /belize/i],
  [/панам/i, ['PAN'], /panama/i],
  [/сейшел/i, ['SYC'], /seychelles/i],
  [/багам/i, ['BHS'], /bahamas/i],
  [/маршал/i, ['MHL'], /marshall/i],
  [/кайман/i, ['CYM'], /cayman/i],
  [/мальт/i, ['MLT'], /malta/i],
  [/сполучене королівство|великобрит|англ/i, ['GBR'], /united kingdom|england|scotland|wales/i],
  [/гонконг/i, ['HKG'], /hong kong/i],
  [/сінгапур/i, ['SGP'], /singapore/i],
  [/швейцар/i, ['CHE'], /switzerland/i],
  [/ліхтенштейн/i, ['LIE'], /liechtenstein/i],
  [/люксембург/i, ['LUX'], /luxembourg/i],
  [/нідерланд/i, ['NLD'], /netherlands/i],
  [/естон/i, ['EST'], /estonia/i],
  [/латві/i, ['LVA'], /latvia/i],
  [/литв/i, ['LTU'], /lithuania/i],
  [/австрі/i, ['AUT'], /austria/i],
  [/німеччин/i, ['DEU'], /germany/i],
  [/сша|сполучені штати/i, ['USA'], /united states|delaware|nevada|wyoming/i],
  [/об.єднані арабські|оае/i, ['ARE'], /emirates/i],
  [/сент-кітс|невіс/i, ['KNA'], /nevis|kitts/i],
  [/самоа/i, ['WSM'], /samoa/i],
  [/ангіл/i, ['AIA'], /anguilla/i],
  [/маврикі/i, ['MUS'], /mauritius/i],
  [/джерсі/i, ['JEY'], /jersey/i],
  [/гернсі/i, ['GGY'], /guernsey/i],
  [/мен(у)?$|острів мен/i, ['IMN'], /isle of man/i],
  [/україна/i, ['UKR'], /ukraine/i],
  [/росі/i, ['RUS'], /russia/i],
];

export function residencyAgrees(residency: string | null, node: any): boolean {
  if (!residency) return false;
  const codes: string[] = Array.isArray(node.country_codes) ? node.country_codes : [];
  const juris = `${node.jurisdiction_description ?? ''} ${node.jurisdiction ?? ''}`;
  return RESIDENCY_MAP.some(([re, iso, words]) => re.test(residency) && (iso.some((c) => codes.includes(c)) || words.test(juris)));
}

/** ICIJ states the jurisdiction for most entities; officers and some Pandora entities have none. */
function jurisdictionKnown(node: any): boolean {
  const j = String(node.jurisdiction_description || node.jurisdiction || '').trim();
  return !!j && !/^(undetermined|xxx?|recorded in leaked files)/i.test(j);
}

/** "ТОВ «АГРО ЛІДЕР ГРУП»" → its core, transliterated: "ahro lider hrup". */
function companyCoreKeys(entity: any): string[] {
  const raw = String(entity?.name || entity?.short_name || '');
  const core = raw.match(/[«"“]([^»"”]+)[»"”]/)?.[1] ?? null;
  if (!core) return [];
  const latin = latinCompanyName(core);
  const words = core.trim().split(/\s+/);
  const keys = latin ? companyKeyVariants(latin)
    : uniq([words.map((w) => translit(w, 'kmu')).join(' '), words.map((w) => translit(w, 'alt')).join(' ')]).map((k) => icijNameKey(k)!).filter(Boolean);
  return keys.filter(isDistinctiveCompanyKey);
}

const NO_BENEFICIARY = /причина відсутності|відсутн|не подається/i;

export function candidatesFor(entity: any, founders: string[], beneficiaries: string[]): Candidate[] {
  const out: Candidate[] = [];
  const self = String(entity?.short_name || entity?.name || '');
  for (const key of companyCoreKeys(entity)) out.push({ key, kind: 'company', role: 'company', source_name: self, residency: 'Україна' });

  let companies = 0;
  let people = 0;
  const seenPeople = new Set<string>();
  const add = (info: string, role: Role) => {
    if (!info || NO_BENEFICIARY.test(info.split(';')[0])) return;
    const { name, residency } = splitInfo(info);
    const personName = name.split(',')[0].trim();
    const pk = personKeys(personName);
    if (pk) {
      const id = personName.toLowerCase();
      if (seenPeople.has(id) || people >= MAX_PEOPLE) return;
      seenPeople.add(id);
      people++;
      const common = COMMON_SURNAMES.has(personName.split(/\s+/)[0].toLowerCase().replace(/[’ʼ]/g, "'"));
      for (const k of pk) {
        out.push({ key: k.key, kind: 'person', role, source_name: personName, residency, with_patronymic: k.with_patronymic, common_surname: common });
      }
      return;
    }
    const latin = latinCompanyName(name);
    if (!latin || companies >= MAX_COMPANIES) return;
    const keys = companyKeyVariants(latin).filter(isDistinctiveCompanyKey);
    if (keys.length) companies++;
    for (const key of keys) out.push({ key, kind: 'company', role, source_name: name, residency });
  };
  founders.forEach((f) => add(f, 'founder'));
  beneficiaries.forEach((b) => add(b, 'beneficiary'));
  return out;
}

/** Whether an exact key match is reported, and on what basis. */
export function judge(c: Candidate, node: any): { report: boolean; corroborated: boolean; basis: string } {
  const ukr = Array.isArray(node.country_codes) && node.country_codes.includes('UKR');
  if (c.kind === 'person') {
    if (node.node_type !== 'officer') return { report: false, corroborated: false, basis: 'не особа' };
    if (c.with_patronymic) return { report: true, corroborated: ukr, basis: 'точний збіг прізвища, імені та по батькові (транслітерація)' + (ukr ? '; вузол ICIJ пов’язаний з Україною' : '') };
    if (!ukr) return { report: false, corroborated: false, basis: 'лише збіг імені без зв’язку з Україною' };
    if (c.common_surname) return { report: false, corroborated: false, basis: 'поширене прізвище: збіг імені й прізвища без по батькові не показується' };
    return { report: true, corroborated: true, basis: 'точний збіг прізвища та імені (транслітерація); вузол ICIJ пов’язаний з Україною' };
  }
  if (node.node_type === 'address') return { report: false, corroborated: false, basis: 'адреса' };
  if (c.role === 'company') {
    return ukr ? { report: true, corroborated: true, basis: 'точний збіг транслітерованої назви; вузол ICIJ пов’язаний з Україною' }
      : { report: false, corroborated: false, basis: 'лише збіг транслітерованої назви' };
  }
  if (residencyAgrees(c.residency, node)) {
    return { report: true, corroborated: true, basis: `точний збіг назви; юрисдикція чи країна ICIJ відповідає резидентству за ЄДР (${c.residency})` };
  }
  // A namesake registered elsewhere (ZENITH LTD of Belize vs ZENITH LIMITED of Malta) is not shown;
  // a node whose jurisdiction ICIJ does not state is shown as unconfirmed.
  const juris = jurisdictionKnown(node) ? (node.jurisdiction_description || node.jurisdiction) : null;
  if (juris && c.residency) {
    return { report: false, corroborated: false, basis: `інша юрисдикція (за ЄДР: ${c.residency}; ICIJ: ${juris})` };
  }
  return { report: true, corroborated: false,
    basis: `точний збіг назви; юрисдикцію не підтверджено (за ЄДР: ${c.residency ?? 'не вказано'}; ICIJ: ${juris ?? 'не вказано'})` };
}

function groupOf(c: Candidate): { id: string; args: Record<string, unknown> } {
  if (c.kind === 'person') {
    return c.with_patronymic ? { id: 'person_full', args: { node_type: 'officer' } }
      : { id: 'person_ukr', args: { node_type: 'officer', country: 'UKR' } };
  }
  return c.role === 'company' ? { id: 'self_ukr', args: { country: 'UKR' } } : { id: 'company', args: {} };
}

const ROLE_LABEL: Record<Role, string> = { company: 'сама компанія', founder: 'засновник', beneficiary: 'бенефіціар' };

/** The dossier section; `entity` is the ЄДР row, `details` the entity-details sub-call. */
export async function icijSection(call: Call, entity: any, details: { status: string; data: any } | null): Promise<any> {
  const title = 'ICIJ Offshore Leaks (офшорні витоки)';
  const d = details?.status === 'ok' && details.data && typeof details.data === 'object' ? details.data : {};
  const texts = (rows: any, field: string): string[] => (Array.isArray(rows) ? rows.map((r) => r?.[field]).filter((x) => typeof x === 'string') : []);
  const source = { name: ICIJ_SOURCE_NAME, tool: 'search_offshore_leaks', as_of: null as string | null,
    as_of_basis: 'дата формування архіву ICIJ', note: `${ICIJ_ATTRIBUTION} ${ICIJ_CAVEAT}` };
  const empty = (status: string, message: string) => ({ title, status, source, count: 0, more_available: false, items: [], message });
  if (!entity) return empty('unavailable', 'Дані ЄДР не отримано: перевірку ICIJ не виконано.');

  const cands = candidatesFor(entity, texts(d.founders, 'founder_info'), texts(d.beneficiaries, 'beneficiary_info'));
  if (!cands.length) return empty('empty', 'Немає назв, придатних для перевірки за ICIJ (засновники й бенефіціари не вказані або назви надто короткі чи загальні).');

  const byKey = new Map<string, Candidate[]>();
  for (const c of cands) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
  // Filters that judge() would apply anyway go into the query, so namesakes elsewhere
  // cannot fill the page: two-word person keys and the company's own name need UKR.
  const groups = new Map<string, { keys: Set<string>; args: Record<string, unknown> }>();
  for (const c of cands) {
    const g = groupOf(c);
    if (!groups.has(g.id)) groups.set(g.id, { keys: new Set(), args: g.args });
    groups.get(g.id)!.keys.add(c.key);
  }
  const requests: Array<Record<string, unknown>> = [];
  for (const { keys, args } of groups.values()) {
    const list = [...keys];
    for (let i = 0; i < list.length; i += KEYS_PER_CALL) requests.push({ ...args, names: list.slice(i, i + KEYS_PER_CALL) });
  }
  const calls = await Promise.all(requests.map((r) => call('search_offshore_leaks', { ...r, hops: 1, edges_per_node: 5, limit: 25 })));

  const failed = calls.find((c) => c.status !== 'ok' || c.data?.error);
  const nodes: any[] = calls.flatMap((c) => (c.status === 'ok' && Array.isArray(c.data?.results) ? c.data.results : []));
  source.as_of = calls.find((c) => c.data?.source?.as_of)?.data.source.as_of ?? null;
  if (failed && !nodes.length) {
    const status = failed.status === 'ok' ? 'error' : failed.status;
    return empty(status, 'Пошук в ICIJ не відповів: результат невідомий.');
  }

  const items: any[] = [];
  let suppressed = 0;
  let extraNodes = 0;
  const seenNodes = new Set<string>();
  const perName = new Map<string, number>();
  for (const n of nodes) {
    if (seenNodes.has(`${n.node_id}:${n.node_type}`)) continue;
    seenNodes.add(`${n.node_id}:${n.node_type}`);
    let hit: { c: Candidate; v: ReturnType<typeof judge> } | null = null;
    for (const c of byKey.get(n.name_key) ?? []) {
      const v = judge(c, n);
      if (v.report) { hit = { c, v }; break; }
    }
    if (!hit) { suppressed++; continue; }
    const { c, v } = hit;
    // ICIJ often holds one person as several nodes (one per leak or per company file).
    const seen = perName.get(c.source_name) ?? 0;
    perName.set(c.source_name, seen + 1);
    if (seen >= NODES_PER_NAME) { extraNodes++; continue; }
    items.push({
      checked: { role: c.role, role_label: ROLE_LABEL[c.role], name_in_edr: c.source_name, ...(c.residency ? { residency_in_edr: c.residency } : {}) },
      match_basis: v.basis, corroborated: v.corroborated,
      icij: { node_id: n.node_id, node_type: n.node_type, name: n.name, jurisdiction: n.jurisdiction_description ?? n.jurisdiction ?? null,
        country_codes: n.country_codes ?? null, source_leak: n.source_leak, incorporation_date: n.incorporation_date ?? null, url: n.url },
      relationships: Array.isArray(n.relationships?.items) ? n.relationships.items.slice(0, 5).map((e: any) => ({
        rel_type: e.rel_type, link: e.link ?? null, direction: e.direction, start_date: e.start_date ?? null, end_date: e.end_date ?? null,
        node: e.node?.name ?? e.node?.node_id, url: e.node?.url })) : [],
      relationships_total: n.relationships?.total ?? null,
    });
  }
  items.sort((a, b) => Number(b.corroborated) - Number(a.corroborated));
  const people = new Set(cands.filter((c) => c.kind === 'person').map((c) => c.source_name)).size;
  const companies = new Set(cands.filter((c) => c.kind === 'company').map((c) => c.source_name)).size;
  const checked = `Перевірено за точним збігом нормалізованої назви: ${companies} назв компаній і ${people} осіб.`;
  const sup = suppressed ? ` Не показано ${suppressed} збігів лише за назвою без підтвердження (інша юрисдикція, поширене прізвище без по батькові, немає зв’язку з Україною).` : '';
  return {
    title, status: items.length ? 'found' : 'empty', source, count: items.length,
    matched_names: perName.size,
    more_available: items.length > MAX_ITEMS || extraNodes > 0,
    ...(extraNodes ? { more_nodes_not_shown: extraNodes } : {}),
    items: items.slice(0, MAX_ITEMS),
    message: items.length
      ? `${checked}${sup} Збіг назви не доводить, що це та сама особа чи компанія.`
      : `${checked} Збігів не знайдено.${sup}${failed ? ' Частина запитів до ICIJ не відповіла.' : ''}`,
    caveat: ICIJ_CAVEAT,
    attribution: ICIJ_ATTRIBUTION,
  };
}
