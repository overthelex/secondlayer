/**
 * ARMA (Єдиний державний реєстр активів, на які накладено арешт) — source
 * record mapping and search-filter helpers (LEXAI-2161).
 *
 * Source: data.gov.ua edra_opendata.json, one item per (asset, ARMA action):
 *   id              ARMA asset id (13 digits; repeats once per action)
 *   description     asset description
 *   props           asset attributes, "Марка: X | Модель: Y"
 *   dectypename     court decision type ("накладення арешту на майно; ...")
 *   docnum          court case numbers, comma-separated ("757/2732/19-к, 1-кс/757/1/19")
 *   decisiondate    decision date, dd.mm.yyyy
 *   numerdr         ЄРДР criminal proceeding number (17 digits)
 *   props_1         "Найменування суду: ...; ПІБ судді: ...; Найменування органу досудового розс.: ..."
 *   name            ARMA action ("Оцінка", "Заходи з реалізації", ...), absent for most rows
 *   dateaction      action date
 *   props_2         action details ("Назва управителя/ПІБ управителя: ...")
 *   state           action state ("Передано для реалізації", "Реалізовано", ...)
 *   actionincomesum action income; sometimes a decimal comma (583526,51) that
 *                   makes the line invalid JSON — see repairArmaLine.
 *
 * The open dataset carries NO owner name / ЄДРПОУ: the publisher excludes the
 * data of art. 25 para 9 of the ARMA Law. owner_* columns therefore stay NULL.
 */

export interface ArmaSourceItem {
  id?: number | string;
  description?: string;
  props?: string;
  dectypename?: string;
  docnum?: string;
  decisiondate?: string;
  numerdr?: string | number;
  props_1?: string;
  name?: string;
  dateaction?: string;
  props_2?: string;
  state?: string;
  actionincomesum?: number | string;
}

export interface ArmaRow {
  asset_id: string | null;
  case_number: string | null;
  case_numbers: string[];
  criminal_proceeding_number: string | null;
  case_date: string | null;
  court_name: string | null;
  judge_name: string | null;
  investigation_body: string | null;
  region: string | null;
  decision_type: string | null;
  asset_type: string;
  asset_description: string | null;
  asset_props: string | null;
  action_name: string | null;
  action_date: string | null;
  action_details: string | null;
  action_income_sum: string | null;
  status: string | null;
  arrest_date: string | null;
  transfer_date: string | null;
  manager: string | null;
}

/** Make a source line parseable: "actionincomesum":583526,51 → 583526.51 */
export function repairArmaLine(line: string): string {
  return line.replace(/"actionincomesum":(-?\d+),(\d+)/g, '"actionincomesum":$1.$2');
}

export function parseArmaDate(s: unknown): string | null {
  if (!s || typeof s !== 'string') return null;
  const dmy = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return validYmd(Number(y), Number(m), Number(d)) ? `${y}-${m}-${d}` : null;
  }
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return validYmd(Number(ymd[1]), Number(ymd[2]), Number(ymd[3])) ? ymd[0] : null;
  return null;
}

/** Real calendar date in 1900..2100 (31.02 or 00.00 would make Postgres reject the whole batch). */
function validYmd(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Value of "Key: value" inside a ';'-separated props string. */
export function propValue(props: string | null | undefined, key: string): string | null {
  if (!props) return null;
  for (const part of props.split(';')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === key) {
      const v = part.slice(idx + 1).trim();
      return v || null;
    }
  }
  return null;
}

/** "757/2732/19-к, 1-кс/757/1/19" → ["757/2732/19-к", "1-кс/757/1/19"] */
export function splitCaseNumbers(docnum: string | null | undefined): string[] {
  if (!docnum) return [];
  const seen = new Set<string>();
  for (const raw of docnum.split(/[,;]/)) {
    const v = raw.trim().replace(/\s+/g, ' ');
    if (v) seen.add(v);
  }
  return [...seen];
}

const clean = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

// ---------------------------------------------------------------- regions

interface RegionDef { name: string; stems: string[] }

/** Canonical region + lowercase stems that start the region's word in court names. */
export const ARMA_REGIONS: RegionDef[] = [
  { name: 'Автономна Республіка Крим', stems: ['крим'] },
  { name: 'Вінницька область', stems: ['вінниц'] },
  { name: 'Волинська область', stems: ['волин', 'луцьк', 'ковел'] },
  { name: 'Дніпропетровська область', stems: ['дніпропетров', 'дніпр', 'кривого рогу', 'кривий ріг', 'кривор', 'дніпродзерж', "кам'янськ", 'кам’янськ', 'камʼянськ', 'павлоград', 'нікопол'] },
  { name: 'Донецька область', stems: ['донец', 'маріупол', 'краматорськ', "слов'янськ", 'слов’янськ'] },
  { name: 'Житомирська область', stems: ['житомир'] },
  { name: 'Закарпатська область', stems: ['закарпат', 'ужгород'] },
  { name: 'Запорізька область', stems: ['запоріз', 'запоріж', 'мелітопол'] },
  { name: 'Івано-Франківська область', stems: ['івано-франків'] },
  { name: 'Київська область', stems: ['київськ'] },
  { name: 'Кіровоградська область', stems: ['кіровоград', 'кропивниц'] },
  { name: 'Луганська область', stems: ['луган', 'сєвєродонец', 'северодонец'] },
  { name: 'Львівська область', stems: ['львів', 'львов'] },
  { name: 'Миколаївська область', stems: ['микола'] },
  { name: 'Одеська область', stems: ['одес'] },
  { name: 'Полтавська область', stems: ['полтав', 'кременчу'] },
  { name: 'Рівненська область', stems: ['рівн'] },
  { name: 'Сумська область', stems: ['сум'] },
  { name: 'Тернопільська область', stems: ['тернопіл', 'тернопол'] },
  { name: 'Харківська область', stems: ['харків', 'харков'] },
  { name: 'Херсонська область', stems: ['херсон'] },
  { name: 'Хмельницька область', stems: ['хмельниц'] },
  { name: 'Черкаська область', stems: ['черкас', 'черкаськ'] },
  { name: 'Чернівецька область', stems: ['чернівец', 'чернівц'] },
  { name: 'Чернігівська область', stems: ['черніг'] },
  { name: 'м. Київ', stems: ['києв', 'київ'] },
  { name: 'м. Севастополь', stems: ['севастопол'] },
];

function regionByWord(word: string, opts: { kyivAdjectiveIsCity: boolean }): string | null {
  const w = word.toLowerCase().replace(/[«»"]/g, '').trim();
  if (!w) return null;
  // "Київськ*" is the oblast in "Київської області" but the city's court of
  // appeal in "Київський апеляційний суд".
  if (w.startsWith('київськ')) return opts.kyivAdjectiveIsCity ? 'м. Київ' : 'Київська область';
  for (const r of ARMA_REGIONS) {
    if (r.stems.some((s) => w.startsWith(s))) return r.name;
  }
  return null;
}

/**
 * Derive the region from a court name. The dataset has no region field; the
 * court's seat is the best available proxy (ВАКС and other national courts → null).
 */
export function regionFromCourt(court: string | null | undefined): string | null {
  if (!court) return null;
  const c = court.replace(/\s+/g, ' ').trim();
  if (/Автономн\S* Республік\S* Крим/i.test(c)) return 'Автономна Республіка Крим';
  const oblast = c.match(/(\S+)\s+област[іи]/i);
  if (oblast) {
    const r = regionByWord(oblast[1], { kyivAdjectiveIsCity: false });
    if (r) return r;
  }
  const city = c.match(/(?:^|\s)(?:м\.|міста)\s*([^\s(),]+(?:\s+(?:Рогу|Ріг))?)/i);
  if (city) {
    const r = regionByWord(city[1], { kyivAdjectiveIsCity: true });
    if (r) return r;
  }
  const appeal = c.match(/^(\S+)\s+апеляційн/i);
  if (appeal) {
    const r = regionByWord(appeal[1], { kyivAdjectiveIsCity: true });
    if (r) return r;
  }
  return null;
}

/** Regions a free-text filter value refers to ("Київ" → м. Київ + Київська область). */
export function resolveRegionFilter(q: string): string[] {
  const raw = q.toLowerCase().replace(/\s+/g, ' ').trim();
  const isOblast = /(^|\s)обл(асть|асті|\.|$)/.test(raw);
  const isCity = /^(м\.|місто\s|міста\s)/.test(raw);
  const v = raw.replace(/(^|\s)обл(асть|асті|\.)?(?=\s|$)/g, '').replace(/^(м\.|місто|міста)\s*/, '').trim();
  if (!v) return [];
  const kyivWord = v.startsWith('київ') || v.startsWith('києв');
  // "Київська (область)" / "Київська обл." is the oblast only; "м. Київ" is the
  // city only; a bare "Київ" may mean either, so it covers both.
  if (v.startsWith('київськ') || (kyivWord && isOblast)) return ['Київська область'];
  if (kyivWord && isCity) return ['м. Київ'];
  if (kyivWord) return ['м. Київ', 'Київська область'];
  const out: string[] = [];
  for (const r of ARMA_REGIONS) {
    const cityRegion = r.name.startsWith('м. ');
    if (isOblast && cityRegion) continue;
    const lname = r.name.toLowerCase();
    if (lname.includes(v) || r.stems.some((s) => v.startsWith(s) || (v.length >= 4 && s.startsWith(v)))) {
      out.push(r.name);
    }
  }
  return out;
}

// ---------------------------------------------------------- asset category

/** Asset categories derived from description + props (the dataset has no asset-type field). */
export const ARMA_ASSET_CATEGORIES = [
  'документи',
  'транспорт: залізничний вагон',
  'транспорт: судно / повітряне судно',
  'транспортний засіб',
  'земельна ділянка',
  'нерухоме майно',
  'грошові кошти',
  'цінні папери / корпоративні права',
  'майнові права',
  'техніка / електроніка',
  'товарно-матеріальні цінності',
  'зброя / боєприпаси',
  'інше',
] as const;

export function categorizeAsset(description: string | null | undefined, props: string | null | undefined): string {
  const d = (description || '').toLowerCase();
  const p = (props || '').toLowerCase();
  if (/^\s*(свідоцтв|посвідчен|паспорт|документ|тимчасове посвідчення|техпаспорт|довідк|чорнов|блокнот|зошит)/.test(d)) return 'документи';
  if (/вагон|цистерн|локомотив|тепловоз/.test(d) || p.includes('вид вагону')) return 'транспорт: залізничний вагон';
  if (/(^|[^а-яіїєґ])суд(но|на)([^а-яіїєґ]|$)|катер|човен|яхт|баркас|теплохід|буксир|літак|вертол|гелікоптер|повітрян/.test(d) || /судна|повітряного судна/.test(p)) return 'транспорт: судно / повітряне судно';
  if (/автомоб|транспортн\S* засіб|мотоцикл|мопед|скутер|причіп|напівпричіп|трактор|автобус|тягач|вантажівк|мікроавтобус|комбайн|екскаватор|навантажувач|квадроцикл/.test(d)) return 'транспортний засіб';
  if (/(^|[^a-z])(bmw|mercedes|toyota|audi|volkswagen|lexus|porsche|range rover|land rover|ford|renault|skoda|škoda|nissan|hyundai|kia|mazda|honda|chevrolet|opel|peugeot|citroen|volvo|tesla|infiniti|mitsubishi|subaru|jeep|cadillac|bentley|ferrari|maserati|lamborghini|rolls-royce|daf|scania|iveco|john deere|claas)([^a-z]|$)|ваз|камаз/.test(d)) return 'транспортний засіб';
  if (/земельн|кадастров/.test(d) || p.includes('призначення, вид')) return 'земельна ділянка';
  if (/квартир|будин|будівл|котедж|апартамент|нежитл|приміщен|нерухом|машиномісц|паркінг|споруд|гараж|майнов\S* комплекс|об[`'’ʼ]єкт незаверш/.test(d) || p.includes('площа')) return 'нерухоме майно';
  // "площею 0,7550 га, за адресою ..." without the word "земельна"
  if (/\d\s*га([^а-яіїєґ]|$)/.test(d)) return 'земельна ділянка';
  if (/акці|корпоратив|частк\S* (у|в) статутн|статутн\S* капітал|цінн\S* папер|облігац/.test(d) || p.includes('частка (')) return 'цінні папери / корпоративні права';
  if (/майнов\S* прав|віртуальн\S* актив|криптовалют/.test(d) || p.includes('вид майнових прав')) return 'майнові права';
  if (/грошов|готівк|кошти|банкнот|валют|долар|євро|гривн/.test(d) || /валюта:|сума:/.test(p)) return 'грошові кошти';
  if (/зброя|зброї|пістолет|рушниц|автомат калашн|набо[їі]|боєприпас|гранат/.test(d)) return 'зброя / боєприпаси';
  if (/телефон|смартфон|ноутбук|планшет|системн\S* блок|комп[`'’ʼ]ютер|монітор|флеш|жорстк\S* диск|накопичувач|сім-карт|sim|роутер|сервер|відеореєстратор|videorecorder|годинник|телевізор|холодильник|пральн\S* машин|проектор|колонк|плеєр|фотоапарат|принтер|електронн\S* пристр/.test(d) || p.includes('вид приладу')) return 'техніка / електроніка';
  if (/товар|коробк|пакет|сировин|вугілл|зерн|пальн|нафт|дизел|бензин|продукці|тютюн|сигарет|алкогол|лісоматеріал|деревин|металобрухт|мішк|цукор|карбамід|пісок|добрив|бурштин|\d\s*(тон|кг)([^а-яіїєґ]|$)/.test(d)) return 'товарно-матеріальні цінності';
  // Vehicle make/model in props without a vehicle word in the description.
  if (/марка:/.test(p) && /модель:/.test(p) && /рік випуску/.test(p)) return 'транспортний засіб';
  return 'інше';
}

// ------------------------------------------------------------- record map

export function mapArmaItem(r: ArmaSourceItem): ArmaRow {
  const props1 = r.props_1 || null;
  const props2 = r.props_2 || null;
  const court = propValue(props1, 'Найменування суду');
  const decisionType = clean(r.dectypename);
  const caseNumbers = splitCaseNumbers(r.docnum);
  const caseDate = parseArmaDate(r.decisiondate);
  const isArrest = !!decisionType && /(^|;\s*)(накладення арешту|арешт в частині)/i.test(decisionType);
  const income = r.actionincomesum === undefined || r.actionincomesum === null || r.actionincomesum === ''
    ? null
    : String(r.actionincomesum).replace(',', '.');
  return {
    asset_id: clean(r.id),
    case_number: clean(r.docnum),
    case_numbers: caseNumbers,
    criminal_proceeding_number: clean(r.numerdr),
    case_date: caseDate,
    court_name: court,
    judge_name: propValue(props1, 'ПІБ судді'),
    investigation_body: propValue(props1, 'Найменування органу досудового розс.'),
    region: regionFromCourt(court),
    decision_type: decisionType,
    asset_type: categorizeAsset(r.description, r.props),
    asset_description: clean(r.description),
    asset_props: clean(r.props),
    action_name: clean(r.name),
    action_date: parseArmaDate(r.dateaction),
    action_details: clean(props2),
    action_income_sum: income && /^-?\d+(\.\d+)?$/.test(income) ? income : null,
    status: clean(r.state),
    arrest_date: isArrest ? caseDate : null,
    transfer_date: parseArmaDate(propValue(props2, 'Дата передачі на реалізацію') || propValue(props2, 'Дата підписання')),
    manager: propValue(props2, 'Назва управителя/ПІБ управителя') || propValue(props2, 'Реалізатор'),
  };
}

// ---------------------------------------------------------------- filters

/** Documented English status values → SQL over status (ARMA action state) / decision_type. */
export const ARMA_STATUS_ALIASES: Record<string, string> = {
  arrested: `decision_type ~* '(^|;\\s*)(накладення арешту|арешт в частині)'`,
  transferred: `(decision_type ~* 'передач' OR status IN ('Передано для реалізації', 'Організація передачі активу управителю', 'Управління за договором', 'Конкурсний відбір управителя'))`,
  returned: `(status ILIKE 'Повернення власнику%' OR decision_type ILIKE '%скасування арешту%')`,
  sold: `status = 'Реалізовано'`,
  confiscated: `decision_type ~* '(стягнення в дохід держави|спеціальна конфіскація)'`,
};

export interface ArmaSearchParams {
  owner_name?: string;
  owner_edrpou?: string;
  case_number?: string;
  criminal_proceeding_number?: string;
  asset_type?: string;
  description?: string;
  status?: string;
  court_name?: string;
  region?: string;
}

export function escapeLikeArma(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const ARMA_MAX_DESCRIPTION_TOKENS = 10;

/** Build WHERE conditions; placeholders start at $1. `error` is a user-facing (Ukrainian) validation message. */
export function buildArmaFilters(params: ArmaSearchParams): { conditions: string[]; values: any[]; error?: string } {
  const conditions: string[] = [];
  const values: any[] = [];
  const add = (sqlFor: (p: string) => string, value: any) => {
    values.push(value);
    conditions.push(sqlFor(`$${values.length}`));
  };
  const s = (v?: string) => (typeof v === 'string' ? v.trim() : '');

  const caseNo = s(params.case_number);
  if (caseNo) {
    const parts = splitCaseNumbers(caseNo);
    // An ЄРДР number (digits only) may be passed as case_number too.
    if (/^\d{10,20}$/.test(caseNo)) {
      add((p) => `(criminal_proceeding_number = ${p} OR case_numbers @> ARRAY[${p}]::text[])`, caseNo);
    } else if (parts.length > 1) {
      add((p) => `case_numbers && ${p}::text[]`, parts);
    } else {
      add((p) => `case_numbers @> ARRAY[${p}]::text[]`, parts[0]);
    }
  }
  const erdr = s(params.criminal_proceeding_number);
  if (erdr) add((p) => `criminal_proceeding_number = ${p}`, erdr.replace(/\D/g, '') || erdr);

  const assetType = s(params.asset_type);
  if (assetType) {
    add((p) => `(asset_type ILIKE ${p} OR asset_description ILIKE ${p})`, `%${escapeLikeArma(assetType)}%`);
  }
  const descr = s(params.description);
  if (descr) {
    const tokens = descr.split(/\s+/).filter((t) => t.length > 1);
    if (tokens.length > ARMA_MAX_DESCRIPTION_TOKENS) {
      return { conditions: [], values: [], error: `Занадто довгий опис: не більше ${ARMA_MAX_DESCRIPTION_TOKENS} слів (отримано ${tokens.length})` };
    }
    for (const tok of tokens) {
      add((p) => `(asset_description ILIKE ${p} OR asset_props ILIKE ${p})`, `%${escapeLikeArma(tok)}%`);
    }
  }

  const status = s(params.status);
  if (status) {
    const key = status.toLowerCase();
    const alias = Object.prototype.hasOwnProperty.call(ARMA_STATUS_ALIASES, key) ? ARMA_STATUS_ALIASES[key] : undefined;
    if (alias) conditions.push(alias);
    else add((p) => `(status ILIKE ${p} OR decision_type ILIKE ${p} OR action_name ILIKE ${p})`, `%${escapeLikeArma(status)}%`);
  }

  const court = s(params.court_name);
  if (court) add((p) => `court_name ILIKE ${p}`, `%${escapeLikeArma(court)}%`);

  const region = s(params.region);
  if (region) {
    const regions = resolveRegionFilter(region);
    if (regions.length) add((p) => `region = ANY(${p}::text[])`, regions);
    else add((p) => `region ILIKE ${p}`, `%${escapeLikeArma(region)}%`);
  }

  return { conditions, values };
}

export const ARMA_OWNER_NOT_PUBLISHED =
  'Відкриті дані АРМА (data.gov.ua) не містять відомостей про власників активів (ПІБ/назва, ЄДРПОУ): ' +
  'їх виключено згідно з абз. 9 ч. 1 ст. 25 Закону про АРМА. Шукайте за номером справи (case_number), ' +
  'номером кримінального провадження ЄРДР (criminal_proceeding_number), описом активу (description), судом або регіоном.';
