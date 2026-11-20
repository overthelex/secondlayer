/**
 * OpenReyestr MCP API - MCP tools definition and routing
 * Provides Ukrainian State Register access via Model Context Protocol
 */

import { OpenReyestrTools } from './openreyestr-tools';
import { CostTracker } from '../services/cost-tracker';
import { logger } from '../utils/logger';

export type StreamEventCallback = (event: {
  type: string;
  data: any;
  id?: string;
}) => void;

export class MCPOpenReyestrAPI {
  constructor(
    private tools: OpenReyestrTools,
    private _costTracker?: CostTracker
  ) {
    logger.debug('MCPOpenReyestrAPI initialized', { costTracking: Boolean(this._costTracker) });
  }

  getTools() {
    return [
      {
        name: 'search_entities',
        description: `Пошук суб'єктів господарювання в Єдиному державному реєстрі України

💰 Примерная стоимость: $0.001-$0.005 USD
Пошук юридичних осіб, ФОП та громадських організацій за назвою, ЄДРПОУ або іншими критеріями.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Пошуковий запит (назва або частина назви суб\'єкта)',
            },
            edrpou: {
              type: 'string',
              description: 'Код ЄДРПОУ (8 цифр)',
            },
            record: {
              type: 'string',
              description: 'Номер запису в реєстрі',
            },
            entityType: {
              type: 'string',
              enum: ['UO', 'FOP', 'FSU', 'ALL'],
              default: 'ALL',
              description: 'Тип суб\'єкта: UO (юридичні особи), FOP (ФОП), FSU (громадські організації), ALL (всі типи)',
            },
            stan: {
              type: 'string',
              description: 'Статус діяльності (наприклад, "зареєстровано", "припинено")',
            },
            limit: {
              type: 'number',
              default: 50,
              maximum: 100,
              minimum: 1,
              description: 'Максимальна кількість результатів (1-100)',
            },
            offset: {
              type: 'number',
              default: 0,
              description: 'Зміщення для пагінації',
            },
          },
        },
      },
      {
        name: 'get_entity_details',
        description: `Отримання повної інформації про суб'єкт господарювання

💰 Примерная стоимость: $0.001-$0.003 USD
Включає відомості про засновників, бенефіціарів, керівників, філії та іншу інформацію з реєстру.`,
        inputSchema: {
          type: 'object',
          properties: {
            record: {
              type: 'string',
              description: 'Номер запису в реєстрі',
            },
            entityType: {
              type: 'string',
              enum: ['UO', 'FOP', 'FSU'],
              description: 'Тип суб\'єкта (необов\'язково, визначається автоматично)',
            },
          },
          required: ['record'],
        },
      },
      {
        name: 'search_founders',
        description: `Зворотний пошук за засновниками (учасниками) у ЄДР

Знаходить усі юрособи, де засновником є вказана особа чи компанія, зокрема іноземна,
або всі юрособи із засновниками з певної країни. Повертає назву засновника, країну
резиденства/громадянства, розмір частки та юрособу (назва, ЄДРПОУ, стан).
Лише поточний склад засновників: колишніх учасників у відкритих даних ЄДР немає.
Назви країн українською, як у реєстрі: «Кіпр», «Сполучене Королівство», «Британські Віргінські Острови».`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Назва компанії-засновника або ПІБ (частина, щонайменше 3 символи), напр. «ЛІМІТЕД», «НАВТЕК ГМБХ»',
            },
            country: {
              type: 'string',
              description: 'Країна резиденства (компанія) або громадянства (фізособа) українською, напр. «Кіпр»',
            },
            foreign_only: {
              type: 'boolean',
              description: 'Лише іноземні засновники (країна вказана і не Україна)',
            },
            entity_type: {
              type: 'string',
              enum: ['UO', 'FSU'],
              description: 'UO = юрособи, FSU = громадські формування',
            },
            limit: { type: 'number', default: 50, minimum: 1, maximum: 100, description: 'Кількість результатів (1-100)' },
            offset: { type: 'number', default: 0, minimum: 0, description: 'Зсув для пагінації' },
          },
        },
      },
      {
        name: 'company_as_of',
        description: `ЄДР у минулому: відомості про юрособу станом на дату

Повертає стан суб'єкта (назва, ОПФ, стан, місцезнаходження, КВЕД, капітал, керівники,
засновники, бенефіціари) за найближчим завантаженим знімком ЄДР не пізніше вказаної дати
(2016, 2018, жовтень-листопад 2021, щотижневі знімки з 2026). У відповіді — дата знімка і джерело.
Поля, яких знімок не публікує (адреси й КВЕД у воєнний час), беруться з останнього знімка, де вони були.`,
        inputSchema: {
          type: 'object',
          properties: {
            edrpou: { type: 'string', description: 'Код ЄДРПОУ (8 цифр)' },
            date: { type: 'string', description: 'Дата у форматі YYYY-MM-DD, напр. 2021-10-25' },
          },
          required: ['edrpou', 'date'],
        },
      },
      {
        name: 'company_history',
        description: `ЄДР: історія змін юрособи за знімками

Для кожного поля (назва, стан, адреса, КВЕД, капітал, керівник, засновник, бенефіціар) —
усі значення з першим і останнім знімком ЄДР, у якому значення було. Значення, що зникло і
повернулося, дає дві серії. Перелік знімків із джерелами — у відповіді.
Для поля з понад 100 серіями (акціонерні товариства з сотнями засновників) повертаються 100
найновіших; поле truncated у відповіді вказує, скільки серій було всього.`,
        inputSchema: {
          type: 'object',
          properties: {
            edrpou: { type: 'string', description: 'Код ЄДРПОУ (8 цифр)' },
          },
          required: ['edrpou'],
        },
      },
      {
        name: 'find_connections',
        description: `Пошук зв'язків: граф зв'язків юрособи, особи чи адреси за ЄДР

Від компанії (код ЄДРПОУ), особи (повний ПІБ) або адреси — зв'язки до 3 кроків: засновники,
кінцеві бенефіціари, керівники, підписанти, місцезнаходження, сусідні коди реєстрації того ж дня.
Кожне ребро — з типом, датами (перший / останній знімок ЄДР), джерелом і посиланням на запис;
кожен вузол — з кількістю зв'язків і ознакою хаба; paths — шляхи від початку до знайдених компаній.

Обмеження даних: знімки ЄДР 2016–2018, 2021 і поточний 2026, дати між знімками наближені; дамп 2026
не містить адрес (зв'язки «місцезнаходження» — станом не пізніше 2021); ФОП у графі немає. Хаби
(адреси масової реєстрації, номінальні особи, поширені ПІБ) показуються, але пошук крізь них не йде,
якщо не задано include_hubs. Особи згруповані за ПІБ: вузол person_name об'єднує тезок, тому збіг за
ПІБ — лише кандидат (match_level "name_only"); підтвердження потребує другої ознаки (спільна
компанія, адреса, дата народження).`,
        inputSchema: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'Код ЄДРПОУ, повний ПІБ особи або адреса. Можна з префіксом: company:, person:, address:, foreign:CY:<назва>, node:<id> (id вузла з попередньої відповіді без «n»)' },
            start_type: { type: 'string', enum: ['auto', 'company', 'person', 'address'], default: 'auto', description: 'Тип початку; auto: лише цифри — ЄДРПОУ, текст із цифрами — адреса, інакше ПІБ. Пошук компанії за назвою не підтримується — вкажіть ЄДРПОУ' },
            depth: { type: 'integer', default: 2, minimum: 1, maximum: 3, description: 'Кількість кроків від початку (1-3)' },
            as_of: { type: 'string', description: 'Лише зв\'язки, чинні на дату YYYY-MM-DD (за знімками ЄДР)' },
            kinds: {
              type: 'array',
              items: { type: 'string', enum: ['founder', 'beneficiary', 'head', 'signer', 'registered_at', 'reg_neighbour'] },
              description: 'Типи зв\'язків: founder (засновник), beneficiary (КБВ), head (керівник), signer (підписант), registered_at (адреса), reg_neighbour (сусідній код реєстрації). Без фільтра — усі',
            },
            max_nodes: { type: 'integer', default: 200, minimum: 1, maximum: 1000, description: 'Максимум вузлів у відповіді (1-1000)' },
            max_fanout: { type: 'integer', default: 50, minimum: 1, maximum: 200, description: 'Максимум зв\'язків одного вузла (1-200)' },
            max_paths: { type: 'integer', default: 20, minimum: 0, maximum: 100, description: 'Скільки шляхів від початку до знайдених компаній показати в paths (0-100)' },
            include_hubs: { type: 'boolean', default: false, description: 'Іти крізь хаби (масові адреси, номінальні особи). Може дати тисячі зайвих зв\'язків' },
            include_source_refs: { type: 'boolean', default: false, description: 'Повні посилання на вихідні записи (хеші записів історії ЄДР) у кожному ребрі' },
          },
          required: ['start'],
        },
      },
      {
        name: 'connection_path',
        description: `Шлях зв'язку між двома компаніями чи особами за ЄДР

Найкоротші шляхи (до 4 кроків) між двома початками: код ЄДРПОУ, повний ПІБ або адреса. Кожен шлях —
ланцюжок вузлів і ребер (засновник, КБВ, керівник, підписант, адреса, сусідній код реєстрації) з
датами знімків ЄДР і джерелом. Пошук двобічний, крізь хаби не йде, якщо не задано include_hubs.

Обмеження ті самі, що в find_connections: знімки 2016–2018, 2021, 2026, дати наближені; адреси — станом
не пізніше 2021. Шлях через особу (person_name, match_level "name_only") — лише гіпотеза: це можуть
бути різні люди з однаковим ПІБ; підтвердження потребує другої ознаки.`,
        inputSchema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Перший початок: код ЄДРПОУ, повний ПІБ або адреса' },
            to: { type: 'string', description: 'Другий початок: код ЄДРПОУ, повний ПІБ або адреса' },
            from_type: { type: 'string', enum: ['auto', 'company', 'person', 'address'], default: 'auto', description: 'Тип першого початку' },
            to_type: { type: 'string', enum: ['auto', 'company', 'person', 'address'], default: 'auto', description: 'Тип другого початку' },
            max_depth: { type: 'integer', default: 3, minimum: 1, maximum: 4, description: 'Максимальна довжина шляху в кроках (1-4)' },
            as_of: { type: 'string', description: 'Лише зв\'язки, чинні на дату YYYY-MM-DD' },
            kinds: {
              type: 'array',
              items: { type: 'string', enum: ['founder', 'beneficiary', 'head', 'signer', 'registered_at', 'reg_neighbour'] },
              description: 'Типи зв\'язків, якими можна йти. Без фільтра — усі',
            },
            max_fanout: { type: 'integer', default: 50, minimum: 1, maximum: 200, description: 'Максимум зв\'язків одного вузла (1-200)' },
            max_paths: { type: 'integer', default: 5, minimum: 1, maximum: 20, description: 'Скільки найкоротших шляхів повернути (1-20)' },
            include_hubs: { type: 'boolean', default: false, description: 'Іти крізь хаби (масові адреси, номінальні особи)' },
            include_source_refs: { type: 'boolean', default: false, description: 'Повні посилання на вихідні записи (хеші записів історії ЄДР) у кожному ребрі' },
          },
          required: ['from', 'to'],
        },
      },
      {
        name: 'search_founders_history',
        description: `Зворотний пошук за засновником з урахуванням минулих знімків ЄДР

Знаходить юрособи, де особа чи компанія була або є засновником, зокрема колишніх засновників
(знімки 2016-2021 і щотижневі з 2026). Ім'я можна писати латиницею: «Scaramander Limited»
знаходить «СКАРАМАНДЕР ЛІМІТЕД». Фільтр за країною (ISO або українською). Пошук за кодом
ЄДРПОУ засновника — у яких юрособах ця компанія була засновником.
Збіг за ім'ям — лише наводка; збіг за кодом ЄДРПОУ — факт.
Потрібен хоча б один із параметрів query, code або country.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Назва компанії або ПІБ засновника, будь-якою мовою' },
            code: { type: 'string', description: 'Код ЄДРПОУ засновника-юрособи (замість query)' },
            country: { type: 'string', description: 'Країна: ISO-код (CY, GB, VG) або назва українською («Кіпр»)' },
            current_only: { type: 'boolean', description: 'Лише записи, що є в найновішому завантаженому знімку ЄДР (див. latest_snapshot у відповіді)' },
            limit: { type: 'integer', default: 50, minimum: 1, maximum: 200, description: 'Кількість результатів (1-200)' },
          },
        },
      },
      {
        name: 'search_beneficiaries_history',
        description: `Пошук кінцевих бенефіціарних власників з урахуванням минулих знімків ЄДР

Знаходить юрособи, де особа була або є КБВ (знімки 2016-2021 і щотижневі з 2026). ПІБ можна
писати латиницею: «John Jones» знаходить «ДЖОНС ДЖОН». Фільтр за країною громадянства.
Збіг за ім'ям — лише наводка, особу треба підтвердити.
Потрібен хоча б один із параметрів query або country.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'ПІБ бенефіціара, будь-якою мовою' },
            country: { type: 'string', description: 'Країна громадянства: ISO-код або назва українською' },
            current_only: { type: 'boolean', description: 'Лише записи, що є в найновішому завантаженому знімку ЄДР (див. latest_snapshot у відповіді)' },
            limit: { type: 'integer', default: 50, minimum: 1, maximum: 200, description: 'Кількість результатів (1-200)' },
          },
        },
      },
      {
        name: 'search_beneficiaries',
        description: `Пошук кінцевих бенефіціарних власників (контролерів) компаній

💰 Примерная стоимость: $0.002-$0.005 USD
Пошук бенефіціарів за ім'ям у всіх суб'єктах господарювання.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Ім\'я або частина імені бенефіціара',
            },
            limit: {
              type: 'number',
              default: 50,
              maximum: 100,
              minimum: 1,
              description: 'Максимальна кількість результатів (1-100)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_by_edrpou',
        description: `Швидкий пошук суб'єкта господарювання за кодом ЄДРПОУ

💰 Примерная стоимость: $0.001 USD
Отримання базової інформації про компанію за її ідентифікаційним кодом.`,
        inputSchema: {
          type: 'object',
          properties: {
            edrpou: {
              type: 'string',
              description: 'Код ЄДРПОУ (8 цифр)',
            },
          },
          required: ['edrpou'],
        },
      },
      {
        name: 'get_statistics',
        description: `Статистика по Єдиному державному реєстру

💰 Примерная стоимость: $0.001 USD
Загальна кількість юридичних осіб і ФОП у ЄДР (усього та діючих), а також громадських формувань за Реєстром громадських формувань Мін'юсту (з розбивкою за типом).`,
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_data_freshness',
        description: `Дата актуальності («дані станом на») кожного реєстру OpenReyestr: ЄДР, бенефіціари, боржники, виконавчі провадження, банкрутство, податковий борг, ЄСВ, єдиний податок, санкції РНБО, АРМА, ProZorro. Для джерел, які не оновлюються, повертає примітку.

💰 Примерная стоимость: $0.0001 USD`,
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'search_notaries',
        description: `Пошук нотаріусів у Єдиному реєстрі нотаріусів

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук нотаріусів за ім'ям, регіоном або статусом.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "Ім'я або частина імені нотаріуса" },
            region: { type: 'string', description: 'Регіон (наприклад, "Київська")' },
            status: { type: 'string', description: 'Статус діяльності' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_court_experts',
        description: `Пошук атестованих судових експертів

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук судових експертів за ім'ям, регіоном або типом експертизи.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "Ім'я або частина імені експерта" },
            region: { type: 'string', description: 'Регіон' },
            expertise_type: { type: 'string', description: 'Тип експертизи' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_arbitration_managers',
        description: `Пошук арбітражних керуючих (банкрутство)

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук арбітражних керуючих за ім'ям або статусом свідоцтва.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "Ім'я або частина імені арбітражного керуючого" },
            status: { type: 'string', description: 'Статус свідоцтва' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_debtors',
        description: `Пошук боржників у Єдиному реєстрі боржників

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук боржників за ім'ям/назвою, ЄДРПОУ або категорією стягнення.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "Ім'я/назва боржника або частина назви" },
            edrpou: { type: 'string', description: 'Код ЄДРПОУ боржника' },
            collection_category: { type: 'string', description: 'Категорія стягнення' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_enforcement_proceedings',
        description: `Пошук виконавчих проваджень

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук виконавчих проваджень за боржником, стягувачем або статусом.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "Ім'я/назва боржника" },
            debtor_edrpou: { type: 'string', description: 'ЄДРПОУ боржника' },
            creditor_name: { type: 'string', description: "Ім'я/назва стягувача" },
            proceeding_status: { type: 'string', description: 'Статус провадження' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_bankruptcy_cases',
        description: `Пошук справ про банкрутство

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук справ про банкрутство за боржником, ЄДРПОУ або номером справи.
Поля: procedure — процедура (ліквідація, розпорядження майном, санація…); case_status — стан провадження;
case_closure_ground — підстава закриття (ст. 90 КУзПБ); case_initiator — ініціатор справи (кредитор/заявник).
Джерело НАІС не містить ЄДРПОУ боржника і суду: debtor_edrpou заповнюється лише за точним і однозначним збігом назви з ЄДР
(debtor_edrpou_source = edr_exact_name_match), інакше null. Дати — YYYY-MM-DD.
⚠️ Набір НАІС на data.gov.ua не оновлюється з 31.05.2024: останній запис зареєстровано 30.05.2024, новіших справ у джерелі немає.
case_status у більшості записів порожній, бо в джерелі стан провадження «(Не визначено)»; підстава закриття (case_closure_ground) заповнена.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "Ім'я/назва боржника" },
            debtor_edrpou: { type: 'string', description: 'ЄДРПОУ боржника' },
            case_number: { type: 'string', description: 'Номер справи' },
            proceeding_status: { type: 'string', description: 'Статус провадження' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_special_forms',
        description: `Пошук спеціальних бланків нотаріальних документів

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук спеціальних бланків за серією, номером або отримувачем.
usage_date — дата операції з бланком; register_entry_date — дата внесення запису до витягу (не дата видачі).`,
        inputSchema: {
          type: 'object',
          properties: {
            series: { type: 'string', description: 'Серія бланка' },
            form_number: { type: 'string', description: 'Номер бланка' },
            recipient: { type: 'string', description: "Ім'я отримувача" },
            status: { type: 'string', description: 'Статус бланка: використаний, зіпсований, анульований, дефектний, відсутній, викрадений, втрачений' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_forensic_methods',
        description: `Пошук методик судових експертиз

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук зареєстрованих методик судових експертиз за назвою або типом експертизи.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Назва методики або ключове слово' },
            expertise_type: { type: 'string', description: 'Тип експертизи' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_legal_acts',
        description: `Пошук нормативно-правових актів у реєстрі НАІС

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук НПА за назвою, типом акту, видавником або статусом.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Назва або ключове слово в назві акту' },
            act_type: { type: 'string', description: 'Тип акту (закон, указ, постанова тощо)' },
            publisher: { type: 'string', description: 'Видавник акту' },
            status: { type: 'string', description: 'Статус акту (чинний, нечинний)' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_administrative_units',
        description: `Пошук адміністративно-територіальних одиниць (КОАТУУ)

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук населених пунктів, районів та областей за назвою або регіоном.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Назва населеного пункту або адмінодиниці' },
            region: { type: 'string', description: 'Область' },
            unit_type: { type: 'string', description: 'Тип одиниці (місто, село, селище, район тощо)' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_streets',
        description: `Пошук вулиць у реєстрі НАІС

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук вулиць за назвою, населеним пунктом або регіоном.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Назва вулиці або частина назви' },
            settlement: { type: 'string', description: 'Населений пункт' },
            region: { type: 'string', description: 'Область' },
            street_type: { type: 'string', description: 'Тип (вулиця, проспект, бульвар тощо)' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_street_renamings',
        description: `Пошук історії перейменувань вулиць України (дані OpenStreetMap)

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук за поточною або старою назвою вулиці. Показує всі попередні назви.
Джерело: OpenStreetMap (old_name теги).`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Назва вулиці (поточна або стара)' },
            min_renames: { type: 'number', default: 1, minimum: 1, maximum: 10, description: 'Мінімальна кількість перейменувань (2+ для вулиць з кількома перейменуваннями)' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_vat_payers',
        description: `Пошук у реєстрі платників ПДВ (ДПС)

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук за назвою компанії або кодом ПДВ. Дані станом на 23.02.2022.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Назва компанії або частина назви' },
            vat_code: { type: 'string', description: 'Код ПДВ' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1 },
            offset: { type: 'number', default: 0 },
          },
        },
      },
      {
        name: 'search_single_tax_payers',
        description: `Пошук у реєстрі платників єдиного податку (ДПС)

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук за назвою, ЄДРПОУ або групою єдиного податку.
Лише юридичні особи: ДПС не публікує податкові номери ФОП. Останній набір ДПС на data.gov.ua датований 23.02.2022.
activity_codes — коди КВЕД через кому; kved_version — одне зі значень "КВЕД-2005", "КВЕД-2010", "КВЕД-2005/2010" (є коди обох класифікаторів) або null (кодів немає); activity_codes_truncated = true, якщо ДПС обрізала перелік.
tin: 8-значний ЄДРПОУ шукається з провідними нулями і без них; 10-значний РНОКПП приймається як є, без змін.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Назва компанії' },
            tin: { type: ['string', 'number'], description: 'ЄДРПОУ (з провідними нулями або без них) або 10-значний РНОКПП (як є)' },
            tax_group: { type: 'string', description: 'Група єдиного податку (1, 2, 3, 4)' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1 },
            offset: { type: 'number', default: 0 },
          },
        },
      },
      {
        name: 'search_tax_debt',
        description: `Пошук у реєстрі податкового боргу (ДПС)

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук боржників за назвою або ІПН/ЄДРПОУ (знімок ДПС від 22.02.2022). Наявність запису = платник у переліку боржників. Суми в гривнях за платежем (tax_name): debt_total — до зведеного бюджету, з них debt_state_budget — до державного, debt_local_budget — до місцевого.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Назва компанії або ФОП' },
            tin: { type: 'string', description: 'ІПН або ЄДРПОУ' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1 },
            offset: { type: 'number', default: 0 },
          },
        },
      },
      {
        name: 'search_esv_debt',
        description: `Пошук у реєстрі боргу зі сплати ЄСВ

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук боржників зі сплати єдиного внеску за назвою або ІПН.
debt_amount_uah — сума боргу в гривнях; debt_amount_thousand_uah — як у джерелі ДПС (тис. грн).`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Назва компанії або ФОП' },
            tin: { type: 'string', description: 'ІПН або ЄДРПОУ' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1 },
            offset: { type: 'number', default: 0 },
          },
        },
      },
      {
        name: 'search_nazk_declarations',
        description: `Пошук декларацій у реєстрі НАЗК (Національне агентство з питань запобігання корупції)

💰 Примерная стоимость: $0.001-$0.005 USD
Пошук за ім'ям декларанта, місцем роботи, роком, типом, регіоном, доходом.`,
        inputSchema: {
          type: 'object',
          properties: {
            declarant_name: { type: 'string', description: 'Ім\'я декларанта' },
            declarant_workplace: { type: 'string', description: 'Місце роботи' },
            declaration_year: { type: 'number', description: 'Рік декларації' },
            declaration_type: { type: 'number', description: 'Тип: 1=щорічна, 2=перед звільненням, 3=після звільнення, 4=кандидата' },
            declarant_region: { type: 'string', description: 'Регіон' },
            min_income: { type: 'number', description: 'Мінімальний задекларований дохід (грн)' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1 },
            offset: { type: 'number', default: 0 },
          },
        },
      },
      {
        name: 'search_exchange_data',
        description: `Пошук у реєстрі обміну даними з державними органами

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук за номером запису суб'єкта, типом (UO/FOP/FSU), типом платника.`,
        inputSchema: {
          type: 'object',
          properties: {
            entity_record: { type: 'string', description: 'Номер запису суб\'єкта' },
            entity_type: { type: 'string', enum: ['UO', 'FOP', 'FSU'], description: 'Тип суб\'єкта' },
            tax_payer_type: { type: 'string', description: 'Тип платника' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1 },
            offset: { type: 'number', default: 0 },
          },
        },
      },
      {
        name: 'search_arma_seized_assets',
        description: `Пошук у реєстрі АРМА — активи, на які накладено арешт у кримінальних провадженнях (OpenReyestr, відкриті дані data.gov.ua)

💰 Примерная стоимость: $0.001-$0.005 USD
Один рядок = актив + рішення суду (+ захід АРМА, якщо був). Пошук за номером справи, номером ЄРДР, описом/типом активу, судом, регіоном, статусом.
status — стан заходу АРМА (null, якщо заходу не було); status_category — arrested/transferred/returned/sold/confiscated за рішенням суду та заходом (null, якщо жодне правило не підходить).
Відомостей про власника (ПІБ/назва, ЄДРПОУ) у відкритих даних немає — їх виключено згідно з абз. 9 ч. 1 ст. 25 Закону про АРМА. Запит з owner_name або owner_edrpou (навіть разом з іншими фільтрами) не виконується і повертає пояснення.
Регіон визначається за місцезнаходженням суду (для ВАКС та інших загальнодержавних судів — відсутній).`,
        inputSchema: {
          type: 'object',
          properties: {
            case_number: { type: 'string', description: 'Номер судової справи, напр. "991/1718/25" (збіг з будь-яким номером у полі «757/2732/19-к, 1-кс/757/1/19»); 17-значний номер теж шукається як ЄРДР' },
            criminal_proceeding_number: { type: 'string', description: 'Номер кримінального провадження в ЄРДР (17 цифр)' },
            asset_type: { type: 'string', description: 'Тип активу (підрядок): транспортний засіб, транспорт: залізничний вагон, транспорт: судно / повітряне судно, земельна ділянка, нерухоме майно, грошові кошти, цінні папери / корпоративні права, майнові права, техніка / електроніка, товарно-матеріальні цінності, зброя / боєприпаси, документи, інше. Також шукається в описі активу' },
            description: { type: 'string', description: 'Слова з опису/характеристик активу (марка, модель, адреса тощо), усі мають збігтися; не більше 10 слів' },
            status: { type: 'string', description: 'arrested (накладено арешт), transferred (передано в управління/на реалізацію), returned (арешт скасовано / повернуто власнику), sold (реалізовано), confiscated (стягнення в дохід держави / спецконфіскація); або українське значення стану заходу АРМА чи типу рішення, напр. "Передано для реалізації", "скасування арешту"' },
            court_name: { type: 'string', description: 'Назва суду (підрядок)' },
            region: { type: 'string', description: 'Регіон за місцезнаходженням суду: "Київ" (м. Київ і Київська область), "Одеська", "Львів", "Дніпро" тощо' },
            owner_name: { type: 'string', description: 'Не публікується у відкритих даних АРМА: запит з цим полем повертає пояснення без пошуку' },
            owner_edrpou: { type: 'string', description: 'Не публікується у відкритих даних АРМА: запит з цим полем повертає пояснення без пошуку' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1 },
            offset: { type: 'number', default: 0 },
          },
        },
      },
      {
        name: 'search_prozorro',
        description: `Пошук тендерів і договорів у системі ProZorro (публічні закупівлі)

💰 Примерная стоимость: $0.001-$0.005 USD
Пошук за назвою тендеру, замовником (ЄДРПОУ, назва), статусом, кодом CPV, датою, а також за переможцем/постачальником: ЄДРПОУ, назва, телефон або email постачальника.
Без фільтра постачальника повертає тендери з переможцями (winners: ЄДРПОУ, назва, сума договору). З фільтром постачальника повертає по рядку на договір: що виграла компанія, у яких замовників, на які суми, контакти постачальника. Спільний телефон або email у різних постачальників може вказувати на пов'язаність, але контакти в договорі часто вносить замовник, тож перевіряйте, чи збіг не обмежується одним замовником.
Тендери, переможці й договори за всю історію з 2015 року.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Назва або предмет закупівлі' },
            buyer_edrpou: { type: 'string', description: 'ЄДРПОУ замовника' },
            buyer_name: { type: 'string', description: 'Назва замовника' },
            supplier_edrpou: { type: 'string', description: 'ЄДРПОУ (або РНОКПП ФОП) переможця/постачальника' },
            supplier_name: { type: 'string', description: 'Частина назви постачальника' },
            supplier_phone: { type: 'string', description: 'Телефон постачальника у будь-якому форматі' },
            supplier_email: { type: 'string', description: 'Email постачальника' },
            status: { type: 'string', description: 'Статус тендеру (complete, active, cancelled, unsuccessful)' },
            cpv_code: { type: 'string', description: 'Код CPV або його початок (45 = будівельні роботи)' },
            date_from: { type: 'string', description: 'Дата створення тендеру від (YYYY-MM-DD)' },
            date_to: { type: 'string', description: 'Дата створення тендеру до (YYYY-MM-DD)' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1 },
            offset: { type: 'number', default: 0 },
          },
        },
      },
      {
        name: 'search_termination_started',
        description: `Пошук юридичних осіб, щодо яких розпочато процедуру припинення

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук за назвою/ЄДРПОУ, типом суб'єкта, підписантом або причиною припинення.
Назва і ЄДРПОУ беруться з ЄДР (юрособи та громадські формування) за номером запису.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Частина назви суб\'єкта або код ЄДРПОУ (лише цифри)' },
            entity_type: { type: 'string', description: 'Тип суб\'єкта: UO (юрособа) або FSU (громадське формування)' },
            signer_name: { type: 'string', description: 'Ім\'я підписанта' },
            reason: { type: 'string', description: 'Причина припинення' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
          required: ['query'],
        },
      },
      {
        name: 'search_inspection_plans',
        description: `Пошук у річних планах планових заходів державного нагляду (контролю) за суб'єктами господарювання

💰 Примерная стоимость: $0.001-$0.003 USD
Записи плану: назва суб'єкта, сфера нагляду, орган нагляду (ДСНС, Держпраці, Держпродспоживслужба, Держекоінспекція тощо), дата початку і тривалість перевірки в днях, рік плану.
Пошук за частиною назви, органом, сферою, роком плану, датою початку або за кодом ЄДРПОУ.
У планах немає коду ЄДРПОУ. За ЄДРПОУ повна назва юрособи береться з ЄДР і порівнюється з назвою в плані (без урахування регістру, лапок і пробілів); записи повертаються, лише якщо інших чинних юросіб з такою самою назвою в ЄДР немає, інакше відповідь позначено ambiguous з кількістю однойменних юросіб.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Частина назви суб\'єкта господарювання' },
            edrpou: { type: 'string', description: 'Код ЄДРПОУ юридичної особи (8 цифр): зіставлення за повною назвою з ЄДР' },
            supervisory_body: { type: 'string', description: 'Орган нагляду (частина назви, напр. "з питань праці")' },
            supervision_area: { type: 'string', description: 'Сфера нагляду (частина назви, напр. "пожежної безпеки")' },
            plan_year: { type: 'number', description: 'Рік плану' },
            date_from: { type: 'string', description: 'Дата початку перевірки від (YYYY-MM-DD)' },
            date_to: { type: 'string', description: 'Дата початку перевірки до (YYYY-MM-DD)' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
      {
        name: 'search_rnbo_sanctions',
        description: `Пошук у санкційних списках РНБО України

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук санкціонованих осіб/компаній/суден за ім'ям, псевдонімами, ідентифікаторами, типом або країною.
Джерело: Державний реєстр санкцій РНБО (drs.nsdc.gov.ua), знімок реєстру. sanctions = статус: active (діють), expired (строк сплив), excluded (виключено).
Дата внесення до списку в джерелі відсутня: listing_date = null, register_snapshot_date — дата знімка реєстру, а НЕ дата застосування санкцій.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Ім\'я або псевдонім особи/компанії' },
            schema_type: { type: 'string', description: 'Тип суб\'єкта: Person (фізична особа), Organization (юридична особа; синоніми Company, LegalEntity), Vessel (судно)' },
            country: { type: 'string', description: 'Країна' },
            identifier: { type: 'string', description: 'Ідентифікатор (ІПН, ЄДРПОУ, паспорт тощо)' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість результатів' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
          required: ['query'],
        },
      },
      {
        name: 'search_me_datasets',
        description: `Пошук датасетів Міністерства економіки України (Мінекономіки) з відкритих даних

💰 Примерная стоимость: $0.001 USD
Знайти релевантний набір серед датасетів Мінекономіки (реєстри інтелектуальної власності, ліцензіати, експортно-імпортні квоти, реекспорт, вартість авто, довідник підприємств, фінзвітність держсектору, індустріальні парки тощо). Повертає slug датасету — використайте його у search_me_records для пошуку рядків.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Ключові слова (напр. "ліцензіати", "сорти рослин", "вартість авто", "квоти")' },
            limit: { type: 'number', default: 30, maximum: 69, minimum: 1, description: 'Максимальна кількість датасетів' },
          },
        },
      },
      {
        name: 'search_me_records',
        description: `Пошук рядків усередині датасету Мінекономіки

💰 Примерная стоимость: $0.001 USD
Пошук у конкретному датасеті (за slug з search_me_datasets або за resource_id). Дані різнорідні (JSONB), тому датасет вказувати обовʼязково. Приклад: dataset="reiestr-industrialnikh-parkiv" query="Львів".`,
        inputSchema: {
          type: 'object',
          properties: {
            dataset: { type: 'string', description: 'Slug датасету (з search_me_datasets)' },
            resource_id: { type: 'number', description: 'ID конкретного ресурсу (альтернатива dataset)' },
            query: { type: 'string', description: 'Пошуковий рядок (шукається по всіх полях рядка)' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1, description: 'Максимальна кількість рядків' },
            offset: { type: 'number', default: 0, description: 'Зміщення для пагінації' },
          },
        },
      },
    ];
  }

  async handleToolCall(name: string, args: any): Promise<any> {
    logger.info('OpenReyestr tool call', { name, args });

    try {
      let result: any;

      switch (name) {
        case 'search_entities':
          result = await this.tools.searchEntities(args);
          break;
        case 'get_entity_details':
          result = await this.tools.getEntityDetails(args.record, args.entityType);
          break;
        case 'search_beneficiaries':
          result = await this.tools.searchBeneficiaries(args.query, args.limit);
          break;
        case 'search_founders':
          result = await this.tools.searchFounders(args);
          break;
        case 'company_as_of':
          result = await this.tools.companyAsOf(args.edrpou, args.date);
          break;
        case 'company_history':
          result = await this.tools.companyHistory(args.edrpou);
          break;
        case 'find_connections':
          result = await this.tools.findConnections(args);
          break;
        case 'connection_path':
          result = await this.tools.connectionPath(args);
          break;
        case 'search_founders_history':
          result = await this.tools.searchFoundersHistory(args);
          break;
        case 'search_beneficiaries_history':
          result = await this.tools.searchBeneficiariesHistory(args);
          break;
        case 'get_by_edrpou':
          result = await this.tools.getByEdrpou(args.edrpou);
          break;
        case 'get_statistics':
          result = await this.tools.getStatistics();
          break;
        case 'get_data_freshness':
          result = await this.tools.getDataFreshness();
          break;
        case 'search_notaries':
          result = await this.tools.searchNotaries(args);
          break;
        case 'search_court_experts':
          result = await this.tools.searchCourtExperts(args);
          break;
        case 'search_arbitration_managers':
          result = await this.tools.searchArbitrationManagers(args);
          break;
        case 'search_debtors':
          result = await this.tools.searchDebtors(args);
          break;
        case 'search_enforcement_proceedings':
          result = await this.tools.searchEnforcementProceedings(args);
          break;
        case 'search_bankruptcy_cases':
          result = await this.tools.searchBankruptcyCases(args);
          break;
        case 'search_special_forms':
          result = await this.tools.searchSpecialForms(args);
          break;
        case 'search_forensic_methods':
          result = await this.tools.searchForensicMethods(args);
          break;
        case 'search_legal_acts':
          result = await this.tools.searchLegalActs(args);
          break;
        case 'search_administrative_units':
          result = await this.tools.searchAdministrativeUnits(args);
          break;
        case 'search_streets':
          result = await this.tools.searchStreets(args);
          break;
        case 'search_street_renamings':
          result = await this.tools.searchStreetRenamings(args);
          break;
        case 'search_vat_payers':
          result = await this.tools.searchVatPayers(args);
          break;
        case 'search_single_tax_payers':
          result = await this.tools.searchSingleTaxPayers(args);
          break;
        case 'search_tax_debt':
          result = await this.tools.searchTaxDebt(args);
          break;
        case 'search_esv_debt':
          result = await this.tools.searchEsvDebt(args);
          break;
        case 'search_nazk_declarations':
          result = await this.tools.searchNazkDeclarations(args);
          break;
        case 'search_exchange_data':
          result = await this.tools.searchExchangeData(args);
          break;
        case 'search_arma_seized_assets':
          result = await this.tools.searchArmaSeizedAssets(args);
          break;
        case 'search_prozorro':
          result = await this.tools.searchProzorro(args);
          break;
        case 'search_termination_started':
          result = await this.tools.searchTerminationStarted(args);
          break;
        case 'search_inspection_plans':
          result = await this.tools.searchInspectionPlans(args);
          break;
        case 'search_rnbo_sanctions':
          result = await this.tools.searchRnboSanctions(args);
          break;
        case 'search_me_datasets':
          result = await this.tools.searchMeDatasets(args);
          break;
        case 'search_me_records':
          result = await this.tools.searchMeRecords(args);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      // Format response in MCP format
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      logger.error('OpenReyestr tool call error:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  // Stream support for future SSE implementation
  async handleToolCallWithStreaming(
    name: string,
    args: any,
    onEvent: StreamEventCallback
  ): Promise<void> {
    onEvent({ type: 'progress', data: { message: 'Processing...', progress: 0.3 } });

    const result = await this.handleToolCall(name, args);

    onEvent({ type: 'progress', data: { message: 'Finalizing...', progress: 0.9 } });
    onEvent({ type: 'complete', data: result, id: 'final' });
  }
}
