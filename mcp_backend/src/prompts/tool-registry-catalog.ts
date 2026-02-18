/**
 * Scenario Catalog for the LLM chat pipeline.
 *
 * Each entry maps: query type → data sources → tool chain → response template.
 * ChatService injects the relevant subset into the system prompt so the LLM
 * follows a structured answer format for every scenario.
 */

// ============================
// Types
// ============================

export interface ScenarioDataSource {
  name: string;     // "ZakonOnline", "Rada API", "OpenReyestr", "Qdrant", "PostgreSQL"
  provides: string; // What it provides for this scenario
}

export interface ScenarioToolStep {
  tool: string;      // MCP tool name
  purpose: string;   // Why call it (Ukrainian)
  optional?: boolean;
}

export interface ResponseSection {
  heading: string;     // Section heading (Ukrainian)
  instruction: string; // What to write
  optional?: boolean;
}

export interface ScenarioCatalogEntry {
  id: string;
  label: string;                     // Name (Ukrainian)
  domains: string[];                 // Trigger domains
  triggerSlots?: string[];           // Slots that refine selection
  exampleQueries: string[];          // Example queries (Ukrainian)
  dataSources: ScenarioDataSource[];
  toolChain: ScenarioToolStep[];
  responseTemplate: ResponseSection[];
}

// ============================
// Catalog (~29 scenarios)
// ============================

export const SCENARIO_CATALOG: ScenarioCatalogEntry[] = [

  // ─────────────── Court (7) ───────────────

  {
    id: 'court_practice_search',
    label: 'Тематичний пошук судової практики',
    domains: ['court', 'legal_advice'],
    exampleQueries: [
      'Яка практика щодо виселення з іпотечного майна?',
      'Судова практика стягнення аліментів на дитину',
    ],
    dataSources: [
      { name: 'ZakonOnline', provides: 'судові рішення за темою' },
      { name: 'Qdrant', provides: 'векторний пошук по збережених рішеннях' },
    ],
    toolChain: [
      { tool: 'search_legal_precedents', purpose: 'тематичний пошук рішень' },
      { tool: 'get_court_decision', purpose: 'повний текст знайденого рішення', optional: true },
      { tool: 'get_case_documents_chain', purpose: 'історія справи через інстанції', optional: true },
    ],
    responseTemplate: [
      { heading: 'Правова норма', instruction: 'відповідні статті законів' },
      { heading: 'Позиція суду', instruction: 'конкретні рішення з номерами справ' },
      { heading: 'Висновок', instruction: 'узагальнення практики' },
      { heading: 'Ризики', instruction: 'нюанси та суперечлива практика', optional: true },
      { heading: 'Джерела', instruction: 'номери справ, статті законів' },
    ],
  },

  {
    id: 'supreme_court_practice',
    label: 'Практика Верховного Суду',
    domains: ['court'],
    triggerSlots: ['procedure_code'],
    exampleQueries: [
      'Позиція ВС щодо строків позовної давності у господарських справах',
      'Практика Великої Палати ВС щодо земельних спорів',
    ],
    dataSources: [
      { name: 'ZakonOnline', provides: 'рішення Верховного Суду' },
    ],
    toolChain: [
      { tool: 'search_supreme_court_practice', purpose: 'пошук практики ВС за процесуальним кодексом' },
      { tool: 'get_court_decision', purpose: 'повний текст постанови ВС', optional: true },
    ],
    responseTemplate: [
      { heading: 'Позиція ВС', instruction: 'ключові правові висновки Верховного Суду' },
      { heading: 'Ключові тези', instruction: 'цитати з мотивувальної частини' },
      { heading: 'Висновок', instruction: 'узагальнення для практичного застосування' },
      { heading: 'Джерела', instruction: 'номери справ, дати постанов' },
    ],
  },

  {
    id: 'specific_case_lookup',
    label: 'Пошук конкретної справи за номером',
    domains: ['court'],
    triggerSlots: ['case_number'],
    exampleQueries: [
      'Покажи рішення у справі 922/989/18',
      'Що вирішив суд у справі 757/1234/22-ц?',
    ],
    dataSources: [
      { name: 'ZakonOnline', provides: 'текст судового рішення' },
    ],
    toolChain: [
      { tool: 'get_court_decision', purpose: 'отримати рішення за номером справи' },
    ],
    responseTemplate: [
      { heading: 'Суд / дата', instruction: 'назва суду, дата рішення, форма судочинства' },
      { heading: 'Обставини', instruction: 'короткий виклад фактів справи' },
      { heading: 'Рішення', instruction: 'резолютивна частина' },
      { heading: 'Мотивувальна частина', instruction: 'ключові аргументи суду' },
      { heading: 'Резолютивна частина', instruction: 'що саме вирішив суд' },
    ],
  },

  {
    id: 'case_chain_analysis',
    label: 'Історія справи через інстанції',
    domains: ['court'],
    triggerSlots: ['case_number'],
    exampleQueries: [
      'Покажи всю історію справи 910/12345/20 через усі інстанції',
      'Як змінювались рішення у справі 756/111/21?',
    ],
    dataSources: [
      { name: 'ZakonOnline', provides: 'рішення всіх інстанцій у справі' },
    ],
    toolChain: [
      { tool: 'get_case_documents_chain', purpose: 'отримати ланцюг рішень через інстанції' },
    ],
    responseTemplate: [
      { heading: 'Хронологія інстанцій', instruction: 'послідовність рішень з датами' },
      { heading: 'Ключові зміни', instruction: 'що змінювалось між інстанціями' },
      { heading: 'Поточний статус', instruction: 'остаточне рішення або стадія розгляду' },
    ],
  },

  {
    id: 'precedent_verification',
    label: 'Перевірка актуальності рішення',
    domains: ['court'],
    triggerSlots: ['case_number'],
    exampleQueries: [
      'Чи актуальне рішення у справі 922/989/18?',
      'Перевір чи не скасовано рішення у справі 757/1234/22',
    ],
    dataSources: [
      { name: 'ZakonOnline', provides: 'ланцюг рішень через інстанції' },
      { name: 'PostgreSQL', provides: 'кешований статус прецеденту' },
    ],
    toolChain: [
      { tool: 'check_precedent_status', purpose: 'Перевірити чи рішення не скасовано' },
      { tool: 'get_case_documents_chain', purpose: 'Отримати ланцюг інстанцій' },
    ],
    responseTemplate: [
      { heading: 'Статус рішення', instruction: 'актуальне / скасоване / змінене з поясненням' },
      { heading: 'Ланцюг інстанцій', instruction: 'хронологія рішень вищих інстанцій' },
      { heading: 'Рішення що вплинули', instruction: 'які саме рішення скасували / змінили' },
      { heading: 'Висновок', instruction: 'чи можна посилатися на це рішення' },
    ],
  },

  {
    id: 'comprehensive_case_analysis',
    label: 'Комплексний аналіз справи через усі інстанції',
    domains: ['court', 'legal_advice'],
    triggerSlots: ['case_number'],
    exampleQueries: [
      'Проаналізуй справу 922/989/18 через усі інстанції',
      'Комплексний аналіз справи 757/1234/22 з хронологією та оцінкою доказів',
      'Аналіз справи 910/5678/20 — позиції судів, еволюція вимог, висновки для сторін',
      'Детальний розбір справи 922/989/18 від районного суду до Великої Палати ВС',
    ],
    dataSources: [
      { name: 'ZakonOnline', provides: 'повні тексти рішень усіх інстанцій' },
      { name: 'PostgreSQL', provides: 'кешовані повні тексти судових рішень' },
    ],
    toolChain: [
      { tool: 'get_case_documents_chain', purpose: 'отримати повний ланцюг документів через усі інстанції' },
      { tool: 'load_full_texts', purpose: 'завантажити повні тексти ключових рішень (Рішення, Постанови, Окремі думки)' },
      { tool: 'get_court_decision', purpose: 'отримати секції конкретного рішення для аналізу' },
      { tool: 'get_legislation_section', purpose: 'текст застосованих норм для перевірки', optional: true },
    ],
    responseTemplate: [
      { heading: 'Вступний блок', instruction: 'номер справи, обсяг аналізу (кількість документів, інстанцій), джерела (ЄДРСР)' },
      { heading: 'Картка справи', instruction: 'категорія, сторони (позивач, відповідач, треті особи), предмет спору (первісний), ціна позову, поточний статус' },
      { heading: 'Хронологія (таблиця)', instruction: 'таблиця: №, дата, інстанція, процесуальна дія, ключова зміна — від відкриття провадження до остаточного рішення' },
      { heading: 'Еволюція предмету спору та вимог', instruction: 'по етапах: що змінилось, причина зміни, процесуальна підстава. Фінальне формулювання вимог' },
      { heading: 'Аналіз доказової бази (таблиця)', instruction: 'таблиця по етапах: докази позивача, докази відповідача, оцінка суду (прийнято/відхилено з мотивуванням), прогалини (що не досліджено)' },
      { heading: 'Позиції судів усіх інстанцій', instruction: 'для кожної інстанції окремо: висновок, мотивування, застосовані норми, ключова логіка. Для апеляції — розбіжність з 1 інстанцією. Для касації — підстава передачі до ВП ВС. Для ВП ВС — правова позиція та значення для правозастосування' },
      { heading: 'Результативні висновки для сторін', instruction: 'окремо для позивача, відповідача, третіх осіб: що отримано, що втрачено, правові ризики що реалізувались, використані захисні аргументи та їх ефективність' },
      { heading: 'Ключові правові висновки', instruction: 'юрисдикційне питання (якщо було переадресування), еволюція правової позиції ВС (як змінювалась практика), прецедентне значення (чи формує нову правову позицію), окремі думки суддів (якщо є)' },
      { heading: 'Додатки', instruction: 'схема руху справи між інстанціями (текстовий flowchart), перелік усіх рішень з посиланнями на ЄДРСР, порівняльна таблиця позицій сторін', optional: true },
    ],
  },

  {
    id: 'similar_fact_pattern',
    label: 'Пошук справ зі схожими обставинами',
    domains: ['court'],
    exampleQueries: [
      'Чи були справи де орендар відмовився від оренди через форс-мажор?',
      'Справи про відшкодування збитків від ДТП з пішоходом',
    ],
    dataSources: [
      { name: 'ZakonOnline', provides: 'рішення зі схожими фактичними обставинами' },
    ],
    toolChain: [
      { tool: 'find_similar_fact_pattern_cases', purpose: 'пошук справ зі схожими обставинами' },
    ],
    responseTemplate: [
      { heading: 'Схожі обставини', instruction: 'які факти збігаються' },
      { heading: 'Як суди вирішили', instruction: 'рішення у схожих справах' },
      { heading: 'Тенденція', instruction: 'переважаюча позиція судів' },
      { heading: 'Джерела', instruction: 'номери справ' },
    ],
  },

  {
    id: 'practice_pro_contra',
    label: 'Порівняння позитивної та негативної практики',
    domains: ['court'],
    exampleQueries: [
      'Які шанси на задоволення позову про визнання договору недійсним?',
      'Порівняй практику за і проти стягнення моральної шкоди',
    ],
    dataSources: [
      { name: 'ZakonOnline', provides: 'рішення з протилежними висновками' },
    ],
    toolChain: [
      { tool: 'compare_practice_pro_contra', purpose: 'порівняння позитивної та негативної практики' },
    ],
    responseTemplate: [
      { heading: 'ЗА (позитивна практика)', instruction: 'рішення на користь позивача' },
      { heading: 'ПРОТИ (негативна практика)', instruction: 'рішення на користь відповідача' },
      { heading: 'Баланс', instruction: 'співвідношення та тенденція' },
      { heading: 'Рекомендація', instruction: 'що враховувати при підготовці справи' },
    ],
  },

  {
    id: 'party_case_statistics',
    label: 'Статистика справ за учасником',
    domains: ['court'],
    exampleQueries: [
      'Скільки справ у ТОВ "Нова Пошта"?',
      'Судова статистика ПАТ "Укрзалізниця"',
    ],
    dataSources: [
      { name: 'ZakonOnline', provides: 'кількість та розподіл справ за стороною' },
    ],
    toolChain: [
      { tool: 'count_cases_by_party', purpose: 'статистика справ за учасником' },
    ],
    responseTemplate: [
      { heading: 'Загальна кількість', instruction: 'кількість справ' },
      { heading: 'Розподіл за категоріями', instruction: 'цивільні, господарські, адміністративні' },
      { heading: 'Ключові справи', instruction: 'найбільш значимі справи', optional: true },
    ],
  },

  // ─────────────── Legislation (5) ───────────────

  {
    id: 'legislation_article_lookup',
    label: 'Пошук конкретної статті закону',
    domains: ['legislation'],
    triggerSlots: ['law_reference'],
    exampleQueries: [
      'Стаття 16 Цивільного кодексу',
      'Що каже ст. 382 КК?',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'текст статті закону' },
      { name: 'PostgreSQL', provides: 'кешовані тексти законодавства' },
    ],
    toolChain: [
      { tool: 'get_legislation_article', purpose: 'отримати текст конкретної статті' },
      { tool: 'search_legal_precedents', purpose: 'практика застосування цієї статті', optional: true },
    ],
    responseTemplate: [
      { heading: 'Текст статті', instruction: 'повний текст статті закону' },
      { heading: 'Практика застосування', instruction: 'як суди тлумачать цю норму', optional: true },
      { heading: "Пов'язані норми", instruction: 'суміжні статті', optional: true },
    ],
  },

  {
    id: 'legislation_section_lookup',
    label: 'Розділ або глава закону',
    domains: ['legislation'],
    exampleQueries: [
      'Розділ II ЦПК про юрисдикцію',
      'Глава 82 ЦК про відшкодування шкоди',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'текст розділу закону' },
    ],
    toolChain: [
      { tool: 'get_legislation_section', purpose: 'отримати розділ/главу закону' },
    ],
    responseTemplate: [
      { heading: 'Структура розділу', instruction: 'перелік статей із назвами' },
      { heading: 'Ключові статті', instruction: 'найважливіші норми розділу' },
      { heading: 'Зміст', instruction: 'короткий зміст розділу' },
    ],
  },

  {
    id: 'legislation_search',
    label: 'Пошук законодавства за темою',
    domains: ['legislation', 'legal_advice'],
    exampleQueries: [
      'Який закон регулює оренду земельних ділянок?',
      'Законодавство про захист прав споживачів',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'закони за тематикою' },
      { name: 'ZakonOnline', provides: 'додаткові нормативні акти' },
    ],
    toolChain: [
      { tool: 'search_legislation', purpose: 'пошук законів за темою' },
      { tool: 'get_legislation_article', purpose: 'текст конкретних статей', optional: true },
    ],
    responseTemplate: [
      { heading: 'Знайдені закони', instruction: 'перелік відповідних нормативних актів' },
      { heading: 'Релевантні статті', instruction: 'конкретні норми що регулюють питання' },
      { heading: 'Висновок', instruction: 'які акти застосовуються до ситуації' },
    ],
  },

  {
    id: 'relevant_articles_by_situation',
    label: 'Знайти статті за описом ситуації',
    domains: ['legislation', 'legal_advice'],
    exampleQueries: [
      'Мене звільнили без попередження, які мої права?',
      'Сусід заливає квартиру, що робити за законом?',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'норми що регулюють ситуацію' },
    ],
    toolChain: [
      { tool: 'find_relevant_law_articles', purpose: 'знайти застосовні норми за описом ситуації' },
    ],
    responseTemplate: [
      { heading: 'Ситуація', instruction: 'переформулювання запиту юридичною мовою' },
      { heading: 'Застосовні норми', instruction: 'конкретні статті з цитатами' },
      { heading: 'Порядок дій', instruction: 'покрокові рекомендації' },
      { heading: 'Джерела', instruction: 'посилання на закони' },
    ],
  },

  {
    id: 'procedural_norms_search',
    label: 'Пошук процесуальних норм',
    domains: ['legislation'],
    exampleQueries: [
      'Строки подання апеляційної скарги у цивільній справі',
      'Порядок забезпечення позову в господарському процесі',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'процесуальні кодекси та норми' },
    ],
    toolChain: [
      { tool: 'search_procedural_norms', purpose: 'пошук процесуальних норм' },
    ],
    responseTemplate: [
      { heading: 'Процесуальна норма', instruction: 'відповідна стаття процесуального кодексу' },
      { heading: 'Строки', instruction: 'процесуальні строки якщо є' },
      { heading: 'Порядок', instruction: 'покрокова процедура' },
      { heading: 'Джерела', instruction: 'посилання на процесуальний кодекс' },
    ],
  },

  // ─────────────── Registry (7) ───────────────

  {
    id: 'entity_lookup_edrpou',
    label: 'Пошук юридичної особи за ЄДРПОУ',
    domains: ['registry'],
    triggerSlots: ['edrpou'],
    exampleQueries: [
      'Інформація про компанію з ЄДРПОУ 12345678',
      'Перевірити підприємство 87654321',
    ],
    dataSources: [
      { name: 'OpenReyestr', provides: 'дані з Єдиного державного реєстру' },
    ],
    toolChain: [
      { tool: 'openreyestr_get_by_edrpou', purpose: 'отримати дані за кодом ЄДРПОУ' },
    ],
    responseTemplate: [
      { heading: 'Назва / статус', instruction: 'повна назва, організаційна форма, стан реєстрації' },
      { heading: 'Керівник', instruction: 'ПІБ керівника та посада' },
      { heading: 'Засновники', instruction: 'перелік засновників та їхні частки' },
      { heading: 'Адреса', instruction: 'юридична адреса' },
      { heading: 'Вид діяльності', instruction: 'основний та додаткові КВЕДи' },
    ],
  },

  {
    id: 'entity_search_name',
    label: 'Пошук юридичної особи за назвою',
    domains: ['registry'],
    exampleQueries: [
      'Знайди компанію "Нова Пошта"',
      'Пошук ТОВ "Епіцентр"',
    ],
    dataSources: [
      { name: 'OpenReyestr', provides: 'список знайдених юридичних осіб' },
    ],
    toolChain: [
      { tool: 'openreyestr_search_entities', purpose: 'пошук юр. осіб за назвою' },
      { tool: 'openreyestr_get_by_edrpou', purpose: 'деталі найбільш релевантного результату', optional: true },
    ],
    responseTemplate: [
      { heading: 'Список знайдених', instruction: 'назва, ЄДРПОУ, статус кожного' },
      { heading: 'Деталі найбільш релевантного', instruction: 'повна інформація', optional: true },
    ],
  },

  {
    id: 'beneficiary_search',
    label: 'Пошук кінцевих бенефіціарів',
    domains: ['registry'],
    exampleQueries: [
      'Хто бенефіціар ТОВ "Рошен"?',
      'Кінцеві власники компанії з ЄДРПОУ 00000000',
    ],
    dataSources: [
      { name: 'OpenReyestr', provides: 'дані про кінцевих бенефіціарних власників' },
    ],
    toolChain: [
      { tool: 'openreyestr_search_beneficiaries', purpose: 'пошук бенефіціарів' },
    ],
    responseTemplate: [
      { heading: 'Кінцеві бенефіціари', instruction: 'ПІБ та тип зв\'язку' },
      { heading: 'Частка', instruction: 'розмір частки кожного бенефіціара' },
      { heading: 'Ланцюг володіння', instruction: 'структура власності', optional: true },
    ],
  },

  {
    id: 'debtor_search',
    label: 'Пошук боржників',
    domains: ['registry'],
    exampleQueries: [
      'Чи є борги у ТОВ "Приклад"?',
      'Перевірити боржника Іванов Іван Іванович',
    ],
    dataSources: [
      { name: 'OpenReyestr', provides: 'реєстр боржників' },
    ],
    toolChain: [
      { tool: 'openreyestr_search_debtors', purpose: 'пошук у реєстрі боржників' },
    ],
    responseTemplate: [
      { heading: 'Боржник', instruction: 'назва/ПІБ боржника' },
      { heading: 'Сума боргу', instruction: 'розмір заборгованості' },
      { heading: 'Стягувач', instruction: 'хто стягує борг' },
      { heading: 'Стан провадження', instruction: 'статус виконавчого провадження' },
    ],
  },

  {
    id: 'bankruptcy_search',
    label: 'Справи про банкрутство',
    domains: ['registry'],
    exampleQueries: [
      'Чи є справа про банкрутство ТОВ "Будінвест"?',
      'Банкрутство компанії ЄДРПОУ 11111111',
    ],
    dataSources: [
      { name: 'OpenReyestr', provides: 'справи про банкрутство' },
    ],
    toolChain: [
      { tool: 'openreyestr_search_bankruptcy_cases', purpose: 'пошук справ про банкрутство' },
    ],
    responseTemplate: [
      { heading: 'Боржник', instruction: 'назва та ідентифікатори' },
      { heading: 'Стадія банкрутства', instruction: 'розпорядження майном / ліквідація / санація' },
      { heading: 'Арбітражний керуючий', instruction: 'ПІБ та контакти' },
      { heading: 'Кредитори', instruction: 'основні кредитори', optional: true },
    ],
  },

  {
    id: 'enforcement_proceedings',
    label: 'Виконавчі провадження',
    domains: ['registry'],
    exampleQueries: [
      'Виконавчі провадження щодо Петренко П.П.',
      'Статус виконавчого провадження №12345',
    ],
    dataSources: [
      { name: 'OpenReyestr', provides: 'реєстр виконавчих проваджень' },
    ],
    toolChain: [
      { tool: 'openreyestr_search_enforcement_proceedings', purpose: 'пошук виконавчих проваджень' },
    ],
    responseTemplate: [
      { heading: 'Номер провадження', instruction: 'номер та дата відкриття' },
      { heading: 'Виконавець', instruction: 'назва органу/виконавця' },
      { heading: 'Боржник', instruction: 'дані боржника' },
      { heading: 'Статус', instruction: 'стан провадження' },
    ],
  },

  {
    id: 'notary_expert_search',
    label: 'Пошук нотаріусів та судових експертів',
    domains: ['registry'],
    exampleQueries: [
      'Нотаріуси у Київському районі Одеси',
      'Судові експерти з почеркознавства',
    ],
    dataSources: [
      { name: 'OpenReyestr', provides: 'реєстри нотаріусів та судових експертів' },
    ],
    toolChain: [
      { tool: 'openreyestr_search_notaries', purpose: 'пошук нотаріусів', optional: true },
      { tool: 'openreyestr_search_court_experts', purpose: 'пошук судових експертів', optional: true },
      { tool: 'openreyestr_search_forensic_methods', purpose: 'методики судових експертиз', optional: true },
    ],
    responseTemplate: [
      { heading: 'Список знайдених', instruction: 'ПІБ, район діяльності' },
      { heading: 'Контакти', instruction: 'адреса, телефон' },
      { heading: 'Спеціалізація', instruction: 'вид діяльності або спеціальність' },
    ],
  },

  // ─────────────── Parliament (4) ───────────────

  {
    id: 'deputy_info',
    label: 'Інформація про народного депутата',
    domains: ['parliament'],
    exampleQueries: [
      'Хто такий депутат Шевченко?',
      'Депутати фракції "Слуга Народу"',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'дані про народних депутатів' },
    ],
    toolChain: [
      { tool: 'rada_get_deputy_info', purpose: 'отримати інформацію про депутата або фракцію' },
    ],
    responseTemplate: [
      { heading: 'ПІБ', instruction: 'повне ім\'я депутата' },
      { heading: 'Фракція', instruction: 'назва фракції' },
      { heading: 'Комітети', instruction: 'членство у комітетах' },
      { heading: 'Контакти', instruction: 'контактна інформація', optional: true },
    ],
  },

  {
    id: 'parliament_bills_search',
    label: 'Пошук законопроєктів',
    domains: ['parliament'],
    exampleQueries: [
      'Законопроєкти про мобілізацію',
      'Які законопроєкти подав депутат Іваненко?',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'реєстр законопроєктів Верховної Ради' },
    ],
    toolChain: [
      { tool: 'rada_search_parliament_bills', purpose: 'пошук законопроєктів' },
    ],
    responseTemplate: [
      { heading: 'Список законопроєктів', instruction: 'номер, назва, дата реєстрації' },
      { heading: 'Статус', instruction: 'стадія розгляду' },
      { heading: 'Ініціатори', instruction: 'хто подав законопроєкт' },
    ],
  },

  {
    id: 'legislation_text_search',
    label: 'Пошук текстів законів (Рада)',
    domains: ['parliament', 'legislation'],
    exampleQueries: [
      'Знайди в законах згадку про "електронний підпис"',
      'Текст закону про публічні закупівлі',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'повнотекстовий пошук по законодавству' },
    ],
    toolChain: [
      { tool: 'rada_search_legislation_text', purpose: 'повнотекстовий пошук у законах' },
    ],
    responseTemplate: [
      { heading: 'Знайдені тексти', instruction: 'назви законів що містять пошуковий термін' },
      { heading: 'Релевантні фрагменти', instruction: 'цитати з контекстом' },
    ],
  },

  {
    id: 'voting_record_analysis',
    label: 'Аналіз голосувань',
    domains: ['parliament'],
    exampleQueries: [
      'Як голосували за закон про мобілізацію?',
      'Голосування фракції "ЄС" за бюджет 2025',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'результати голосувань' },
    ],
    toolChain: [
      { tool: 'rada_analyze_voting_record', purpose: 'аналіз результатів голосування' },
    ],
    responseTemplate: [
      { heading: 'Результат голосування', instruction: 'за/проти/утримались/не голосували' },
      { heading: 'Розподіл по фракціях', instruction: 'як голосувала кожна фракція' },
    ],
  },

  // ─────────────── Documents (2) ───────────────

  {
    id: 'document_semantic_search',
    label: 'Семантичний пошук по документах',
    domains: ['documents'],
    exampleQueries: [
      'Що написано в завантаженому договорі про відповідальність?',
      'Знайди в моїх документах інформацію про гарантійний строк',
    ],
    dataSources: [
      { name: 'Qdrant', provides: 'векторний пошук по завантажених документах' },
    ],
    toolChain: [
      { tool: 'semantic_search', purpose: 'семантичний пошук по документах користувача' },
    ],
    responseTemplate: [
      { heading: 'Знайдені документи', instruction: 'назви документів' },
      { heading: 'Релевантні фрагменти', instruction: 'цитати з документів' },
      { heading: 'Джерела', instruction: 'назви файлів та секції' },
    ],
  },

  {
    id: 'document_store',
    label: 'Збереження документа',
    domains: ['documents'],
    exampleQueries: [
      'Збережи цей договір',
      'Додай документ до бази',
    ],
    dataSources: [
      { name: 'PostgreSQL', provides: 'збереження метаданих' },
      { name: 'Qdrant', provides: 'збереження векторних ембедінгів' },
    ],
    toolChain: [
      { tool: 'store_document', purpose: 'зберегти документ у систему' },
    ],
    responseTemplate: [
      { heading: 'Статус збереження', instruction: 'успішно / помилка' },
      { heading: 'ID документа', instruction: 'ідентифікатор збереженого документа' },
    ],
  },

  // ─────────────── Composite (4) ───────────────

  {
    id: 'comprehensive_legal_advice',
    label: 'Комплексна юридична консультація',
    domains: ['legal_advice'],
    exampleQueries: [
      'Як захистити права при незаконному звільненні?',
      'Що робити якщо забудовник порушує строки будівництва?',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'відповідне законодавство' },
      { name: 'ZakonOnline', provides: 'судова практика' },
    ],
    toolChain: [
      { tool: 'search_legislation', purpose: 'знайти відповідний закон' },
      { tool: 'get_legislation_article', purpose: 'текст конкретної статті', optional: true },
      { tool: 'search_legal_precedents', purpose: 'судова практика з цього питання' },
    ],
    responseTemplate: [
      { heading: 'Правова норма', instruction: 'відповідні статті законів з цитатами' },
      { heading: 'Позиція суду', instruction: 'як суди вирішують подібні справи' },
      { heading: 'Висновок', instruction: 'конкретна відповідь на запитання' },
      { heading: 'Ризики', instruction: 'нюанси та застереження' },
      { heading: 'Джерела', instruction: 'номери справ, статті законів' },
    ],
  },

  {
    id: 'legal_document_drafting',
    label: 'Складання юридичного документа',
    domains: ['legal_advice'],
    exampleQueries: [
      'Напиши позовну заяву про стягнення боргу',
      'Зразок скарги на дії виконавця',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'правова основа для документа' },
    ],
    toolChain: [
      { tool: 'find_relevant_law_articles', purpose: 'знайти норми для правового обґрунтування' },
      { tool: 'search_legislation', purpose: 'додаткові нормативні акти', optional: true },
    ],
    responseTemplate: [
      { heading: 'Вступ + правова основа', instruction: 'пояснення та правова підстава' },
      { heading: 'Документ', instruction: 'зразок у блоці ```document з правильною розміткою' },
      { heading: 'Примітки', instruction: 'що потрібно замінити, на що звернути увагу' },
    ],
  },

  {
    id: 'echr_practice',
    label: 'Практика ЄСПЛ',
    domains: ['court'],
    exampleQueries: [
      'Рішення ЄСПЛ щодо свободи слова в Україні',
      'Практика Європейського суду з прав людини щодо права на справедливий суд',
    ],
    dataSources: [
      { name: 'ZakonOnline', provides: 'рішення ЄСПЛ' },
    ],
    toolChain: [
      { tool: 'search_echr_practice', purpose: 'пошук практики ЄСПЛ' },
    ],
    responseTemplate: [
      { heading: 'Справа ЄСПЛ', instruction: 'назва справи та номер заяви' },
      { heading: 'Обставини', instruction: 'короткий виклад фактів' },
      { heading: 'Рішення', instruction: 'висновок Суду' },
      { heading: 'Значення для України', instruction: 'як застосовується в українській практиці' },
    ],
  },

  {
    id: 'due_diligence_check',
    label: 'Комплексна перевірка контрагента (Due Diligence)',
    domains: ['registry', 'court'],
    triggerSlots: ['edrpou'],
    exampleQueries: [
      'Перевір контрагента ТОВ "Партнер" ЄДРПОУ 33333333',
      'Due diligence компанії "Інвест Груп"',
    ],
    dataSources: [
      { name: 'OpenReyestr', provides: 'реєстраційні дані, бенефіціари' },
      { name: 'ZakonOnline', provides: 'судові справи контрагента' },
    ],
    toolChain: [
      { tool: 'openreyestr_get_by_edrpou', purpose: 'загальна інформація з реєстру' },
      { tool: 'openreyestr_search_beneficiaries', purpose: 'кінцеві бенефіціари', optional: true },
      { tool: 'count_cases_by_party', purpose: 'судові справи контрагента', optional: true },
      { tool: 'openreyestr_search_debtors', purpose: 'перевірка в реєстрі боржників', optional: true },
      { tool: 'openreyestr_search_bankruptcy_cases', purpose: 'перевірка на банкрутство', optional: true },
    ],
    responseTemplate: [
      { heading: 'Загальна інформація', instruction: 'назва, статус, дата реєстрації, керівник' },
      { heading: 'Бенефіціари', instruction: 'ланцюг власності' },
      { heading: 'Судові справи', instruction: 'кількість та характер справ' },
      { heading: 'Борги', instruction: 'наявність у реєстрі боржників' },
      { heading: 'Ризик-оцінка', instruction: 'загальний висновок про надійність контрагента' },
    ],
  },
];

// ============================
// Serializer → system prompt
// ============================

function serializeToolChain(steps: ScenarioToolStep[]): string {
  return steps
    .map((s) => (s.optional ? `${s.tool} (опц.)` : s.tool))
    .join(' → ');
}

function serializeResponseTemplate(sections: ResponseSection[]): string {
  return sections
    .map((s, i) => {
      const opt = s.optional ? ' (опц.)' : '';
      return `  ${i + 1}. ${s.heading}${opt} — ${s.instruction}`;
    })
    .join('\n');
}

/**
 * Serialize the full catalog (or a filtered subset) into readable text
 * that gets injected into the system prompt.
 */
export function serializeCatalogForPrompt(scenarios: ScenarioCatalogEntry[]): string {
  const lines: string[] = ['## Каталог сценаріїв\n'];

  for (const s of scenarios) {
    lines.push(`### ${s.id} — ${s.label}`);
    lines.push(`Джерела: ${s.dataSources.map((d) => `${d.name} (${d.provides})`).join(', ')}`);
    lines.push(`Інструменти: ${serializeToolChain(s.toolChain)}`);
    lines.push(`Приклад: "${s.exampleQueries[0]}"`);
    lines.push(`Шаблон відповіді:`);
    lines.push(serializeResponseTemplate(s.responseTemplate));
    lines.push('');
  }

  lines.push(`## Якщо жоден сценарій не підходить`);
  lines.push(`Сформуй відповідь за шаблоном найближчого сценарію. Базовий шаблон:`);
  lines.push(`  1. Аналіз — що потрібно користувачу`);
  lines.push(`  2. Знайдена інформація — результати інструментів`);
  lines.push(`  3. Висновок — відповідь`);
  lines.push(`  4. Джерела — перелік джерел`);

  return lines.join('\n');
}

// ============================
// Domain → Tools derivation
// ============================

/**
 * Derive DOMAIN_TOOL_MAP from the catalog so tool filtering stays in sync.
 */
export function deriveDomainToolMap(catalog: ScenarioCatalogEntry[]): Record<string, string[]> {
  const map: Record<string, Set<string>> = {};

  for (const entry of catalog) {
    for (const domain of entry.domains) {
      if (!map[domain]) map[domain] = new Set();
      for (const step of entry.toolChain) {
        map[domain].add(step.tool);
      }
    }
  }

  const result: Record<string, string[]> = {};
  for (const [domain, tools] of Object.entries(map)) {
    result[domain] = Array.from(tools);
  }
  return result;
}

/**
 * Derive default tools — non-optional tools from the most common scenarios.
 */
export function deriveDefaultTools(catalog: ScenarioCatalogEntry[]): string[] {
  const toolFreq = new Map<string, number>();

  for (const entry of catalog) {
    for (const step of entry.toolChain) {
      if (!step.optional) {
        toolFreq.set(step.tool, (toolFreq.get(step.tool) || 0) + 1);
      }
    }
  }

  // Take tools that appear in 2+ scenarios as non-optional, sorted by frequency
  return Array.from(toolFreq.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([tool]) => tool);
}

// Pre-computed exports
export const DERIVED_DOMAIN_TOOL_MAP = deriveDomainToolMap(SCENARIO_CATALOG);
export const DERIVED_DEFAULT_TOOLS = deriveDefaultTools(SCENARIO_CATALOG);

// ============================
// Enriched system prompt builder
// ============================

/**
 * Sections in the base prompt that are replaced by the catalog.
 * These are identified by their heading markers.
 */
const REPLACED_SECTION_HEADINGS = [
  '## Багатокрокові стратегії',
  '## Вибір інструменту для законодавства',
  '## Вибір інструменту для судових справ',
  '## Вибір інструменту для парламентських даних',
];

/**
 * Remove sections from the base prompt that are now covered by the catalog.
 */
function stripReplacedSections(prompt: string): string {
  let result = prompt;

  for (const heading of REPLACED_SECTION_HEADINGS) {
    // Find the heading and remove everything until the next ## heading or end
    const idx = result.indexOf(heading);
    if (idx === -1) continue;

    // Find the next ## heading after this one
    const afterHeading = idx + heading.length;
    const nextHeadingIdx = result.indexOf('\n##', afterHeading);

    if (nextHeadingIdx !== -1) {
      // Remove from heading start to the next heading (exclusive)
      result = result.slice(0, idx) + result.slice(nextHeadingIdx + 1); // +1 to skip the \n
    } else {
      // No next heading — remove to end
      result = result.slice(0, idx);
    }
  }

  return result;
}

/**
 * Build the enriched system prompt by:
 * 1. Stripping old tool-selection sections from the base prompt
 * 2. Filtering catalog scenarios to matching domains (if provided)
 * 3. Injecting the serialized catalog before ## Правила
 */
export function buildEnrichedSystemPrompt(
  basePrompt: string,
  catalog: ScenarioCatalogEntry[],
  domains?: string[]
): string {
  // 1. Strip old sections
  const stripped = stripReplacedSections(basePrompt);

  // 2. Filter catalog by domains (if known)
  let filtered: ScenarioCatalogEntry[];
  if (domains && domains.length > 0) {
    filtered = catalog.filter((entry) =>
      entry.domains.some((d) => domains.includes(d))
    );
    // Always include composite scenarios when legal_advice or multiple domains
    if (domains.length > 1 || domains.includes('legal_advice')) {
      const compositeIds = new Set(filtered.map((e) => e.id));
      for (const entry of catalog) {
        if (!compositeIds.has(entry.id) && entry.domains.length > 1) {
          // Check if any of entry's domains overlap with requested domains
          if (entry.domains.some((d) => domains.includes(d))) {
            filtered.push(entry);
          }
        }
      }
    }
  } else {
    filtered = catalog;
  }

  // 3. Serialize catalog
  const catalogText = serializeCatalogForPrompt(filtered);

  // 4. Insert before ## Правила (or at the end if not found)
  const rulesIdx = stripped.indexOf('## Правила');
  if (rulesIdx !== -1) {
    return stripped.slice(0, rulesIdx) + catalogText + '\n\n' + stripped.slice(rulesIdx);
  }

  return stripped + '\n\n' + catalogText;
}
