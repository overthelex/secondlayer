/**
 * Admin Data Sources Page
 * Displays all Ukrainian open data sources integrated into the admin panel
 * Content mirrors the public /ua/data-sources page in admin layout style
 */

import React, { useState } from 'react';
import { ExternalLink, Scale, BookOpen, FileText, Building2, Database, Shield, Landmark, DollarSign, BarChart3, Heart, GraduationCap, Leaf, Users, Receipt, Briefcase, Search, ChevronDown, ChevronUp } from 'lucide-react';

interface DataSource {
  name: string;
  nameUa?: string;
  url: string;
  description: string;
  tags: string[];
}

interface Category {
  title: string;
  icon: React.ReactNode;
  sources: DataSource[];
}

const categories: Category[] = [
  {
    title: 'Courts & Justice',
    icon: <Scale className="w-5 h-5" />,
    sources: [
      {
        name: 'Register of Court Decisions',
        nameUa: 'Єдиний державний реєстр судових рішень (ЄДРСР)',
        url: 'https://reyestr.court.gov.ua/',
        description: 'Comprehensive database of all court decisions in Ukraine since 2006. Over 100 million records across civil, criminal, administrative, and commercial jurisdictions.',
        tags: ['Court Decisions', 'Official', 'Free', '100M+ Records'],
      },
      {
        name: 'Court Open Data Portal',
        nameUa: 'Відкриті дані судової влади',
        url: 'https://court.gov.ua/opendata/',
        description: 'Judiciary open data portal. Machine-readable exports of court decisions, court statistics, case flow data, and judicial system performance indicators.',
        tags: ['Open Data', 'API', 'Statistics'],
      },
      {
        name: 'Register of Debtors',
        nameUa: 'Єдиний реєстр боржників',
        url: 'https://erb.minjust.gov.ua/',
        description: 'Real-time database of individuals and legal entities with unfulfilled financial obligations. Enforcement proceedings, alimony debtors, and property alienation prevention data.',
        tags: ['Debtors', 'Enforcement', 'Real-time'],
      },
    ],
  },
  {
    title: 'Judiciary Open Data (court.gov.ua) — 814 datasets',
    icon: <Scale className="w-5 h-5" />,
    sources: [
      {
        name: 'ЄДРСР Annual Exports (2006–2025)',
        nameUa: 'Єдиний державний реєстр судових рішень — річні вивантаження',
        url: 'https://court.gov.ua/dsa/inshe/oddata/12/',
        description: '25 datasets — yearly bulk exports of all court decisions from the Unified State Register.',
        tags: ['Bulk Data', '25 Datasets', 'Yearly Archives'],
      },
      {
        name: 'Judicial Statistics & Reports',
        nameUa: 'Судова статистика — звіти та показники',
        url: 'https://court.gov.ua/dsa/inshe/oddata/36/',
        description: '197 datasets — quarterly and annual statistical reports from all court levels.',
        tags: ['Statistics', '197 Datasets', 'All Court Levels'],
      },
      {
        name: 'Criminal Justice Statistics',
        nameUa: 'Кримінальна статистика — ст. КК України',
        url: 'https://court.gov.ua/dsa/inshe/oddata/468/',
        description: '22 datasets — detailed criminal case statistics by Criminal Code article.',
        tags: ['Criminal', '22 Datasets', 'By CC Article'],
      },
      {
        name: 'Court Procurement & Budgets',
        nameUa: 'Закупівлі та бюджети судів',
        url: 'https://court.gov.ua/dsa/inshe/oddata/27/',
        description: '103 datasets — annual procurement plans, budget estimates, and financial reports.',
        tags: ['Procurement', '103 Datasets', 'Budgets'],
      },
      {
        name: 'Public Information Requests',
        nameUa: 'Публічна інформація — реєстри запитів',
        url: 'https://court.gov.ua/dsa/inshe/oddata/55/',
        description: '302 datasets — quarterly registers of public information requests received by courts.',
        tags: ['FOI Requests', '302 Datasets', 'Transparency'],
      },
      {
        name: 'Normative Acts & Regulations',
        nameUa: 'Нормативні акти судової системи',
        url: 'https://court.gov.ua/dsa/inshe/oddata/745/',
        description: '21 datasets — regulatory acts, administrative orders, and internal policy documents.',
        tags: ['Regulations', '21 Datasets', 'Orders'],
      },
      {
        name: 'Civil, Admin & Commercial Reports',
        nameUa: 'Цивільне, адміністративне, господарське судочинство',
        url: 'https://court.gov.ua/dsa/inshe/oddata/37/',
        description: '126 datasets — detailed reports on first-instance and appellate case processing.',
        tags: ['Case Reports', '126 Datasets', 'By Jurisdiction'],
      },
    ],
  },
  {
    title: 'Legislation & Parliament',
    icon: <BookOpen className="w-5 h-5" />,
    sources: [
      {
        name: 'Legislation of Ukraine',
        nameUa: 'Законодавство України',
        url: 'https://zakon.rada.gov.ua/',
        description: 'Official database of all Ukrainian legislation maintained by the Verkhovna Rada. Laws, codes, resolutions, decrees — consolidated with amendments.',
        tags: ['Official', 'Consolidated', 'English Available'],
      },
      {
        name: 'Rada Open Data Portal',
        nameUa: 'Портал відкритих даних Верховної Ради',
        url: 'https://data.rada.gov.ua/',
        description: 'Parliament\'s official open data portal with 633+ datasets across 8 categories.',
        tags: ['Parliament', 'API', '633+ Datasets'],
      },
      {
        name: 'Draft Legislation System',
        nameUa: 'Система електронного документообігу',
        url: 'https://itd.rada.gov.ua/billInfo/Bills/CardBillSearch',
        description: 'Track bills through the Verkhovna Rada. Search by number, title, author, or committee.',
        tags: ['Bills', 'Tracking', 'Amendments'],
      },
    ],
  },
  {
    title: 'Rada Open Data (data.rada.gov.ua) — 633 datasets',
    icon: <BookOpen className="w-5 h-5" />,
    sources: [
      {
        name: 'Deputies & Activity',
        nameUa: 'Інформація про народних депутатів України та їх активність',
        url: 'https://data.rada.gov.ua/open/data/mps',
        description: '179 datasets — full data on People\'s Deputies: biographical info, faction membership, committee roles, voting patterns.',
        tags: ['Deputies', '179 Datasets', 'Activity'],
      },
      {
        name: 'Agenda Items & Votes',
        nameUa: 'Інформація про розгляд питань порядку денного',
        url: 'https://data.rada.gov.ua/open/data/zal',
        description: '140 datasets — every agenda item considered in the session hall with roll-call vote results.',
        tags: ['Voting', '140 Datasets', 'Roll-call'],
      },
      {
        name: 'Plenary Sessions',
        nameUa: 'Інформація щодо пленарних засідань Верховної Ради',
        url: 'https://data.rada.gov.ua/open/data/meetings',
        description: '115 datasets — plenary session records including stenograms, speeches, and attendance.',
        tags: ['Sessions', '115 Datasets', 'Stenograms'],
      },
      {
        name: 'Registered Bills',
        nameUa: 'Інформація про законопроекти, зареєстровані у ВРУ',
        url: 'https://data.rada.gov.ua/open/data/zpr',
        description: '66 datasets — all bills registered in parliament with full lifecycle data.',
        tags: ['Bills', '66 Datasets', 'Full Lifecycle'],
      },
      {
        name: 'Legal Database',
        nameUa: 'Нормативно-правова база України',
        url: 'https://data.rada.gov.ua/open/data/zak',
        description: '61 datasets — structured data from the legislative database in machine-readable format.',
        tags: ['Laws', '61 Datasets', 'Machine-readable'],
      },
      {
        name: 'Financial & Economic Activity',
        nameUa: 'Господарсько-фінансова діяльність Верховної Ради',
        url: 'https://data.rada.gov.ua/open/data/fin',
        description: '62 datasets — Rada\'s own financial data: budget allocations, procurement, salary funds.',
        tags: ['Finance', '62 Datasets', 'Budget'],
      },
    ],
  },
  {
    title: 'Business Registries',
    icon: <Building2 className="w-5 h-5" />,
    sources: [
      {
        name: 'OpenDataBot',
        nameUa: 'Опендатабот',
        url: 'https://opendatabot.ua/',
        description: 'Popular platform aggregating government data on businesses and legal entities. Free API and CSV exports.',
        tags: ['Companies', 'Free API', 'Aggregator'],
      },
      {
        name: 'YouControl',
        url: 'https://youcontrol.com.ua/',
        description: 'Business intelligence platform with 7+ million company dossiers from 220+ official sources.',
        tags: ['Due Diligence', 'Analytics', '7M+ Companies'],
      },
      {
        name: 'Ministry of Justice — Registries',
        nameUa: 'Міністерство юстиції — Реєстри',
        url: 'https://usr.minjust.gov.ua/',
        description: 'Unified State Register of Legal Entities, Individual Entrepreneurs, and Public Organizations.',
        tags: ['Official', 'ЄДР', 'Registration Data'],
      },
    ],
  },
  {
    title: 'Procurement & Public Finance',
    icon: <DollarSign className="w-5 h-5" />,
    sources: [
      {
        name: 'ProZorro',
        nameUa: 'Прозорро',
        url: 'https://prozorro.gov.ua/',
        description: 'Fully electronic public procurement system. All government tenders and contracts in open format. Saved $6B+ since 2017.',
        tags: ['Procurement', 'Open Source', 'OCDS'],
      },
      {
        name: 'E-Data / Spending.gov.ua',
        nameUa: 'Є-Data / Витрати державних коштів',
        url: 'https://spending.gov.ua/',
        description: 'Public finance transparency portal tracking all government spending. Real-time transaction data.',
        tags: ['Budget', 'Spending', 'API', 'Real-time'],
      },
      {
        name: 'Open Budget',
        nameUa: 'Відкритий бюджет',
        url: 'https://openbudget.gov.ua/',
        description: 'Interactive budget tracking at all government levels. National and local budget planning.',
        tags: ['Budget', 'Interactive', 'Local Budgets'],
      },
    ],
  },
  {
    title: 'Land & Property',
    icon: <Landmark className="w-5 h-5" />,
    sources: [
      {
        name: 'State Land Cadastre',
        nameUa: 'Державний земельний кадастр',
        url: 'https://e.land.gov.ua/',
        description: 'Unified geo-informational system for all land in Ukraine. Land plots, ownership and usage data.',
        tags: ['Land', 'Cadastre', 'GIS', 'API'],
      },
      {
        name: 'SETAM — Seized Property Auctions',
        nameUa: 'СЕТАМ — Аукціони арештованого майна',
        url: 'https://setam.net.ua/',
        description: 'State enterprise managing auctions for confiscated, arrested, and liquidated property.',
        tags: ['Auctions', 'Property', 'Daily Updates'],
      },
    ],
  },
  {
    title: 'Anti-Corruption & Declarations',
    icon: <Shield className="w-5 h-5" />,
    sources: [
      {
        name: 'NAZK — Asset Declarations',
        nameUa: 'НАЗК — Реєстр декларацій',
        url: 'https://public.nazk.gov.ua/',
        description: 'Unified State Register of asset declarations of government officials. API available.',
        tags: ['Declarations', 'Anti-Corruption', 'API'],
      },
      {
        name: 'NAZK Registers & Data',
        nameUa: 'Реєстри та дані НАЗК',
        url: 'https://nazk.gov.ua/',
        description: 'Register of Corrupt Officials, political party reports, transparency register.',
        tags: ['Anti-Corruption', 'Registers', 'Transparency'],
      },
    ],
  },
  {
    title: 'National Open Data Portal',
    icon: <Database className="w-5 h-5" />,
    sources: [
      {
        name: 'data.gov.ua',
        nameUa: 'Єдиний державний вебпортал відкритих даних',
        url: 'https://data.gov.ua/',
        description: 'Ukraine\'s central open data portal with 80,000+ datasets from all government agencies. Ranked 3rd in Europe (97% maturity).',
        tags: ['80K+ Datasets', 'API', '#3 in Europe'],
      },
      {
        name: 'Diia Open Data',
        nameUa: 'Дія Відкриті дані',
        url: 'https://diia.data.gov.ua/',
        description: 'Competency center for open data, part of the Diia digital government initiative.',
        tags: ['Diia', 'Guides', 'Documentation'],
      },
    ],
  },
  {
    title: 'Statistics & Economics',
    icon: <BarChart3 className="w-5 h-5" />,
    sources: [
      {
        name: 'State Statistics Service',
        nameUa: 'Державна служба статистики',
        url: 'https://stat.gov.ua/',
        description: 'Official source for all national statistical data. GDP, demographics, labor market, prices, inflation.',
        tags: ['Statistics', 'Official', 'IMF SDDS'],
      },
      {
        name: 'National Bank of Ukraine — Statistics',
        nameUa: 'НБУ — Статистика',
        url: 'https://bank.gov.ua/en/statistic',
        description: 'Central bank financial and economic statistics. Banking sector, exchange rates, macroeconomic forecasts.',
        tags: ['Banking', 'Exchange Rates', 'Macroeconomics'],
      },
      {
        name: 'State Tax Service — Open Data',
        nameUa: 'ДПС — Відкриті дані',
        url: 'https://tax.gov.ua/',
        description: 'Tax administration datasets. Fiscal statistics, taxpayer registry, 41 datasets on data.gov.ua.',
        tags: ['Tax', 'Fiscal', '41 Datasets'],
      },
    ],
  },
  {
    title: 'Healthcare',
    icon: <Heart className="w-5 h-5" />,
    sources: [
      {
        name: 'National Health Service — Open Data',
        nameUa: 'НСЗУ — Відкриті дані',
        url: 'https://nszu.gov.ua/en',
        description: 'Hospital registries, bed availability, budget payments, patient declaration statistics.',
        tags: ['Healthcare', 'Hospitals', 'NHSU'],
      },
      {
        name: 'eHealth / MedData',
        nameUa: 'eHealth / МедДата',
        url: 'https://ehealth.gov.ua/',
        description: 'Ukraine\'s digital health system. Electronic health records, medical and doctor registries.',
        tags: ['Digital Health', 'eHealth', 'Registry'],
      },
    ],
  },
  {
    title: 'Healthcare Open Data (НСЗУ) — 12 datasets',
    icon: <Heart className="w-5 h-5" />,
    sources: [
      {
        name: 'Medical Guarantee Contracts',
        nameUa: 'Укладені договори про медичне обслуговування за програмою медичних гарантій',
        url: 'https://data.gov.ua/dataset/6da6e500-e3c0-4a6a-9cb1-764582b531ee',
        description: 'Contracts between NHSU and healthcare providers under the Medical Guarantees Program.',
        tags: ['Contracts', 'Medical Guarantees', 'NHSU'],
      },
      {
        name: 'Payments to Healthcare Providers',
        nameUa: 'Оплати надавачам медичної допомоги за програмою медичних гарантій',
        url: 'https://data.gov.ua/dataset/25a46db9-2f15-4302-9b59-9bd761c80f46',
        description: 'Payment data to medical institutions under the Medical Guarantees Program.',
        tags: ['Payments', 'Medical Guarantees', 'Budget'],
      },
      {
        name: 'Primary Care Declarations',
        nameUa: 'Внесені в ЕСОЗ декларації про вибір лікаря ПМД',
        url: 'https://data.gov.ua/dataset/a8228262-5576-4a14-beb8-789573573546',
        description: 'Declarations of primary care physician choice registered in the eHealth system.',
        tags: ['Primary Care', 'Declarations', 'eHealth'],
      },
      {
        name: 'Drug Reimbursement ("Affordable Medicines")',
        nameUa: 'Укладені договори за програмою реімбурсації лікарських засобів',
        url: 'https://data.gov.ua/dataset/e7f426b5-7fe2-4fee-a991-b7d0d9113710',
        description: 'Contracts under the "Affordable Medicines" reimbursement program.',
        tags: ['Reimbursement', 'Contracts', 'Affordable Medicines'],
      },
      {
        name: 'COVID-19 Vaccination Data',
        nameUa: 'Інформація про вакцинацію населення від Коронавірусної хвороби',
        url: 'https://data.gov.ua/dataset/3fcbfe9e-7cec-4f69-b9ca-be49daae2369',
        description: 'COVID-19 vaccination statistics by vaccine type, region, age group.',
        tags: ['COVID-19', 'Vaccination', 'Statistics'],
      },
    ],
  },
  {
    title: 'State Governance (data.gov.ua) — 30 datasets',
    icon: <Landmark className="w-5 h-5" />,
    sources: [
      {
        name: 'Missing Persons Registry',
        nameUa: 'Інформація про безвісно зниклих громадян',
        url: 'https://data.gov.ua/dataset/470196d3-4e7a-46b0-8c0c-883b74ac65f0',
        description: 'National registry of missing persons maintained by the National Police.',
        tags: ['Missing Persons', 'National Police', 'JSON'],
      },
      {
        name: 'Administrative-Territorial Dictionary',
        nameUa: 'Словник адміністративно-територіального устрою України',
        url: 'https://data.gov.ua/dataset/a2d6c060-e7e6-4471-ac67-42cfa1742a19',
        description: 'Complete hierarchical dictionary of Ukraine\'s administrative-territorial structure.',
        tags: ['ATU', 'Addresses', 'Dictionary'],
      },
    ],
  },
  {
    title: 'Justice Ministry Registries (data.gov.ua) — 19 datasets',
    icon: <Briefcase className="w-5 h-5" />,
    sources: [
      {
        name: 'Notary Registry',
        nameUa: 'Єдиний реєстр нотаріусів',
        url: 'https://data.gov.ua/dataset/1603f092-68b3-4c25-afef-8632aed79daf',
        description: 'Unified State Register of Notaries — all practicing notaries with license numbers.',
        tags: ['Notaries', 'Registry', 'Ministry of Justice'],
      },
      {
        name: 'Forensic Experts Registry',
        nameUa: 'Державний реєстр атестованих судових експертів',
        url: 'https://data.gov.ua/dataset/0a556891-d6ef-4a5f-a182-caac2f7aa9c9',
        description: 'State Register of Certified Forensic Experts with specializations.',
        tags: ['Forensic Experts', 'Certified', 'Registry'],
      },
      {
        name: 'Bankruptcy Proceedings Registry',
        nameUa: 'Єдиний реєстр підприємств у справі про банкрутство',
        url: 'https://data.gov.ua/dataset/78531b7b-e0b1-489f-9924-64144faa7abd',
        description: 'Companies under bankruptcy, liquidation status, arbitration managers.',
        tags: ['Bankruptcy', 'Enterprises', 'Liquidation'],
      },
      {
        name: 'NGO & Civil Associations Registry',
        nameUa: 'Реєстр громадських об\'єднань',
        url: 'https://data.gov.ua/dataset/b07bc894-7301-4bf2-a796-2708e9729538',
        description: 'Registry of all registered non-governmental organizations and civic associations.',
        tags: ['NGOs', 'Civil Society', 'Registry'],
      },
      {
        name: 'Corruption Offenders Registry',
        nameUa: 'Єдиний державний реєстр осіб з корупційних правопорушень',
        url: 'https://data.gov.ua/dataset/1b80e5ef-3c57-4090-8c4f-cda687f67721',
        description: 'Registry of persons who committed corruption offenses.',
        tags: ['Anti-Corruption', 'Offenders', 'Registry'],
      },
      {
        name: 'Lustration Registry',
        nameUa: 'Єдиний державний реєстр осіб щодо закону «Про очищення влади»',
        url: 'https://data.gov.ua/dataset/8faa71c1-3a54-45e8-8f6e-06c92b1ff8bc',
        description: 'Registry of persons subject to the "Government Cleansing" (lustration) law.',
        tags: ['Lustration', 'Government Cleansing', 'Registry'],
      },
    ],
  },
  {
    title: 'State Revenue & Taxes (data.gov.ua) — 47 datasets',
    icon: <Receipt className="w-5 h-5" />,
    sources: [
      {
        name: 'VAT Payers Registry',
        nameUa: 'Реєстр платників податку на додану вартість',
        url: 'https://data.gov.ua/dataset/db391c93-1e68-43c9-bd85-7c6a8427b114',
        description: 'Registry of all registered VAT payers in Ukraine.',
        tags: ['VAT', 'Tax Payers', 'Registry'],
      },
      {
        name: 'Monthly Tax Revenue Reports',
        nameUa: 'Інформація про щомісячні надходження податків і зборів',
        url: 'https://data.gov.ua/dataset/9241a499-e979-419d-aafd-25fcb59ef90e',
        description: 'Monthly reports on tax and fee collections by type and region.',
        tags: ['Tax Revenue', 'Monthly', 'By Region'],
      },
      {
        name: 'Corporate Financial Statements',
        nameUa: 'Фінансова звітність суб\'єктів господарювання державного та комунального секторів',
        url: 'https://data.gov.ua/dataset/5f32a8c3-6188-4696-8037-26d895900d49',
        description: 'Financial reporting from state-owned and municipal enterprises.',
        tags: ['Financial Statements', 'SOEs', 'Balance Sheets'],
      },
    ],
  },
  {
    title: 'Society & Social Protection (data.gov.ua) — 7 datasets',
    icon: <Users className="w-5 h-5" />,
    sources: [
      {
        name: 'Housing Subsidy Recipients',
        nameUa: 'Єдиний державний реєстр отримувачів житлових субсидій',
        url: 'https://data.gov.ua/dataset/8ff7e5ca-2a89-48d3-9b78-d8cac6c890c5',
        description: 'Unified State Register of housing subsidy recipients. Updated monthly.',
        tags: ['Subsidies', 'Housing', 'Social Protection'],
      },
      {
        name: 'Wage Debt Registry',
        nameUa: 'Реєстр підприємств з заборгованістю із заробітної плати',
        url: 'https://data.gov.ua/dataset/eb4cba1e-6cab-4df7-8613-4fbdb03473eb',
        description: 'Registry of enterprises with outstanding wage debts to employees.',
        tags: ['Wage Debt', 'Labor Rights', 'Registry'],
      },
      {
        name: 'Humanitarian Aid Recipients',
        nameUa: 'Єдиний реєстр отримувачів гуманітарної допомоги',
        url: 'https://data.gov.ua/dataset/3045fcd0-07f2-44c7-b8dc-98fbf641c1ee',
        description: 'Registry of humanitarian aid recipients. Aid types and regional allocation.',
        tags: ['Humanitarian Aid', 'Recipients', 'Registry'],
      },
    ],
  },
  {
    title: 'Education',
    icon: <GraduationCap className="w-5 h-5" />,
    sources: [
      {
        name: 'Educational Analytics',
        nameUa: 'Інститут освітньої аналітики',
        url: 'https://iea.gov.ua/en/open-data-portal/',
        description: 'Ministry of Education open data portal. School and university statistics.',
        tags: ['Education', 'Schools', 'Universities'],
      },
      {
        name: 'EDEBO — Education Registry',
        nameUa: 'ЄДЕБО',
        url: 'https://info.edbo.gov.ua/',
        description: 'Unified State Electronic Database on Education. Institutions, programs, diplomas.',
        tags: ['Registry', 'Diplomas', 'Institutions'],
      },
    ],
  },
  {
    title: 'Environment',
    icon: <Leaf className="w-5 h-5" />,
    sources: [
      {
        name: 'SaveEcoBot',
        url: 'https://www.saveecobot.com/en/maps',
        description: 'Real-time air quality monitoring. 500+ stations with hourly AQI updates and free API.',
        tags: ['Air Quality', 'Real-time', 'API', '500+ Stations'],
      },
      {
        name: 'Eco-Monitoring Open Data',
        nameUa: 'Відкриті дані довкілля',
        url: 'https://data.gov.ua/dataset?groups=ecology',
        description: 'Environmental datasets — water quality, air pollution, waste management, protected areas.',
        tags: ['Ecology', 'Water', 'Air', 'Datasets'],
      },
    ],
  },
  {
    title: 'Vehicles & Transport',
    icon: <FileText className="w-5 h-5" />,
    sources: [
      {
        name: 'Vehicles & Their Owners',
        nameUa: 'Відомості про транспортні засоби та їх власників',
        url: 'https://data.gov.ua/dataset/06779371-308f-42d7-895e-5a39833375f0',
        description: 'One of the most popular datasets on data.gov.ua — vehicle registration information.',
        tags: ['Vehicles', 'Most Popular', 'Registration'],
      },
      {
        name: 'Vehicle Inspections & Fines',
        nameUa: 'Інформаційні звіти про кількість перевірених ТЗ та накладених штрафів',
        url: 'https://data.gov.ua/dataset/dfab13fa-8911-4098-ac1e-85f210ab9b24',
        description: 'Inspected vehicles and fines imposed by the State Transport Safety Service.',
        tags: ['Inspections', 'Fines', 'Safety'],
      },
      {
        name: 'Transport Licenses & Routes',
        nameUa: 'Ліцензії та маршрути перевезень',
        url: 'https://data.gov.ua/dataset/9b29b699-a1cc-462e-bb20-5998607c182f',
        description: '16 datasets — intercity bus routes, passenger/cargo transport licenses.',
        tags: ['Licenses', 'Bus Routes', '16 Datasets'],
      },
    ],
  },
];

// Count totals
const totalSources = categories.reduce((sum, cat) => sum + cat.sources.length, 0);
const totalCategories = categories.length;

export function AdminDataSourcesPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  const toggleCategory = (title: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(title)) {
        next.delete(title);
      } else {
        next.add(title);
      }
      return next;
    });
  };

  const filteredCategories = searchQuery.trim()
    ? categories
        .map(cat => ({
          ...cat,
          sources: cat.sources.filter(s =>
            s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            (s.nameUa && s.nameUa.toLowerCase().includes(searchQuery.toLowerCase())) ||
            s.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
            s.tags.some(t => t.toLowerCase().includes(searchQuery.toLowerCase()))
          ),
        }))
        .filter(cat => cat.sources.length > 0)
    : categories;

  const filteredSourceCount = filteredCategories.reduce((sum, cat) => sum + cat.sources.length, 0);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-claude-text font-sans">Джерела даних</h1>
          <p className="text-sm text-claude-subtext mt-1">
            {totalSources} джерел у {totalCategories} категоріях — відкриті дані України
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="/ua/data-sources"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-4 py-2 bg-white border border-claude-border rounded-lg text-sm text-claude-text hover:bg-claude-bg transition-colors"
          >
            <ExternalLink size={14} />
            Публічна сторінка
          </a>
        </div>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-claude-border p-4 shadow-sm">
          <p className="text-xs text-claude-subtext">Категорій</p>
          <p className="text-2xl font-semibold text-claude-text mt-1">{totalCategories}</p>
        </div>
        <div className="bg-white rounded-xl border border-claude-border p-4 shadow-sm">
          <p className="text-xs text-claude-subtext">Джерел даних</p>
          <p className="text-2xl font-semibold text-claude-text mt-1">{totalSources}</p>
        </div>
        <div className="bg-white rounded-xl border border-claude-border p-4 shadow-sm">
          <p className="text-xs text-claude-subtext">data.gov.ua</p>
          <p className="text-2xl font-semibold text-claude-text mt-1">80,000+</p>
        </div>
        <div className="bg-white rounded-xl border border-claude-border p-4 shadow-sm">
          <p className="text-xs text-claude-subtext">Рейтинг в Європі</p>
          <p className="text-2xl font-semibold text-claude-text mt-1">#3</p>
        </div>
      </div>

      {/* Search */}
      <div className="relative mb-6">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-claude-subtext" />
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Пошук джерел даних..."
          className="w-full pl-10 pr-4 py-2.5 bg-white border border-claude-border rounded-lg text-sm text-claude-text placeholder:text-claude-subtext/50 focus:outline-none focus:ring-2 focus:ring-claude-text/20 focus:border-claude-text/30"
        />
        {searchQuery && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-claude-subtext">
            {filteredSourceCount} результатів
          </span>
        )}
      </div>

      {/* Format Statistics */}
      <div className="bg-white rounded-xl border border-claude-border p-5 shadow-sm mb-6">
        <h2 className="text-sm font-semibold text-claude-text mb-1">Формати даних на data.gov.ua</h2>
        <p className="text-xs text-claude-subtext mb-3">Розподіл 39,821 наборів за форматом файлу</p>
        <div className="space-y-1.5">
          {[
            { format: 'XLSX', count: 16173, color: 'bg-green-500' },
            { format: 'CSV', count: 12179, color: 'bg-blue-500' },
            { format: 'XLS', count: 6992, color: 'bg-emerald-500' },
            { format: 'DOCX', count: 2007, color: 'bg-purple-500' },
            { format: 'ZIP', count: 1999, color: 'bg-amber-500' },
            { format: 'JSON', count: 1714, color: 'bg-cyan-500' },
            { format: 'XML', count: 1682, color: 'bg-teal-500' },
            { format: 'PDF', count: 1521, color: 'bg-red-500' },
          ].map(({ format, count, color }) => (
            <div key={format} className="flex items-center gap-2">
              <span className="text-xs font-mono text-claude-subtext w-10 text-right">{format}</span>
              <div className="flex-1 bg-gray-100 rounded-full h-4 overflow-hidden">
                <div className={`${color} h-full rounded-full`} style={{ width: `${(count / 16173) * 100}%` }} />
              </div>
              <span className="text-xs text-claude-subtext w-14 text-right">{count.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Categories */}
      <div className="space-y-4">
        {filteredCategories.map((category) => {
          const isCollapsed = collapsedCategories.has(category.title);
          return (
            <section key={category.title} className="bg-white rounded-xl border border-claude-border shadow-sm overflow-hidden">
              <button
                onClick={() => toggleCategory(category.title)}
                className="w-full flex items-center justify-between p-4 hover:bg-claude-bg/50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <div className="text-claude-subtext">{category.icon}</div>
                  <h2 className="text-sm font-semibold text-claude-text font-sans">{category.title}</h2>
                  <span className="text-xs text-claude-subtext bg-claude-bg px-2 py-0.5 rounded-full">
                    {category.sources.length}
                  </span>
                </div>
                {isCollapsed ? <ChevronDown size={16} className="text-claude-subtext" /> : <ChevronUp size={16} className="text-claude-subtext" />}
              </button>
              {!isCollapsed && (
                <div className="border-t border-claude-border">
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-0 divide-x divide-y divide-claude-border/50">
                    {category.sources.map((source) => (
                      <a
                        key={source.name}
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group p-4 hover:bg-claude-bg/30 transition-colors"
                      >
                        <div className="flex items-start justify-between mb-1">
                          <h3 className="text-sm font-semibold text-claude-text group-hover:text-blue-600 transition-colors">
                            {source.name}
                          </h3>
                          <ExternalLink size={12} className="text-claude-subtext/40 group-hover:text-blue-500 flex-shrink-0 mt-0.5 ml-2" />
                        </div>
                        {source.nameUa && (
                          <p className="text-[11px] text-claude-subtext/60 mb-1.5">{source.nameUa}</p>
                        )}
                        <p className="text-xs text-claude-subtext mb-2 leading-relaxed line-clamp-2">{source.description}</p>
                        <div className="flex flex-wrap gap-1">
                          {source.tags.map((tag) => (
                            <span key={tag} className="inline-block text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700">
                              {tag}
                            </span>
                          ))}
                        </div>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>

      {searchQuery && filteredCategories.length === 0 && (
        <div className="text-center py-12">
          <Search size={32} className="text-claude-subtext/30 mx-auto mb-3" />
          <p className="text-claude-subtext">Нічого не знайдено за запитом "{searchQuery}"</p>
        </div>
      )}
    </div>
  );
}
