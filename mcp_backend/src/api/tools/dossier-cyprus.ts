/**
 * Cyprus section of get_company_dossier (LEXAI-2310): for every founder that ЄДР lists with
 * residence Cyprus («резиденство: Кіпр»), the card of that company in the Cyprus DRCOR
 * register, through search_cyprus_companies.
 *
 * Match order, the basis named on every item:
 *   1. registration_number — an HE/AE number written in the founder line («НЕ 287592»);
 *   2. exact_name — a Latin spelling in the line («ТОЛДЕКС ЛІМІТЕД (TOLDEX LIMITED)») equal to
 *      the register name up to case, punctuation and LTD/LIMITED, and unique;
 *   3. transliteration — the Cyrillic spelling against register names with the same
 *      consonant skeleton, accepted only when one candidate spells clearly closest. A hint
 *      to verify, never an identification: ЄДР carries no Cypriot number for most founders.
 */
import { findCyRegistrationCode, founderNames, cyNameKey, pickTransliterated } from './cyprus-names.js';
import { CY_SOURCE_NAME } from './cyprus-companies-tool.js';

export interface CySubCall { status: 'ok' | 'timeout' | 'error' | 'unavailable'; data: any; error?: string }
type Call = (name: string, args: any) => Promise<CySubCall>;

const TOOL = 'search_cyprus_companies';
const MAX_FOUNDERS = 10;
const OFFICIALS_PER_COMPANY = 10;
/** Founders with a Latin spelling are compared letter for letter, so the bar is higher. */
const LATIN_TRANSLIT_MIN = 0.8;

const CAVEATS: Record<string, string> = {
  registration_number: 'Зіставлено за реєстраційним номером, зазначеним у записі ЄДР.',
  exact_name: 'Зіставлено за латинською назвою із запису ЄДР (точний збіг без урахування регістру, розділових знаків і LTD/LIMITED); номера в ЄДР немає.',
  transliteration: 'Зіставлено за транслітерацією кириличної назви з ЄДР: номера й латинської назви в записі немає. Перевірте збіг за адресою та посадовими особами.',
};

/** Founder lines of a legal entity resident in Cyprus (natural persons carry «громадянство»). */
export function cyprusFounderLines(details: any): string[] {
  const rows = Array.isArray(details?.founders) ? details.founders : [];
  return rows
    .map((r: any) => (typeof r === 'string' ? r : r?.founder_info))
    .filter((t: unknown): t is string => typeof t === 'string'
      && /резиден[\p{L}]*ство\s*:\s*[^;]*Кіпр/iu.test(t)
      && !/громадянство\s*:/iu.test(t));
}

const rowsOf = (c: CySubCall): any[] => (c.status === 'ok' && Array.isArray(c.data?.results) ? c.data.results : []);

/** Company card as the dossier shows it: officials capped, provenance kept. */
function card(r: any): any {
  return {
    registration_code: r.registration_code ?? r.registration_no,
    name: r.name,
    org_type: r.org_type,
    status: r.status,
    status_original: r.status_original,
    dissolved: r.dissolved,
    status_date: r.status_date,
    registration_date: r.registration_date,
    registered_office: r.registered_office,
    officials: (r.officials ?? []).slice(0, OFFICIALS_PER_COMPANY).map((o: any) => ({ name: o.name, positions: o.positions })),
    officials_total: r.officials_total,
    source: r.source,
  };
}

export interface FounderMatch {
  founder: string;
  match_basis: 'registration_number' | 'exact_name' | 'transliteration' | null;
  match_score?: number;
  caveat?: string;
  company?: any;
  candidates?: Array<{ registration_code: string; name: string }>;
  lookup_status?: CySubCall['status'];
  message?: string;
}

/** Look one founder line up in DRCOR. */
export async function matchFounder(line: string, call: Call): Promise<FounderMatch> {
  const names = founderNames(line);
  const founder = names?.name ?? line.split(';')[0].trim();
  const failed = (c: CySubCall): FounderMatch => ({ founder, match_basis: null, lookup_status: c.status, message: 'Реєстр Кіпру не відповів: результат невідомий.' });

  const code = findCyRegistrationCode(line);
  if (code) {
    const c = await call(TOOL, { registration_number: code, limit: 1 });
    if (c.status !== 'ok') return failed(c);
    const r = rowsOf(c)[0];
    if (r) return { founder, match_basis: 'registration_number', caveat: CAVEATS.registration_number, company: card(r) };
  }
  for (const latin of names?.latin ?? []) {
    const c = await call(TOOL, { query: latin, name_match: 'exact', limit: 5 });
    if (c.status !== 'ok') return failed(c);
    const hits = rowsOf(c).filter((r) => cyNameKey(r.name) === cyNameKey(latin));
    if (hits.length === 1) return { founder, match_basis: 'exact_name', caveat: CAVEATS.exact_name, company: card(hits[0]) };
    if (hits.length > 1) {
      return { founder, match_basis: null, message: `Латинську назву мають ${hits.length} організації реєстру Кіпру; без номера HE обрати одну неможливо.`,
        candidates: hits.slice(0, 5).map((r) => ({ registration_code: r.registration_code, name: r.name })) };
    }
  }
  const spellings = [
    ...(names?.cyrillic ? [{ text: names.cyrillic, min: 0 }] : []),
    ...(names?.latin ?? []).map((t) => ({ text: t, min: LATIN_TRANSLIT_MIN })),
  ];
  let candidates: any[] = [];
  for (const s of spellings) {
    const c = await call(TOOL, { query: s.text, name_match: 'transliteration', limit: 25 });
    if (c.status !== 'ok') return failed(c);
    const rows = rowsOf(c);
    if (!rows.length) continue;
    candidates = rows;
    const pick = pickTransliterated(s.text, rows);
    if (pick && pick.score >= s.min) {
      return { founder, match_basis: 'transliteration', match_score: Number(pick.score.toFixed(2)), caveat: CAVEATS.transliteration, company: card(pick.company) };
    }
  }
  return {
    founder, match_basis: null,
    message: candidates.length
      ? 'Однозначного збігу в реєстрі Кіпру немає; найближчі за написанням назви наведено в candidates.'
      : 'У реєстрі Кіпру не знайдено організації з такою назвою.',
    ...(candidates.length ? { candidates: candidates.slice(0, 3).map((r) => ({ registration_code: r.registration_code, name: r.name })) } : {}),
  };
}

/**
 * The dossier section (same shape as its other sections). `details` is the
 * openreyestr_get_entity_details call; null when the company was not found.
 */
export async function cyprusFoundersSection(details: CySubCall | null, call: Call): Promise<any> {
  const title = 'Засновники з Кіпру: реєстр компаній Кіпру (DRCOR)';
  const source = { name: CY_SOURCE_NAME, tool: TOOL, as_of: null as string | null, as_of_basis: 'дата файлу data.gov.cy (snapshot_date)',
    note: 'Засновників-резидентів Кіпру взято з ЄДР; акціонерів і бенефіціарів кіпрської компанії реєстр Кіпру не публікує.' };
  if (!details || details.status !== 'ok') {
    return { title, status: details ? details.status : 'unavailable', source, count: 0, more_available: false, items: [],
      message: 'Засновників з ЄДР не отримано: перевірку не виконано.' };
  }
  const lines = cyprusFounderLines(details.data);
  if (!lines.length) {
    return { title, status: 'empty', source, count: 0, more_available: false, items: [], message: 'Засновників-резидентів Кіпру в ЄДР немає.' };
  }
  const items = await Promise.all(lines.slice(0, MAX_FOUNDERS).map((l) => matchFounder(l, call)));
  const matched = items.filter((i) => i.company);
  const asOf = matched.map((i) => i.company.source?.snapshot_date).filter(Boolean).sort().pop() ?? null;
  const unknown = items.some((i) => i.lookup_status && i.lookup_status !== 'ok');
  return {
    title,
    status: matched.length ? 'found' : unknown ? 'error' : 'empty',
    source: { ...source, as_of: asOf },
    count: matched.length,
    founders_total: lines.length,
    more_available: lines.length > MAX_FOUNDERS,
    items,
    ...(matched.length ? {} : { message: unknown ? 'Реєстр Кіпру не відповів: результат невідомий.' : `Засновників з Кіпру в ЄДР: ${lines.length}; жодного не зіставлено з реєстром Кіпру.` }),
  };
}
