/**
 * How the public /api/v2/mcp endpoint presents its tools to external clients.
 *
 * The handlers' own descriptions also serve the in-house chat agent, so they carry
 * routing hints ("далі викликайте X", "ПОЧИНАЙТЕ З ЦЬОГО"). Directory review for
 * public MCP servers (Claude directory, Harvey Connector Library) does not allow tool
 * descriptions that instruct the model or point at other tools, and it expects every
 * tool to declare annotations. This module applies those rules to the v2 surface only;
 * v1 and the chat agent keep the original text.
 */
import type { ToolAnnotations, ToolDefinition } from './base-tool-handler.js';

const RO: Omit<ToolAnnotations, 'title'> = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Neutral descriptions replacing ones that instruct the model or name other tools. */
export const V2_DESCRIPTION_OVERRIDES: Record<string, string> = {
  search_court_decisions:
    'Пошук судових рішень у Єдиному державному реєстрі судових рішень (ЄДРСР): понад 82 млн рішень усіх судів України з 2006 року.\n\n' +
    'Режими (mode):\n' +
    '• structured — за метаданими: номер справи, суддя, суд, дата, категорія, військові пресети.\n' +
    '• exact — точний повнотекстовий збіг токена чи фрази (номер заявки, свідоцтва, коду) без переформулювання запиту; усі збіги, найновіші першими.\n' +
    '• fulltext — повнотекстовий пошук (PostgreSQL tsvector) з підсвіченими фрагментами; запит зводиться до ключових термінів.\n' +
    '• hybrid — повнотекстовий і семантичний пошук (BGE-M3), об\'єднані через Reciprocal Rank Fusion.\n' +
    '• semantic — семантичний пошук по векторній базі всього ЄДРСР (296 млн фрагментів).\n\n' +
    'Фільтри для всіх режимів: court_code/court_name, judge, justice_kind, judgment_code, category_code, date_from/date_to, ' +
    'court_level (SC — Верховний Суд, GrandChamber — Велика Палата ВС). party_name разом з party_role (fulltext/hybrid) ' +
    'знаходить рішення, де названа сторона виступає позивачем чи відповідачем. Пресети: military_preset (військові справи), ' +
    'kupap_preset (справи про адмінправопорушення). Повертає метадані рішень і фрагменти тексту.',
  get_court_decision:
    'Повний текст судового рішення за doc_id або номером справи, розбитий на секції: шапка, фактичні обставини, мотивування суду, ' +
    'застосовані норми, позовні вимоги, резолютивна частина. Резолютивна частина повертається завжди. Обсяг відповіді обмежено ' +
    'приблизно 40 000 символами: першими відкидаються середні секції, а обрізана секція позначається «ОБРІЗАНО» з параметрами ' +
    'для продовження. sections_index перелічує всі секції; параметри section та offset повертають окрему секцію або її продовження.',
  get_case_documents_chain:
    'Усі судові документи однієї справи в усіх інстанціях: рішення першої інстанції, постанови апеляційних і касаційних судів, ' +
    'постанови Великої Палати ВС, ухвали, рішення після нового розгляду. Документи групуються за інстанціями.\n\n' +
    'За один виклик повертається до 100 документів. total_documents — скільки документів у справі загалом, returned_documents — ' +
    'скільки повернуто, has_more — чи є ще; summary рахується по всій справі. sort=balanced (типово) повертає початок справи ' +
    'і найновіші документи; asc або desc разом з offset повертають решту. document_types звужує вибірку до певних форм рішень, ' +
    'наприклад ["Рішення", "Постанова"].',
  load_full_texts:
    'Повні тексти судових рішень за масивом doc_id. Тексти беруться з кешу або завантажуються з реєстру. Типово повертає лише ' +
    'статус завантаження; з return_texts=true повертає для кожного документа мотивувальну й резолютивну частини та застосовані ' +
    'норми (до snippet_chars символів на документ). Шапка й історія розгляду не повертаються.',
  get_legislation_structure:
    'Структура законодавчого акта: зміст (розділи, глави, параграфи) з кількістю статей у кожному вузлі. Типово без переліку ' +
    'статей, бо великі кодекси не вміщуються у відповідь; include_articles=true додає плоский перелік статей з пагінацією ' +
    'через offset/limit.',
  list_legislation_editions:
    'Перелік усіх історичних редакцій законодавчого акта з датами набрання чинності. Ці дати придатні як as_of_date для ' +
    'отримання статті в історичній редакції.',
  get_legislation_history:
    'Історія змін (редакцій) законодавчого акта: які статті змінювалися, коли і якими актами. Без article_number повертає ' +
    'загальну статистику змін, згруповану за статтями; з article_number — повну історію конкретної статті.\n\n💰 Вартість: $0.00',
  get_trademark_dossier:
    'Повне досьє торговельної марки за номером свідоцтва (напр. "67482") або заявки (напр. "m202422025"): визначення номера ' +
    'по реєстрах, реєстрові дані та статус, хронологія подій, класи МКТП, правоволодіння, схожі позначення в тих самих класах, ' +
    'судова практика з ЄДРСР, редакція ст. 6 Закону № 3689-XII на дату подання заявки порівняно з чинною, відомості про ' +
    'правовласника.',
  search_amcu_practice:
    'Семантичний пошук по рішеннях Антимонопольного комітету України: 2 600 рішень з повним текстом, 174 тис. фрагментів. ' +
    'Шукає за змістом, а не за збігом слів, тож знаходить релевантну практику й за іншого формулювання (наприклад, ' +
    '«антиконкурентні узгоджені дії» на запит «змова на торгах»). Повертає рішення з найрелевантнішою цитатою та оцінкою схожості.',
  search_court_hearing_schedule:
    'Розклад судових засідань: дата, час, зал, учасники. Містить опублікований розклад найближчих засідань і архів проведених ' +
    'засідань з 2020 року (понад 30 млн записів з відкритих даних судової влади); кожен рядок позначено source=schedule або ' +
    'archive. Пошук за номером справи, учасником або судом; суддя — додатковий фільтр. Номер справи в query розпізнається ' +
    'автоматично. Тексти судових рішень не повертаються.\n\n💰 Орієнтовна вартість: $0.001-$0.01 USD',
  search_npa:
    'Пошук по повному корпусу нормативно-правових актів України: 293 тис. актів, 439 тис. редакцій, 2,2 млн статей — увесь ' +
    'реєстр zakon.rada.gov.ua, включно з постановами КМУ, наказами міністерств, указами, листами й роз\'ясненнями.\n\n' +
    'Два взаємовиключні режими: query — повнотекстовий пошук по тексту актів; title — нечіткий пошук за назвою акта (триграми). ' +
    'Фільтри: status (типово «чинний»), doc_type (Закон, Кодекс, Постанова, Указ, Наказ…), as_of_date. Пошук іде по чинних ' +
    'редакціях; as_of_date визначає, з якої редакції показано фрагмент.',
  rada_search_parliament_bills:
    'Пошук законопроєктів Верховної Ради України за назвою чи темою, статусом, ініціатором, комітетом і датою реєстрації.\n\n' +
    '💰 Орієнтовна вартість: $0.01-$0.05 USD',
};

/**
 * Annotations for v2 tools whose definitions arrive without them (proxied rada_* and
 * openreyestr_* services) or understate them (load_full_texts only fills our cache of
 * public court texts; it changes nothing the user owns).
 */
export const V2_ANNOTATION_OVERRIDES: Record<string, ToolAnnotations> = {
  load_full_texts: { title: 'Повні тексти рішень', ...RO },
  openreyestr_get_by_edrpou: { title: 'ЄДР: компанія за кодом ЄДРПОУ', ...RO },
  openreyestr_get_entity_details: { title: 'ЄДР: повні відомості про суб\'єкт', ...RO },
  openreyestr_search_entities: { title: 'ЄДР: пошук суб\'єктів господарювання', ...RO },
  openreyestr_search_beneficiaries: { title: 'ЄДР: пошук бенефіціарів', ...RO },
  openreyestr_search_debtors: { title: 'Єдиний реєстр боржників', ...RO },
  openreyestr_search_enforcement_proceedings: { title: 'Виконавчі провадження', ...RO },
  openreyestr_search_bankruptcy_cases: { title: 'Справи про банкрутство', ...RO },
  openreyestr_search_prozorro: { title: 'Тендери ProZorro', ...RO },
  openreyestr_search_rnbo_sanctions: { title: 'Санкції РНБО', ...RO },
  openreyestr_search_arma_seized_assets: { title: 'Арештовані активи (АРМА)', ...RO },
  openreyestr_search_nazk_declarations: { title: 'Декларації НАЗК', ...RO },
  openreyestr_search_notaries: { title: 'Реєстр нотаріусів', ...RO },
  openreyestr_search_tax_debt: { title: 'Податковий борг', ...RO },
  openreyestr_search_esv_debt: { title: 'Борг зі сплати ЄСВ', ...RO },
  openreyestr_search_single_tax_payers: { title: 'Платники єдиного податку', ...RO },
  openreyestr_search_termination_started: { title: 'Припинення юридичних осіб', ...RO },
  openreyestr_search_arbitration_managers: { title: 'Арбітражні керуючі', ...RO },
  openreyestr_search_special_forms: { title: 'Спецбланки нотаріальних документів', ...RO },
  openreyestr_get_statistics: { title: 'ЄДР: статистика', ...RO },
  rada_search_parliament_bills: { title: 'Законопроєкти Верховної Ради', ...RO },
  rada_search_bill_documents: { title: 'Висновки до законопроєктів', ...RO },
  rada_get_deputy_info: { title: 'Народний депутат', ...RO },
  rada_analyze_voting_record: { title: 'Голосування депутата', ...RO },
};

/** Proxied services prefix their descriptions with a source tag and a Russian cost line. */
function normaliseDescription(text: string): string {
  return text
    .replace(/^\[(?:OpenReyestr|RADA)\]\s*/, '')
    .replace(/Примерная стоимость:/g, 'Орієнтовна вартість:');
}

/** Apply the v2 presentation rules. Pure: the input definitions are not mutated. */
export function presentV2Tools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((t) => {
    const description = normaliseDescription(V2_DESCRIPTION_OVERRIDES[t.name] ?? t.description);
    const override = V2_ANNOTATION_OVERRIDES[t.name];
    const annotations = override ? { ...(t.annotations ?? {}), ...override } : t.annotations;
    return { ...t, description, ...(annotations ? { annotations } : {}) };
  });
}
