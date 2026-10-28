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
(debtor_edrpou_source = edr_exact_name_match), інакше null. Дати — YYYY-MM-DD.`,
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
Пошук спеціальних бланків за серією, номером або отримувачем.`,
        inputSchema: {
          type: 'object',
          properties: {
            series: { type: 'string', description: 'Серія бланка' },
            form_number: { type: 'string', description: 'Номер бланка' },
            recipient: { type: 'string', description: "Ім'я отримувача" },
            status: { type: 'string', description: 'Статус бланка' },
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
Пошук за назвою, ІПН або групою єдиного податку.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Назва ФОП/компанії' },
            tin: { type: 'string', description: 'ІПН або ЄДРПОУ' },
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
Пошук боржників за назвою або ІПН/ЄДРПОУ. Показує суму боргу, пені та штрафи.`,
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
Пошук боржників зі сплати єдиного внеску за назвою або ІПН.`,
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
        description: `Пошук у реєстрі АРМА — активи під арештом у кримінальних провадженнях (OpenReyestr)

💰 Примерная стоимость: $0.001-$0.005 USD
Пошук за власником, ЄДРПОУ, номером справи, типом активу, судом, статусом.`,
        inputSchema: {
          type: 'object',
          properties: {
            owner_name: { type: 'string', description: 'Ім\'я / назва власника' },
            owner_edrpou: { type: 'string', description: 'ЄДРПОУ власника' },
            case_number: { type: 'string', description: 'Номер кримінального провадження' },
            asset_type: { type: 'string', description: 'Тип активу' },
            status: { type: 'string', description: 'Статус (arrested, transferred, returned)' },
            court_name: { type: 'string', description: 'Назва суду' },
            region: { type: 'string', description: 'Регіон' },
            limit: { type: 'number', default: 50, maximum: 100, minimum: 1 },
            offset: { type: 'number', default: 0 },
          },
        },
      },
      {
        name: 'search_prozorro',
        description: `Пошук тендерів у системі ProZorro (публічні закупівлі)

💰 Примерная стоимость: $0.001-$0.005 USD
Пошук за назвою тендеру, ЄДРПОУ замовника, назвою замовника, статусом або кодом CPV. Тендери з 2015 року, дані синхронізуються з ProZorro.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Назва або предмет закупівлі' },
            buyer_edrpou: { type: 'string', description: 'ЄДРПОУ замовника' },
            buyer_name: { type: 'string', description: 'Назва замовника' },
            status: { type: 'string', description: 'Статус (complete, active, cancelled, unsuccessful)' },
            cpv_code: { type: 'string', description: 'Код CPV класифікатора' },
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
        name: 'search_rnbo_sanctions',
        description: `Пошук у санкційних списках РНБО України

💰 Примерная стоимость: $0.001-$0.003 USD
Пошук санкціонованих осіб/компаній за ім'ям, псевдонімами, ідентифікаторами, типом або країною.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Ім\'я або псевдонім особи/компанії' },
            schema_type: { type: 'string', description: 'Тип запису (Person, Company тощо)' },
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
        case 'get_by_edrpou':
          result = await this.tools.getByEdrpou(args.edrpou);
          break;
        case 'get_statistics':
          result = await this.tools.getStatistics();
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
