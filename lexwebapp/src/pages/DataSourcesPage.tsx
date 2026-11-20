/**
 * Data Sources Page — Platform Database Catalog
 * Comprehensive listing of ALL databases in the LEX AI platform with real sample data,
 * record counts, update frequencies, and data structure previews.
 */

import { useState } from 'react';
import {
  ArrowLeft,
  ExternalLink,
  Scale,
  BookOpen,
  FileText,
  Building2,
  Database,
  Shield,
  Globe,
  Check,
  Clock,
  HardDrive,
} from 'lucide-react';
import { useDocumentMeta } from '../hooks/useDocumentMeta';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SourceStatus = 'in_db' | 'live_api' | 'coming_soon';

interface SampleData {
  fields: string[];
  record: Record<string, string | number | string[] | number[]>;
}

interface DataSource {
  id: string;
  name: string;
  nameUa: string;
  description: string;
  sourceUrl: string;
  status: SourceStatus;
  recordCount: string;
  updateFrequency: string;
  sample: SampleData;
  note?: string;
}

interface Category {
  title: string;
  titleUa: string;
  icon: React.ReactNode;
  sources: DataSource[];
}

// ---------------------------------------------------------------------------
// Jurisdiction navigation
// ---------------------------------------------------------------------------

const jurisdictions = [
  { flag: '\u{1F1FA}\u{1F1E6}', label: 'Ukraine', path: '/ua/data-sources' },
  { flag: '\u{1F1FA}\u{1F1F8}', label: 'US', path: '/us/data-sources' },
  { flag: '\u{1F1EC}\u{1F1E7}', label: 'UK', path: '/uk/data-sources' },
  { flag: '\u{1F1E9}\u{1F1EA}', label: 'Germany', path: '/de/data-sources' },
  { flag: '\u{1F1EB}\u{1F1F7}', label: 'France', path: '/fr/data-sources' },
  { flag: '\u{1F1F3}\u{1F1F1}', label: 'Netherlands', path: '/nl/data-sources' },
  { flag: '\u{1F1EA}\u{1F1EA}', label: 'Estonia', path: '/ee/data-sources' },
];

// ---------------------------------------------------------------------------
// Status badge helpers
// ---------------------------------------------------------------------------

function statusLabel(s: SourceStatus): string {
  switch (s) {
    case 'in_db':
      return 'In our DB';
    case 'live_api':
      return 'Live API';
    case 'coming_soon':
      return 'Coming soon';
  }
}

function statusClasses(s: SourceStatus): string {
  switch (s) {
    case 'in_db':
      return 'bg-purple-50 text-purple-700 border-purple-200';
    case 'live_api':
      return 'bg-green-50 text-green-700 border-green-200';
    case 'coming_soon':
      return 'bg-gray-50 text-gray-500 border-gray-200';
  }
}

function statusIcon(s: SourceStatus) {
  switch (s) {
    case 'in_db':
      return <HardDrive className="w-3 h-3" />;
    case 'live_api':
      return <Check className="w-3 h-3" />;
    case 'coming_soon':
      return <Clock className="w-3 h-3" />;
  }
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const categories: Category[] = [
  {
    title: 'Courts & Case Law',
    titleUa: 'Суди та судова практика',
    icon: <Scale className="w-5 h-5" />,
    sources: [
      {
        id: 'edrsr',
        name: 'EDRSR — Court Decisions Registry',
        nameUa: 'Єдиний державний реєстр судових рішень',
        description:
          'Full-text indexed and vectorized court decisions from all Ukrainian courts since 2006. Supports semantic search, citation graph analysis, and judge-level analytics.',
        sourceUrl: 'https://reyestr.court.gov.ua',
        status: 'in_db',
        recordCount: '39,061,902+',
        updateFrequency: 'Daily',
        sample: {
          fields: [
            'doc_id',
            'cause_num',
            'judge',
            'court_name',
            'justice_kind_name',
            'judgment_form',
            'adjudication_date',
            'external_url',
          ],
          record: {
            doc_id: 92121444,
            cause_num: '0528/9924/2012',
            judge: 'Нейло I. М.',
            court_name:
              'Краматорський міський суд Донецької області',
            justice_kind_name: 'Цивільне',
            judgment_form: 'Судовий наказ',
            adjudication_date: '2012-10-15',
            external_url: 'https://reyestr.court.gov.ua/Review/92121444',
          },
        },
      },
      {
        id: 'court-sessions',
        name: 'Court Sessions Schedule',
        nameUa: 'Розклад судових засідань',
        description:
          'Upcoming and historical court hearing schedules across all Ukrainian courts. Includes judge assignments, courtroom numbers, and involved parties.',
        sourceUrl: 'https://court.gov.ua',
        status: 'in_db',
        recordCount: '481,000+',
        updateFrequency: 'Daily',
        sample: {
          fields: [
            'hearing_date',
            'court_name',
            'case_number',
            'judges',
            'court_room',
            'case_involved',
            'case_description',
          ],
          record: {
            hearing_date: '31.10.2025 15:45',
            court_name:
              'Бориспільський міськрайонний суд Київської області',
            case_number: '359/7029/24',
            judges:
              'Головуючий суддя: Борець Є.О.',
            court_room: '3',
            case_involved:
              'Позивач: ПАТ "КБ ПриватБанк"',
            case_description:
              'Цивільні справи',
          },
        },
      },
      {
        id: 'judges',
        name: 'Judges Registry',
        nameUa: 'Реєстр суддів',
        description:
          'Comprehensive profiles of Ukrainian judges with historical snapshots, court assignments, and career progression tracking.',
        sourceUrl: 'https://court.gov.ua',
        status: 'in_db',
        recordCount: '6,000 active + 417,000 snapshots',
        updateFrequency: 'Monthly',
        sample: {
          fields: [
            'dossier_number',
            'full_name',
            'gender',
            'court_name',
            'first_seen',
            'last_seen',
            'snapshot_count',
          ],
          record: {
            dossier_number: '02937',
            full_name:
              'Іваненко Ігор Володимирович',
            gender: 'male',
            court_name:
              'Касаційний кримінальний суд Верховного Суду',
            first_seen: '2019-03-12',
            last_seen: '2025-10-01',
            snapshot_count: 47,
          },
        },
      },
      {
        id: 'vkks',
        name: 'VKKS — Qualification Commission',
        nameUa:
          'Вища кваліфікаційна комісія суддів',
        description:
          'Judicial qualification data across 5 categories: judges registry, evaluations, asset declarations, court vacancies, and efficiency reports.',
        sourceUrl: 'https://vkksu.gov.ua',
        status: 'in_db',
        recordCount: '24,600 across 5 categories',
        updateFrequency: 'Monthly',
        note: 'Judges 4.7K, evaluations 3.4K, declarations 4.8K, vacancies 1K, efficiency 10.7K',
        sample: {
          fields: [
            'id',
            'dossier_number',
            'full_name',
            'gender',
            'court_name',
            'source_date',
          ],
          record: {
            id: 1247,
            dossier_number: '02937',
            full_name:
              'Іваненко Ігор Володимирович',
            gender: 'male',
            court_name:
              'Касаційний кримінальний суд ВС',
            source_date: '2025-08-15',
          },
        },
      },
      {
        id: 'vrp',
        name: 'VRP — Judges Discipline',
        nameUa:
          'Вища рада правосуддя',
        description:
          'Disciplinary proceedings against judges: dismissals, suspensions, and interference complaints filed through the High Council of Justice.',
        sourceUrl: 'https://vrp.court.gov.ua',
        status: 'in_db',
        recordCount: '738',
        updateFrequency: 'Quarterly',
        note: 'Dismissed 59, suspended 236, interference 443',
        sample: {
          fields: [
            'type',
            'judge_name',
            'court_name',
            'applicant',
            'reporter',
            'panel_decision_date',
            'vrp_decision_date_num',
          ],
          record: {
            type: 'dismissed',
            judge_name:
              'Петренко О.В.',
            court_name:
              'Золотоніський міськрайонний суд Черкаської області',
            applicant:
              'Голова суду',
            reporter:
              'Член ВРП Іванов М.П.',
            panel_decision_date: '2024-05-20',
            vrp_decision_date_num: '1234/0/15-24',
          },
        },
      },
    ],
  },
  {
    title: 'Legislation',
    titleUa: 'Законодавство',
    icon: <BookOpen className="w-5 h-5" />,
    sources: [
      {
        id: 'legislation-articles',
        name: 'Legislation Articles (Verkhovna Rada)',
        nameUa:
          'Статті законодавства (Верховна Рада)',
        description:
          'Vectorized articles from all major codes and the Constitution of Ukraine. Enables semantic search across legislation with article-level granularity.',
        sourceUrl: 'https://zakon.rada.gov.ua',
        status: 'in_db',
        recordCount: 'All major codes + Constitution',
        updateFrequency: 'Weekly',
        sample: {
          fields: [
            'rada_id',
            'article_number',
            'title',
            'full_text',
            'npa_title',
            'section_number',
            'url',
          ],
          record: {
            rada_id: '254к/96-ВР',
            article_number: 160,
            title:
              'Набуття чинності',
            full_text:
              'Конституція України набуває чинності з дня її прийняття.',
            npa_title:
              'Конституція України',
            section_number: 'XV',
            url: 'https://zakon.rada.gov.ua/laws/show/254%D0%BA/96-%D0%B2%D1%80',
          },
        },
      },
      {
        id: 'edrnpa',
        name: 'EDRNPA — Legal Acts Registry',
        nameUa:
          'Єдиний державний реєстр нормативно-правових актів',
        description:
          'Registry of normative legal acts from all branches of government. Covers constitutions, laws, presidential decrees, cabinet resolutions, and ministerial orders.',
        sourceUrl: 'https://dkrs.gov.ua',
        status: 'in_db',
        recordCount: '141,000',
        updateFrequency: 'Monthly',
        sample: {
          fields: [
            'id',
            'publisher',
            'doc_type',
            'date_acc',
            'number',
            'name',
            'status',
            'reestr_date',
            'keywords',
          ],
          record: {
            id: 68165,
            publisher:
              'Президія Надзвичайного XIV З\'їзду Рад УРСР',
            doc_type:
              'Конституція УРСР',
            date_acc: '30.01.1937',
            number: '',
            name: 'Конституція (Основний Закон) Української Радянської Соціалістичної Республіки',
            status: 'Чинний',
            reestr_date: '2003-07-01',
            keywords:
              'конституція, УРСР, основний закон',
          },
        },
      },
    ],
  },
  {
    title: 'Business & Finance',
    titleUa:
      'Бізнес та фінанси',
    icon: <Building2 className="w-5 h-5" />,
    sources: [
      {
        id: 'openreyestr',
        name: 'Business Registry (EDR via OpenReyestr + 30 registries via search_registry)',
        nameUa:
          'Бізнес-реєстри: ЄДР через OpenReyestr і 30 реєстрів через search_registry',
        description:
          'Aggregated data from the Unified State Register of legal entities (EDR) and 30 open-data registries via search_registry: sanctions lists, the NAZK register of corruption offenders, lawyers and law firms, trademarks, patents, court experts, VAT payers, NBU banks, financial statements, ЄДЕССБ, AMCU decisions, and more.',
        sourceUrl: 'https://data.gov.ua',
        status: 'in_db',
        recordCount: '16.7M+ legal entities + 30 registries',
        updateFrequency: 'Daily–Monthly (varies)',
        note: 'public_organizations, case_distribution, missing_persons, securities_owners, wanted_persons, wanted_vehicles, court_experts, vat_payers, sanctions, trademarks, patents, corruption_register (НАЗК, реєстр корупційних правопорушників), lawyers, law_firms, bankruptcy_announcements, judge_candidates, vrp_decisions, declaration_checks, wage_debtors, large_taxpayers, vehicle_registrations, lustration, state_aid, financial_statements, nbu_banks, construction_documents, nazk_war_sanctions, amcu_bid_rigging, amcu_decisions, rada_stenograms',
        sample: {
          fields: [
            'id',
            'schema',
            'name',
            'birth_date',
            'datasets',
            'countries',
            'aliases',
          ],
          record: {
            id: 'Q7747',
            schema: 'Person',
            name: 'Vladimir Putin',
            birth_date: '1952-10-07',
            datasets: '26 (EU FSF, US OFAC SDN, UK FCDO, etc.)',
            countries: 'RU',
            aliases: '100+ transliterations',
          },
        },
      },
      {
        id: 'spending',
        name: 'Public Spending (spending.gov.ua)',
        nameUa:
          'Публічні витрати (spending.gov.ua)',
        description:
          'Government spending transparency data covering payment acts, contract addendums, penalties, and contracts from state and municipal budgets.',
        sourceUrl: 'https://spending.gov.ua',
        status: 'in_db',
        recordCount: '12,600,000+',
        updateFrequency: 'Daily',
        note: 'Acts 9.45M, addendums 2.11M, penalties 40K, contracts 2.8K',
        sample: {
          fields: [
            'id',
            'edrpou',
            'document_number',
            'document_date',
            'amount',
            'currency',
            'contractors',
            'doc_type',
            'amount_uah',
          ],
          record: {
            id: 2621230139,
            edrpou: '05506690',
            document_number: 'А-2621230139',
            document_date: '2025-03-15',
            amount_uah: 7780.33,
            currency: 'UAH',
            doc_type: 'act',
            contractors:
              'ТОВ "Газопостачальна компанія Нафтогаз Трейдинг"',
          },
        },
      },
    ],
  },
  {
    title: 'Security & Compliance',
    titleUa:
      'Безпека та комплаєнс',
    icon: <Shield className="w-5 h-5" />,
    sources: [
      {
        id: 'invalid-passports',
        name: 'Invalid Passports (MVS)',
        nameUa:
          'Недійсні паспорти (МВС)',
        description:
          'Registry of lost, stolen, and invalidated Ukrainian passports — both internal (citizen ID) and foreign (travel) passports. Essential for KYC/AML verification.',
        sourceUrl: 'https://mvs.gov.ua',
        status: 'in_db',
        recordCount: '2,900,000 internal + 195,000 foreign',
        updateFrequency: 'Weekly',
        sample: {
          fields: [
            'id',
            'd_series',
            'd_number',
            'd_type',
            'd_status',
            'ovd',
            'theft_date',
            'insert_date',
            'passport_type',
          ],
          record: {
            id: '0101_EA_842532',
            d_series: 'EA',
            d_number: '842532',
            d_type:
              'ПАСПОРТ ГРОМАДЯНИНА УКРАЇНИ',
            d_status: 'ВТРАЧЕНО',
            ovd: 'Октябрський РВ ХМУ УМВС',
            theft_date: '',
            insert_date: '2015-06-22',
            passport_type: 'internal',
          },
        },
      },
      {
        id: 'terrorism-list',
        name: 'Terrorism List (DSFMU)',
        nameUa:
          'Перелік терористів (ДСФМУ)',
        description:
          'Active terrorism and AML screening list maintained by the State Financial Monitoring Service. Used for compliance checks and sanctions screening.',
        sourceUrl: 'https://fiu.gov.ua',
        status: 'in_db',
        recordCount: 'Active list',
        updateFrequency: 'As published',
        sample: {
          fields: [
            'entity_type',
            'name_ua',
            'name_en',
            'head_name_ua',
            'org_country',
            'report_date',
            'report_num',
          ],
          record: {
            entity_type: 'organization',
            name_ua:
              '80-й окремий гвардійський розвідувальний батальйон "Спарта"',
            name_en: '80th Separate Guards Reconnaissance Battalion "Sparta"',
            head_name_ua:
              'Жога Артем Володимирович',
            org_country: 'UA (occupied territory)',
            report_date: '2023-11-15',
            report_num: '234/2023',
          },
        },
      },
      {
        id: 'sanctions',
        name: 'International Sanctions (26 datasets)',
        nameUa:
          'Міжнародні санкції (26 джерел)',
        description:
          'Cross-referenced sanctions data aggregated from 26 international lists including EU, US OFAC, UK FCDO, Australian, Canadian, Swiss SECO, Japan MoF, and Ukraine NSDC.',
        sourceUrl: 'https://opensanctions.org',
        status: 'in_db',
        recordCount: '26 international lists',
        updateFrequency: 'Daily (aggregated)',
        sample: {
          fields: [
            'id',
            'schema',
            'name',
            'birth_date',
            'datasets',
            'aliases',
          ],
          record: {
            id: 'Q7747',
            schema: 'Person',
            name: 'Vladimir Putin',
            birth_date: '1952-10-07',
            datasets: '26 lists (EU FSF, US OFAC SDN, UK FCDO, AU, CA, CH SECO, JP MoF, UA NSDC)',
            aliases: '100+ transliterations across scripts',
          },
        },
      },
    ],
  },
  {
    title: 'ECHR & International',
    titleUa:
      'ЄСПЛ та міжнародне',
    icon: <Globe className="w-5 h-5" />,
    sources: [
      {
        id: 'echr',
        name: 'ECHR Practice',
        nameUa:
          'Практика ЄСПЛ',
        description:
          'European Court of Human Rights case law, imported directly from HUDOC. Judgments and decisions from 1998 to present, with full text, violated articles, conclusions and ECLI identifiers. Includes 11,247 cases against Ukraine.',
        sourceUrl: 'https://hudoc.echr.coe.int',
        status: 'in_db',
        recordCount: '209,774 cases (175,978 with full text)',
        updateFrequency: 'Monthly',
        note: 'Imported from HUDOC. 84% full-text coverage; remaining records are metadata-only in the source.',
        sample: {
          fields: [
            'app_no',
            'doc_name',
            'judgment_date',
            'article',
            'conclusion',
            'respondent',
            'importance',
            'ecli',
          ],
          record: {
            app_no: '11103/18',
            doc_name: 'CASE OF PETRYK v. UKRAINE',
            judgment_date: '2026-03-12',
            article: '2;2-1',
            conclusion:
              'Violation of Article 2 - Right to life (Article 2-1 - Effective investigation) (Procedural aspect)',
            respondent: 'UKR',
            importance: '4',
            ecli: 'ECLI:CE:ECHR:2026:0312JUD001110318',
          },
        },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Hero stats
// ---------------------------------------------------------------------------

const heroStats = [
  { label: 'Data Sources', value: '13', color: 'bg-blue-50 text-blue-700' },
  { label: 'Total Records', value: '70M+', color: 'bg-purple-50 text-purple-700' },
  { label: 'Registries', value: '30', color: 'bg-green-50 text-green-700' },
  { label: 'Daily Updates', value: 'Yes', color: 'bg-amber-50 text-amber-700' },
];

// ---------------------------------------------------------------------------
// Collapsible sample data component
// ---------------------------------------------------------------------------

function SampleDataPreview({ sample, sourceId }: { sample: SampleData; sourceId: string }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="mt-3 border-t border-gray-100 pt-3">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 text-xs text-purple-600 hover:text-purple-700 transition-colors font-medium cursor-pointer"
        aria-expanded={isOpen}
        aria-controls={`sample-${sourceId}`}
      >
        <Database className="w-3 h-3" />
        <span>Sample data & structure</span>
        <span
          className={`inline-block transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}
        >
          &rarr;
        </span>
      </button>
      {isOpen && (
        <div id={`sample-${sourceId}`} className="mt-2">
          <div className="mb-2 flex flex-wrap gap-1">
            {sample.fields.map((f) => (
              <span
                key={f}
                className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-mono"
              >
                {f}
              </span>
            ))}
          </div>
          <div className="p-3 bg-gray-50 rounded-lg border border-gray-100">
            <pre className="text-xs font-mono text-gray-700 overflow-x-auto whitespace-pre-wrap leading-relaxed">
              {JSON.stringify(sample.record, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DataSourcesPage() {
  useDocumentMeta({
    title: 'Data Sources — LEX AI Platform',
    description:
      'Complete catalog of legal databases powering the LEX AI platform. 13 data sources, 70M+ records across court decisions, legislation, business registries, sanctions, and compliance data.',
    ogTitle: 'Data Sources — LEX AI Platform',
    ogDescription:
      'Complete catalog of 13 legal databases with 70M+ records. Court decisions, legislation, business registries, sanctions, and compliance data.',
  });

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <a
            href="/blog"
            className="flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="text-sm font-medium">Blog</span>
          </a>
          <div className="flex items-center gap-2">
            <Scale className="w-5 h-5 text-blue-600" />
            <span className="font-semibold text-gray-900">SecondLayer</span>
          </div>
        </div>
      </div>

      {/* Jurisdiction Navigation */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-500 font-medium mr-1">Jurisdictions:</span>
            {jurisdictions.map((j) => {
              const isCurrent = j.path === '/ua/data-sources';
              return (
                <a
                  key={j.path}
                  href={j.path}
                  className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-full transition-colors ${
                    isCurrent
                      ? 'bg-blue-100 text-blue-800 font-semibold'
                      : 'bg-gray-50 text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                  }`}
                >
                  <span>{j.flag}</span>
                  <span>{j.label}</span>
                  {isCurrent && (
                    <span className="text-[10px] text-blue-600 font-normal">(current)</span>
                  )}
                </a>
              );
            })}
          </div>
        </div>
      </div>

      {/* Hero */}
      <div className="bg-gradient-to-b from-blue-50 to-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12 sm:py-16 text-center">
          <div className="inline-flex items-center gap-2 mb-4 px-3 py-1.5 rounded-full bg-purple-50 text-purple-700 text-sm font-medium">
            <Database className="w-4 h-4" />
            Platform Database Catalog
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
            Our Data Sources
          </h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto mb-8">
            Every database powering the LEX AI platform. Real record counts, update frequencies,
            and sample data structures from each source.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            {heroStats.map((stat) => (
              <div
                key={stat.label}
                className={`inline-flex items-center gap-2 text-sm px-4 py-2 rounded-full font-medium ${stat.color}`}
              >
                <span className="font-bold">{stat.value}</span>
                <span>{stat.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Status legend */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-8 pb-2">
        <div className="flex flex-wrap items-center gap-4 text-xs text-gray-500">
          <span className="font-medium text-gray-700">Status legend:</span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border bg-purple-50 text-purple-700 border-purple-200">
            <HardDrive className="w-3 h-3" />
            In our DB
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border bg-green-50 text-green-700 border-green-200">
            <Check className="w-3 h-3" />
            Live API
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border bg-gray-50 text-gray-500 border-gray-200">
            <Clock className="w-3 h-3" />
            Coming soon
          </span>
        </div>
      </div>

      {/* Categories */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="space-y-12">
          {categories.map((category) => (
            <section key={category.title}>
              <div className="flex items-center gap-2 mb-5">
                <div className="text-blue-600">{category.icon}</div>
                <div>
                  <h2 className="text-xl font-semibold text-gray-900">{category.title}</h2>
                  <p className="text-xs text-gray-400">{category.titleUa}</p>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {category.sources.map((source) => (
                  <div
                    key={source.id}
                    className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition-all"
                  >
                    {/* Header */}
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1 min-w-0">
                        <h3 className="font-sans font-semibold text-gray-900 leading-tight">
                          {source.name}
                        </h3>
                        <p className="text-xs text-gray-400 mt-0.5">{source.nameUa}</p>
                      </div>
                      <span
                        className={`inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full border flex-shrink-0 ml-3 ${statusClasses(source.status)}`}
                      >
                        {statusIcon(source.status)}
                        {statusLabel(source.status)}
                      </span>
                    </div>

                    {/* Description */}
                    <p className="text-sm text-gray-600 mb-3 leading-relaxed">
                      {source.description}
                    </p>

                    {/* Stats badges */}
                    <div className="flex flex-wrap gap-2 mb-1">
                      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
                        <FileText className="w-3 h-3" />
                        {source.recordCount}
                      </span>
                      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
                        <Clock className="w-3 h-3" />
                        {source.updateFrequency}
                      </span>
                      <a
                        href={source.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-50 text-gray-600 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                      >
                        <ExternalLink className="w-3 h-3" />
                        Source
                      </a>
                    </div>

                    {/* Note */}
                    {source.note && (
                      <p className="text-[11px] text-gray-400 mt-2 leading-relaxed italic">
                        {source.note}
                      </p>
                    )}

                    {/* Collapsible sample data */}
                    <SampleDataPreview sample={source.sample} sourceId={source.id} />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>

      {/* Summary table */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 pb-10">
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h2 className="text-lg font-semibold text-gray-900">Summary</h2>
            <p className="text-xs text-gray-500 mt-0.5">All data sources at a glance</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left">
                  <th className="px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Source
                  </th>
                  <th className="px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Records
                  </th>
                  <th className="px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Update
                  </th>
                  <th className="px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {categories.flatMap((cat) =>
                  cat.sources.map((source) => (
                    <tr key={source.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-5 py-3">
                        <div className="font-medium text-gray-900 text-sm">{source.name}</div>
                        <div className="text-xs text-gray-400">{source.nameUa}</div>
                      </td>
                      <td className="px-5 py-3 text-gray-600 text-sm whitespace-nowrap">
                        {source.recordCount}
                      </td>
                      <td className="px-5 py-3 text-gray-600 text-sm whitespace-nowrap">
                        {source.updateFrequency}
                      </td>
                      <td className="px-5 py-3">
                        <span
                          className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${statusClasses(source.status)}`}
                        >
                          {statusIcon(source.status)}
                          {statusLabel(source.status)}
                        </span>
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-gray-200 bg-white mt-4">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 text-center text-sm text-gray-500">
          <p>
            &copy; {new Date().getFullYear()} SecondLayer. All rights reserved.
          </p>
          <p className="mt-1">
            Data is sourced from official Ukrainian government registries and international
            databases. Sample records shown for illustration.
          </p>
        </div>
      </footer>
    </div>
  );
}
