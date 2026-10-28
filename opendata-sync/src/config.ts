/**
 * Open Data Sync Configuration
 *
 * Defines all data sources, their sync frequencies, and target services.
 * Frequencies use node-cron syntax: second(opt) minute hour day month weekday
 */

export type SyncTarget = 'backend' | 'openreyestr' | 'echr';

export interface DataSourceSchedule {
  name: string;
  title: string;
  /** node-cron expression */
  cron: string;
  /** Which service handles the import */
  target: SyncTarget;
  /** For backend: source_name from import_source_catalog. For openreyestr: registry name */
  sourceName: string;
  /** Whether this source is enabled */
  enabled: boolean;
}

// ─── Backend data sources (import via /api/tools/start_import) ──────────

const backendDailySources: DataSourceSchedule[] = [
  {
    name: 'mvs_wanted_persons',
    title: 'МВС — Особи в розшуку',
    cron: '0 3 * * *', // 03:00 daily
    target: 'backend',
    sourceName: 'mvs_wanted_persons',
    enabled: true,
  },
  {
    name: 'mvs_missing_persons',
    title: 'МВС — Безвісно зниклі',
    cron: '0 3 * * *', // 03:00 daily
    target: 'backend',
    sourceName: 'mvs_missing_persons',
    enabled: true,
  },
  {
    name: 'mvs_wanted_vehicles',
    title: 'МВС — Транспорт у розшуку',
    cron: '0 3 * * *', // 03:00 daily
    target: 'backend',
    sourceName: 'mvs_wanted_vehicles',
    enabled: true,
  },
  {
    name: 'nazk_corruption',
    title: 'НАЗК — Корупціонери',
    cron: '30 3 * * *', // 03:30 daily
    target: 'backend',
    sourceName: 'nazk_corruption',
    enabled: true,
  },
  {
    name: 'invalid_passports',
    title: 'МВС — Недійсні паспорти',
    cron: '0 4 * * *', // 04:00 daily
    target: 'backend',
    sourceName: 'invalid_passports',
    enabled: true,
  },
  {
    name: 'invalid_passports_foreign',
    title: 'МВС — Недійсні закордонні паспорти',
    cron: '15 4 * * *', // 04:15 daily
    target: 'backend',
    sourceName: 'invalid_passports_foreign',
    enabled: true,
  },
  {
    name: 'nazk_corruption_offenders',
    title: 'НАЗК — Корупційні правопорушники',
    cron: '45 3 * * *', // 03:45 daily
    target: 'backend',
    sourceName: 'nazk_corruption_offenders',
    enabled: true,
  },
  {
    name: 'nazk_declaration_checks',
    title: 'НАЗК — Перевірки декларацій',
    cron: '0 6 * * *', // 06:00 daily
    target: 'backend',
    sourceName: 'nazk_declaration_checks',
    enabled: true,
  },
];

const backendWeeklySources: DataSourceSchedule[] = [
  {
    name: 'nipo_trademarks',
    title: 'УІПВ — Торгові марки',
    cron: '0 2 * * 0', // Sunday 02:00
    target: 'backend',
    sourceName: 'nipo_trademarks',
    enabled: true,
  },
  {
    name: 'nipo_patents',
    title: 'УІПВ — Патенти на винаходи',
    cron: '0 2 * * 0', // Sunday 02:00
    target: 'backend',
    sourceName: 'nipo_patents',
    enabled: true,
  },
  {
    name: 'nipo_utility_models',
    title: 'УІПВ — Корисні моделі',
    cron: '30 2 * * 0', // Sunday 02:30
    target: 'backend',
    sourceName: 'nipo_utility_models',
    enabled: true,
  },
  {
    name: 'nipo_designs',
    title: 'УІПВ — Промислові зразки',
    cron: '0 4 * * 0', // Sunday 04:00
    target: 'backend',
    sourceName: 'nipo_designs',
    enabled: true,
  },
  {
    name: 'dsfmu_terrorism',
    title: 'ДСФМУ — Перелік терористів',
    cron: '0 6 * * 0', // Sunday 06:00
    target: 'backend',
    sourceName: 'dsfmu_terrorism',
    enabled: true,
  },
  {
    name: 'lustration',
    title: 'Мін\'юст — Реєстр люстрованих',
    cron: '15 6 * * 0', // Sunday 06:15
    target: 'backend',
    sourceName: 'lustration',
    enabled: true,
  },
  {
    name: 'state_aid',
    title: 'АМКУ — Реєстр держдопомоги',
    cron: '30 6 * * 0', // Sunday 06:30
    target: 'backend',
    sourceName: 'state_aid',
    enabled: true,
  },
  {
    name: 'advocates',
    title: 'Мін\'юст — Реєстр адвокатів (ЄРАУ)',
    cron: '45 6 * * 0', // Sunday 06:45
    target: 'backend',
    sourceName: 'advocates',
    enabled: true,
  },
  {
    name: 'court_case_status',
    title: 'Судова влада — Стан розгляду справ',
    cron: '0 7 * * 0', // Sunday 07:00
    target: 'backend',
    sourceName: 'court_case_status',
    enabled: true,
  },
  {
    name: 'court_schedule',
    title: 'Судова влада — Розклад засідань',
    cron: '30 7 * * 0', // Sunday 07:30
    target: 'backend',
    sourceName: 'court_schedule',
    enabled: true,
  },
  {
    name: 'large_taxpayers',
    title: 'ДПС — Великі платники податків',
    cron: '0 8 * * 0', // Sunday 08:00
    target: 'backend',
    sourceName: 'large_taxpayers',
    enabled: true,
  },
  {
    name: 'wage_debtors',
    title: 'Держпраці — Боржники по зарплаті',
    cron: '15 8 * * 0', // Sunday 08:15
    target: 'backend',
    sourceName: 'wage_debtors',
    enabled: true,
  },
  {
    name: 'judge_candidates',
    title: 'ВККС — Кандидати на посади суддів',
    cron: '30 8 * * 0', // Sunday 08:30
    target: 'backend',
    sourceName: 'judge_candidates',
    enabled: true,
  },
  // ВРП registers (LEXAI-2117): full snapshot reload, a few hundred to ~3K rows each.
  {
    name: 'vrp_dismissed_judges',
    title: 'ВРП — Судді, звільнені за дисциплінарний проступок',
    cron: '45 8 * * 0', // Sunday 08:45
    target: 'backend',
    sourceName: 'vrp_dismissed_judges',
    enabled: true,
  },
  {
    name: 'vrp_suspended_judges',
    title: 'ВРП — Відсторонення суддів',
    cron: '50 8 * * 0', // Sunday 08:50
    target: 'backend',
    sourceName: 'vrp_suspended_judges',
    enabled: true,
  },
  {
    name: 'vrp_interference_reports',
    title: 'ВРП — Повідомлення суддів про втручання',
    cron: '55 8 * * 0', // Sunday 08:55
    target: 'backend',
    sourceName: 'vrp_interference_reports',
    enabled: true,
  },
];

// ─── OpenReyestr NAIS registries (sync via HTTP trigger) ────────────

const naisDailySources: DataSourceSchedule[] = [
  {
    name: 'nais_arbitration_managers',
    title: 'НАІС — Арбітражні керуючі',
    cron: '0 4 * * *', // 04:00 daily
    target: 'openreyestr',
    sourceName: 'arbitration_managers',
    enabled: true,
  },
  {
    name: 'nais_bankruptcy_cases',
    title: 'НАІС — Банкрутство',
    cron: '15 4 * * *', // 04:15 daily
    target: 'openreyestr',
    sourceName: 'bankruptcy_cases',
    enabled: true,
  },
  {
    name: 'nais_enforcement',
    title: 'НАІС — Виконавчі провадження (АСВП)',
    cron: '30 4 * * *', // 04:30 daily
    target: 'openreyestr',
    sourceName: 'enforcement_proceedings',
    enabled: true,
  },
  {
    name: 'nais_debtors',
    title: 'НАІС — Єдиний реєстр боржників',
    cron: '0 5 * * *', // 05:00 daily
    target: 'openreyestr',
    sourceName: 'debtors',
    enabled: true,
  },
];

const naisWeeklySources: DataSourceSchedule[] = [
  {
    name: 'nais_notaries',
    title: 'НАІС — Нотаріуси',
    cron: '0 2 * * 1', // Monday 02:00
    target: 'openreyestr',
    sourceName: 'notaries',
    enabled: true,
  },
  {
    name: 'nais_court_experts',
    title: 'НАІС — Судові експерти',
    cron: '15 2 * * 1', // Monday 02:15
    target: 'openreyestr',
    sourceName: 'court_experts',
    enabled: true,
  },
  {
    name: 'nais_special_forms',
    title: 'НАІС — Спеціальні бланки',
    cron: '30 2 * * 1', // Monday 02:30
    target: 'openreyestr',
    sourceName: 'special_forms',
    enabled: true,
  },
  {
    name: 'nais_forensic_methods',
    title: 'НАІС — Методики експертиз',
    cron: '45 2 * * 1', // Monday 02:45
    target: 'openreyestr',
    sourceName: 'forensic_methods',
    enabled: true,
  },
  {
    name: 'nais_legal_acts',
    title: 'НАІС — ЄДРНПА',
    cron: '0 3 * * 1', // Monday 03:00
    target: 'openreyestr',
    sourceName: 'legal_acts',
    enabled: true,
  },
  {
    name: 'nais_administrative_units',
    title: 'НАІС — Адмін. одиниці',
    cron: '30 3 * * 1', // Monday 03:30
    target: 'openreyestr',
    sourceName: 'administrative_units',
    enabled: true,
  },
  {
    name: 'nais_streets',
    title: 'НАІС — Вулиці',
    cron: '0 5 * * 1', // Monday 05:00
    target: 'openreyestr',
    sourceName: 'streets',
    enabled: true,
  },
];

// ─── OpenReyestr API feeds (incremental, sync via the same HTTP trigger) ──

const openreyestrFeedSources: DataSourceSchedule[] = [
  {
    // LEXAI-2089: import-prozorro.js resumes from its cursor (prozorro_sync_state),
    // upserts only, stops after PROZORRO_SYNC_MAX_MINUTES (default 180).
    name: 'prozorro_tenders',
    title: 'ProZorro — Тендери (інкрементально)',
    cron: '30 1 * * *', // 01:30 daily
    target: 'openreyestr',
    sourceName: 'prozorro',
    enabled: true,
  },
];

// ─── ECHR HUDOC data sources (weekly, all 47 CoE member states) ─────

const echrWeeklySources: DataSourceSchedule[] = [
  {
    name: 'echr_ukr',
    title: 'ЄСПЛ — Україна',
    cron: '0 22 * * 6', // Saturday 22:00
    target: 'echr' as SyncTarget,
    sourceName: 'UKR',
    enabled: true,
  },
  {
    name: 'echr_tur',
    title: 'ЄСПЛ — Туреччина',
    cron: '15 22 * * 6', // Saturday 22:15
    target: 'echr' as SyncTarget,
    sourceName: 'TUR',
    enabled: true,
  },
  {
    name: 'echr_rus',
    title: 'ЄСПЛ — Росія',
    cron: '30 22 * * 6', // Saturday 22:30
    target: 'echr' as SyncTarget,
    sourceName: 'RUS',
    enabled: true,
  },
  {
    name: 'echr_ita',
    title: 'ЄСПЛ — Італія',
    cron: '45 22 * * 6', // Saturday 22:45
    target: 'echr' as SyncTarget,
    sourceName: 'ITA',
    enabled: true,
  },
  {
    name: 'echr_rou',
    title: 'ЄСПЛ — Румунія',
    cron: '0 23 * * 6', // Saturday 23:00
    target: 'echr' as SyncTarget,
    sourceName: 'ROU',
    enabled: true,
  },
  {
    name: 'echr_pol',
    title: 'ЄСПЛ — Польща',
    cron: '15 23 * * 6', // Saturday 23:15
    target: 'echr' as SyncTarget,
    sourceName: 'POL',
    enabled: true,
  },
  {
    name: 'echr_grc',
    title: 'ЄСПЛ — Греція',
    cron: '30 23 * * 6', // Saturday 23:30
    target: 'echr' as SyncTarget,
    sourceName: 'GRC',
    enabled: true,
  },
  {
    name: 'echr_bgr',
    title: 'ЄСПЛ — Болгарія',
    cron: '45 23 * * 6', // Saturday 23:45
    target: 'echr' as SyncTarget,
    sourceName: 'BGR',
    enabled: true,
  },
  {
    name: 'echr_fra',
    title: 'ЄСПЛ — Франція',
    cron: '0 0 * * 0', // Sunday 00:00
    target: 'echr' as SyncTarget,
    sourceName: 'FRA',
    enabled: true,
  },
  {
    name: 'echr_hun',
    title: 'ЄСПЛ — Угорщина',
    cron: '15 0 * * 0', // Sunday 00:15
    target: 'echr' as SyncTarget,
    sourceName: 'HUN',
    enabled: true,
  },
  {
    name: 'echr_mda',
    title: 'ЄСПЛ — Молдова',
    cron: '30 0 * * 0', // Sunday 00:30
    target: 'echr' as SyncTarget,
    sourceName: 'MDA',
    enabled: true,
  },
  {
    name: 'echr_geo',
    title: 'ЄСПЛ — Грузія',
    cron: '45 0 * * 0', // Sunday 00:45
    target: 'echr' as SyncTarget,
    sourceName: 'GEO',
    enabled: true,
  },
  {
    name: 'echr_aze',
    title: 'ЄСПЛ — Азербайджан',
    cron: '0 1 * * 0', // Sunday 01:00
    target: 'echr' as SyncTarget,
    sourceName: 'AZE',
    enabled: true,
  },
  {
    name: 'echr_arm',
    title: 'ЄСПЛ — Вірменія',
    cron: '15 1 * * 0', // Sunday 01:15
    target: 'echr' as SyncTarget,
    sourceName: 'ARM',
    enabled: true,
  },
  {
    name: 'echr_hrv',
    title: 'ЄСПЛ — Хорватія',
    cron: '30 1 * * 0', // Sunday 01:30
    target: 'echr' as SyncTarget,
    sourceName: 'HRV',
    enabled: true,
  },
  {
    name: 'echr_srb',
    title: 'ЄСПЛ — Сербія',
    cron: '45 1 * * 0', // Sunday 01:45
    target: 'echr' as SyncTarget,
    sourceName: 'SRB',
    enabled: true,
  },
  {
    name: 'echr_bih',
    title: 'ЄСПЛ — Боснія і Герцеговина',
    cron: '0 2 * * 0', // Sunday 02:00
    target: 'echr' as SyncTarget,
    sourceName: 'BIH',
    enabled: true,
  },
  {
    name: 'echr_mkd',
    title: 'ЄСПЛ — Північна Македонія',
    cron: '15 2 * * 0', // Sunday 02:15
    target: 'echr' as SyncTarget,
    sourceName: 'MKD',
    enabled: true,
  },
  {
    name: 'echr_alb',
    title: 'ЄСПЛ — Албанія',
    cron: '30 2 * * 0', // Sunday 02:30
    target: 'echr' as SyncTarget,
    sourceName: 'ALB',
    enabled: true,
  },
  {
    name: 'echr_gbr',
    title: 'ЄСПЛ — Велика Британія',
    cron: '45 2 * * 0', // Sunday 02:45
    target: 'echr' as SyncTarget,
    sourceName: 'GBR',
    enabled: true,
  },
  {
    name: 'echr_deu',
    title: 'ЄСПЛ — Німеччина',
    cron: '0 3 * * 0', // Sunday 03:00
    target: 'echr' as SyncTarget,
    sourceName: 'DEU',
    enabled: true,
  },
  {
    name: 'echr_esp',
    title: 'ЄСПЛ — Іспанія',
    cron: '15 3 * * 0', // Sunday 03:15
    target: 'echr' as SyncTarget,
    sourceName: 'ESP',
    enabled: true,
  },
  {
    name: 'echr_prt',
    title: 'ЄСПЛ — Португалія',
    cron: '30 3 * * 0', // Sunday 03:30
    target: 'echr' as SyncTarget,
    sourceName: 'PRT',
    enabled: true,
  },
  {
    name: 'echr_aut',
    title: 'ЄСПЛ — Австрія',
    cron: '45 3 * * 0', // Sunday 03:45
    target: 'echr' as SyncTarget,
    sourceName: 'AUT',
    enabled: true,
  },
  {
    name: 'echr_cze',
    title: 'ЄСПЛ — Чехія',
    cron: '0 4 * * 0', // Sunday 04:00
    target: 'echr' as SyncTarget,
    sourceName: 'CZE',
    enabled: true,
  },
  {
    name: 'echr_svk',
    title: 'ЄСПЛ — Словаччина',
    cron: '15 4 * * 0', // Sunday 04:15
    target: 'echr' as SyncTarget,
    sourceName: 'SVK',
    enabled: true,
  },
  {
    name: 'echr_ltu',
    title: 'ЄСПЛ — Литва',
    cron: '30 4 * * 0', // Sunday 04:30
    target: 'echr' as SyncTarget,
    sourceName: 'LTU',
    enabled: true,
  },
  {
    name: 'echr_lva',
    title: 'ЄСПЛ — Латвія',
    cron: '45 4 * * 0', // Sunday 04:45
    target: 'echr' as SyncTarget,
    sourceName: 'LVA',
    enabled: true,
  },
  {
    name: 'echr_est',
    title: 'ЄСПЛ — Естонія',
    cron: '0 5 * * 0', // Sunday 05:00
    target: 'echr' as SyncTarget,
    sourceName: 'EST',
    enabled: true,
  },
  {
    name: 'echr_svn',
    title: 'ЄСПЛ — Словенія',
    cron: '15 5 * * 0', // Sunday 05:15
    target: 'echr' as SyncTarget,
    sourceName: 'SVN',
    enabled: true,
  },
  {
    name: 'echr_bel',
    title: 'ЄСПЛ — Бельгія',
    cron: '30 5 * * 0', // Sunday 05:30
    target: 'echr' as SyncTarget,
    sourceName: 'BEL',
    enabled: true,
  },
  {
    name: 'echr_nld',
    title: 'ЄСПЛ — Нідерланди',
    cron: '45 5 * * 0', // Sunday 05:45
    target: 'echr' as SyncTarget,
    sourceName: 'NLD',
    enabled: true,
  },
  {
    name: 'echr_fin',
    title: 'ЄСПЛ — Фінляндія',
    cron: '0 6 * * 0', // Sunday 06:00
    target: 'echr' as SyncTarget,
    sourceName: 'FIN',
    enabled: true,
  },
  {
    name: 'echr_swe',
    title: 'ЄСПЛ — Швеція',
    cron: '15 6 * * 0', // Sunday 06:15
    target: 'echr' as SyncTarget,
    sourceName: 'SWE',
    enabled: true,
  },
  {
    name: 'echr_nor',
    title: 'ЄСПЛ — Норвегія',
    cron: '30 6 * * 0', // Sunday 06:30
    target: 'echr' as SyncTarget,
    sourceName: 'NOR',
    enabled: true,
  },
  {
    name: 'echr_che',
    title: 'ЄСПЛ — Швейцарія',
    cron: '45 6 * * 0', // Sunday 06:45
    target: 'echr' as SyncTarget,
    sourceName: 'CHE',
    enabled: true,
  },
  {
    name: 'echr_dnk',
    title: 'ЄСПЛ — Данія',
    cron: '0 7 * * 0', // Sunday 07:00
    target: 'echr' as SyncTarget,
    sourceName: 'DNK',
    enabled: true,
  },
  {
    name: 'echr_irl',
    title: 'ЄСПЛ — Ірландія',
    cron: '15 7 * * 0', // Sunday 07:15
    target: 'echr' as SyncTarget,
    sourceName: 'IRL',
    enabled: true,
  },
  {
    name: 'echr_cyp',
    title: 'ЄСПЛ — Кіпр',
    cron: '30 7 * * 0', // Sunday 07:30
    target: 'echr' as SyncTarget,
    sourceName: 'CYP',
    enabled: true,
  },
  {
    name: 'echr_mne',
    title: 'ЄСПЛ — Чорногорія',
    cron: '45 7 * * 0', // Sunday 07:45
    target: 'echr' as SyncTarget,
    sourceName: 'MNE',
    enabled: true,
  },
  {
    name: 'echr_lux',
    title: 'ЄСПЛ — Люксембург',
    cron: '0 8 * * 0', // Sunday 08:00
    target: 'echr' as SyncTarget,
    sourceName: 'LUX',
    enabled: true,
  },
  {
    name: 'echr_mlt',
    title: 'ЄСПЛ — Мальта',
    cron: '15 8 * * 0', // Sunday 08:15
    target: 'echr' as SyncTarget,
    sourceName: 'MLT',
    enabled: true,
  },
  {
    name: 'echr_isl',
    title: 'ЄСПЛ — Ісландія',
    cron: '30 8 * * 0', // Sunday 08:30
    target: 'echr' as SyncTarget,
    sourceName: 'ISL',
    enabled: true,
  },
  {
    name: 'echr_and',
    title: 'ЄСПЛ — Андорра',
    cron: '45 8 * * 0', // Sunday 08:45
    target: 'echr' as SyncTarget,
    sourceName: 'AND',
    enabled: true,
  },
  {
    name: 'echr_lie',
    title: 'ЄСПЛ — Ліхтенштейн',
    cron: '0 9 * * 0', // Sunday 09:00
    target: 'echr' as SyncTarget,
    sourceName: 'LIE',
    enabled: true,
  },
  {
    name: 'echr_mco',
    title: 'ЄСПЛ — Монако',
    cron: '15 9 * * 0', // Sunday 09:15
    target: 'echr' as SyncTarget,
    sourceName: 'MCO',
    enabled: true,
  },
  {
    name: 'echr_smr',
    title: 'ЄСПЛ — Сан-Марино',
    cron: '30 9 * * 0', // Sunday 09:30
    target: 'echr' as SyncTarget,
    sourceName: 'SMR',
    enabled: true,
  },
];

// ─── All sources ───────────────────────────────────────────────────

export const ALL_SOURCES: DataSourceSchedule[] = [
  ...backendDailySources,
  ...backendWeeklySources,
  ...naisDailySources,
  ...naisWeeklySources,
  ...openreyestrFeedSources,
  ...echrWeeklySources,
];

// ─── Environment config ────────────────────────────────────────────

export interface ServiceConfig {
  backendUrl: string;
  backendApiKey: string;
  openreyestrUrl: string;
  openreyestrApiKey: string;
  healthPort: number;
  timezone: string;
}

export function loadConfig(): ServiceConfig {
  return {
    backendUrl: process.env.BACKEND_URL || 'http://app-prod:3000',
    backendApiKey: process.env.BACKEND_API_KEY || '',
    openreyestrUrl: process.env.OPENREYESTR_URL || 'http://app-openreyestr-prod:3005',
    openreyestrApiKey: process.env.OPENREYESTR_API_KEY || '',
    healthPort: parseInt(process.env.HEALTH_PORT || '3010', 10),
    timezone: process.env.TZ || 'Europe/Kiev',
  };
}
