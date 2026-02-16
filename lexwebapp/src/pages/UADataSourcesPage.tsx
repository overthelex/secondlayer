/**
 * Ukraine Open Data Sources Page
 * Public informational page listing Ukrainian legal and government open data sources
 */

import { ArrowLeft, ExternalLink, Scale, BookOpen, FileText, Building2, Database, Shield, Landmark, DollarSign, BarChart3, Heart, GraduationCap, Leaf } from 'lucide-react';

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
        description: 'Comprehensive database of all court decisions in Ukraine since 2006. Over 100 million records across civil, criminal, administrative, and commercial jurisdictions. Full-text search by parties, case number, court, and date.',
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
        description: '25 datasets — yearly bulk exports of all court decisions from the Unified State Register. One archive per year from 2006 to present, enabling historical analysis and research.',
        tags: ['Bulk Data', '25 Datasets', 'Yearly Archives'],
      },
      {
        name: 'Judicial Statistics & Reports',
        nameUa: 'Судова статистика — звіти та показники',
        url: 'https://court.gov.ua/dsa/inshe/oddata/36/',
        description: '197 datasets — quarterly and annual statistical reports from all court levels. Case flow (civil, criminal, admin, commercial), caseload per judge, case duration, enforcement statistics, and appellate review rates.',
        tags: ['Statistics', '197 Datasets', 'All Court Levels'],
      },
      {
        name: 'Criminal Justice Statistics',
        nameUa: 'Кримінальна статистика — ст. КК України',
        url: 'https://court.gov.ua/dsa/inshe/oddata/468/',
        description: '22 datasets — detailed criminal case statistics by Criminal Code article. Conviction/acquittal rates, sentencing data, juvenile offender reports, human trafficking, hate crimes, and drug-related cases.',
        tags: ['Criminal', '22 Datasets', 'By CC Article'],
      },
      {
        name: 'Court Procurement & Budgets',
        nameUa: 'Закупівлі та бюджети судів',
        url: 'https://court.gov.ua/dsa/inshe/oddata/27/',
        description: '103 datasets — annual procurement plans, budget estimates, and financial reports from the State Judicial Administration and individual courts. Includes amendments and quarterly spending data.',
        tags: ['Procurement', '103 Datasets', 'Budgets'],
      },
      {
        name: 'Public Information Requests',
        nameUa: 'Публічна інформація — реєстри запитів',
        url: 'https://court.gov.ua/dsa/inshe/oddata/55/',
        description: '302 datasets — quarterly registers of public information requests received by courts and the State Judicial Administration. Type of requester, subject, response status, and resolution.',
        tags: ['FOI Requests', '302 Datasets', 'Transparency'],
      },
      {
        name: 'Court Contacts & Payment Details',
        nameUa: 'Реквізити, адреси та контакти судів',
        url: 'https://court.gov.ua/dsa/inshe/oddata/5/',
        description: '11 datasets — court fee payment requisites, electronic address register of government bodies, contact information, and office hours for courts across all regions.',
        tags: ['Contacts', 'Court Fees', 'Requisites'],
      },
      {
        name: 'Normative Acts & Regulations',
        nameUa: 'Нормативні акти судової системи',
        url: 'https://court.gov.ua/dsa/inshe/oddata/745/',
        description: '21 datasets — regulatory acts, administrative orders, and internal policy documents issued by courts and the State Judicial Administration. Quarterly publications of individual and normative acts.',
        tags: ['Regulations', '21 Datasets', 'Orders'],
      },
      {
        name: 'Judicial HR & Staffing',
        nameUa: 'Кадрова інформація — вакансії, конкурси',
        url: 'https://court.gov.ua/sud5010/inshe/6/215/',
        description: '7 datasets — judicial staffing data, vacancy announcements, competition results for court positions, judicial corps composition, and personal data protection policies.',
        tags: ['HR', 'Vacancies', 'Competitions'],
      },
      {
        name: 'Civil, Admin & Commercial Reports',
        nameUa: 'Цивільне, адміністративне, господарське судочинство',
        url: 'https://court.gov.ua/dsa/inshe/oddata/37/',
        description: '126 datasets — detailed reports on first-instance and appellate case processing by jurisdiction type. Civil disputes, administrative cases, commercial/economic cases, and minor offenses with processing time metrics.',
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
        description: 'Official database of all Ukrainian legislation maintained by the Verkhovna Rada. Laws, codes, resolutions, decrees — consolidated with amendments, historical versions, and English annotations for key acts.',
        tags: ['Official', 'Consolidated', 'English Available'],
      },
      {
        name: 'Rada Open Data Portal',
        nameUa: 'Портал відкритих даних Верховної Ради',
        url: 'https://data.rada.gov.ua/',
        description: 'Parliament\'s official open data portal with 633+ datasets across 8 categories. Full API access for developers at data.rada.gov.ua/open/main/api.',
        tags: ['Parliament', 'API', '633+ Datasets'],
      },
      {
        name: 'Draft Legislation System',
        nameUa: 'Система електронного документообігу',
        url: 'https://itd.rada.gov.ua/billInfo/Bills/CardBillSearch',
        description: 'Track bills through the Verkhovna Rada. Search by number, title, author, or committee. Full text of bills, amendments, and committee conclusions.',
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
        description: '179 datasets — full data on People\'s Deputies: biographical info, faction membership, committee roles, attendance, speeches, bill authorship, voting patterns, and inter-faction migration history.',
        tags: ['Deputies', '179 Datasets', 'Activity'],
      },
      {
        name: 'Agenda Items & Votes',
        nameUa: 'Інформація про розгляд питань порядку денного',
        url: 'https://data.rada.gov.ua/open/data/zal',
        description: '140 datasets — every agenda item considered in the session hall. Individual and roll-call vote results, procedural decisions, motion outcomes, and how each deputy voted on each question.',
        tags: ['Voting', '140 Datasets', 'Roll-call'],
      },
      {
        name: 'Plenary Sessions',
        nameUa: 'Інформація щодо пленарних засідань Верховної Ради',
        url: 'https://data.rada.gov.ua/open/data/meetings',
        description: '115 datasets — plenary session records including date, time, stenograms, speeches, procedural events, session agenda, registration data, and attendance.',
        tags: ['Sessions', '115 Datasets', 'Stenograms'],
      },
      {
        name: 'Registered Bills',
        nameUa: 'Інформація про законопроекти, зареєстровані у ВРУ',
        url: 'https://data.rada.gov.ua/open/data/zpr',
        description: '66 datasets — all bills registered in parliament. Bill text, authors, subject, committee assignment, expert opinions, amendments, reading stages, and final vote results.',
        tags: ['Bills', '66 Datasets', 'Full Lifecycle'],
      },
      {
        name: 'Legal Database',
        nameUa: 'Нормативно-правова база України',
        url: 'https://data.rada.gov.ua/open/data/zak',
        description: '61 datasets — structured data from the legislative database. Laws, codes, resolutions, international treaties in machine-readable format with metadata, relationships, and amendment chains.',
        tags: ['Laws', '61 Datasets', 'Machine-readable'],
      },
      {
        name: 'Financial & Economic Activity',
        nameUa: 'Господарсько-фінансова діяльність Верховної Ради',
        url: 'https://data.rada.gov.ua/open/data/fin',
        description: '62 datasets — Rada\'s own financial data. Budget allocations, procurement plans, salary funds, asset declarations, travel expenses, and quarterly financial reports.',
        tags: ['Finance', '62 Datasets', 'Budget'],
      },
      {
        name: 'Organizational Structure',
        nameUa: 'Організаційна структура розпорядника інформації',
        url: 'https://data.rada.gov.ua/open/data/aut',
        description: '4 datasets — Rada\'s institutional structure. Committees, sub-committees, temporary commissions, inter-faction groups, and Secretariat departments with leadership data.',
        tags: ['Structure', '4 Datasets', 'Committees'],
      },
      {
        name: 'Other Open Data',
        nameUa: 'Інша інформація в форматах відкритих даних',
        url: 'https://data.rada.gov.ua/open/data/etc',
        description: '6 datasets — additional open data including European integration monitoring, international cooperation, parliamentary delegations, and historical archive metadata.',
        tags: ['Other', '6 Datasets', 'EU Integration'],
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
        description: 'Popular platform aggregating government data on businesses and legal entities. Company registry (ЄДР), sole proprietors (ФОП), court decisions, real estate, debtors — with free API and CSV exports.',
        tags: ['Companies', 'Free API', 'Aggregator'],
      },
      {
        name: 'YouControl',
        url: 'https://youcontrol.com.ua/',
        description: 'Business intelligence platform with 7+ million company dossiers from 220+ official sources. Beneficial ownership, financial statements, court cases, sanctions, and market analytics.',
        tags: ['Due Diligence', 'Analytics', '7M+ Companies'],
      },
      {
        name: 'Ministry of Justice — Registries',
        nameUa: 'Міністерство юстиції — Реєстри',
        url: 'https://usr.minjust.gov.ua/',
        description: 'Unified State Register of Legal Entities, Individual Entrepreneurs, and Public Organizations. Official source for company registration data, founders, and authorized capital.',
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
        description: 'Revolutionary fully electronic public procurement system. All government tenders and contracts in open format. Saved $6B+ since 2017, monitored by 100,000+ citizens. Open Contracting Data Standard compliant.',
        tags: ['Procurement', 'Open Source', 'OCDS'],
      },
      {
        name: 'E-Data / Spending.gov.ua',
        nameUa: 'Є-Data / Витрати державних коштів',
        url: 'https://spending.gov.ua/',
        description: 'Public finance transparency portal tracking all government spending from state and local budgets. Real-time transaction data, spending unit breakdowns, and machine-readable API.',
        tags: ['Budget', 'Spending', 'API', 'Real-time'],
      },
      {
        name: 'Open Budget',
        nameUa: 'Відкритий бюджет',
        url: 'https://openbudget.gov.ua/',
        description: 'Interactive budget tracking at all government levels. National and local budget planning, execution monitoring, investment projects, and budget promise fulfillment.',
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
        description: 'Unified geo-informational system for all land in Ukraine. Land plots, normative monetary evaluation, ownership and usage data, electronic extracts and certificates.',
        tags: ['Land', 'Cadastre', 'GIS', 'API'],
      },
      {
        name: 'Public Cadastral Map',
        nameUa: 'Публічна кадастрова карта',
        url: 'https://e.land.gov.ua/',
        description: 'Interactive map of all registered land plots in Ukraine. View boundaries, purpose, area, and ownership type. Free access without registration via the State Land Cadastre portal.',
        tags: ['Map', 'Interactive', 'Free'],
      },
      {
        name: 'SETAM — Seized Property Auctions',
        nameUa: 'СЕТАМ — Аукціони арештованого майна',
        url: 'https://setam.net.ua/',
        description: 'State enterprise managing auctions for confiscated, arrested, and liquidated property. Auction announcements, results, and historical data available as open data on data.gov.ua.',
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
        description: 'Unified State Register of asset declarations of government officials. Property, income, vehicles, financial obligations of civil servants and their family members. API available.',
        tags: ['Declarations', 'Anti-Corruption', 'API'],
      },
      {
        name: 'NAZK Registers & Data',
        nameUa: 'Реєстри та дані НАЗК',
        url: 'https://nazk.gov.ua/',
        description: 'National Agency on Corruption Prevention. Hosts the Register of Corrupt Officials, political party reports, transparency register, and anti-corruption policy data.',
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
        description: 'Ukraine\'s central open data portal with 80,000+ datasets from all government agencies. Agriculture, transport, health, education, finance, and more. Machine-readable formats with public API. Ranked 3rd in Europe (97% maturity).',
        tags: ['80K+ Datasets', 'API', '#3 in Europe'],
      },
      {
        name: 'Diia Open Data',
        nameUa: 'Дія Відкриті дані',
        url: 'https://diia.data.gov.ua/',
        description: 'Competency center for open data, part of the Diia digital government initiative. Guides, documentation, 1,000+ curated datasets, and training resources for open data users and publishers.',
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
        description: 'Official source for all national statistical data. GDP, demographics, labor market, prices, inflation, industry, agriculture, trade — compliant with IMF SDDS standards.',
        tags: ['Statistics', 'Official', 'IMF SDDS'],
      },
      {
        name: 'National Bank of Ukraine — Statistics',
        nameUa: 'НБУ — Статистика',
        url: 'https://bank.gov.ua/en/statistic',
        description: 'Central bank financial and economic statistics. Banking sector indicators, monetary data, exchange rates, macroeconomic forecasts, and financial stability metrics.',
        tags: ['Banking', 'Exchange Rates', 'Macroeconomics'],
      },
      {
        name: 'State Tax Service — Open Data',
        nameUa: 'ДПС — Відкриті дані',
        url: 'https://tax.gov.ua/',
        description: 'Tax administration datasets. Fiscal statistics, taxpayer registry information, individual entrepreneur registry, and tax policy data (41 datasets on data.gov.ua).',
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
        description: 'National Health Service of Ukraine publishes hospital registries, bed availability, budget payments to medical institutions, patient declaration statistics, and healthcare worker data.',
        tags: ['Healthcare', 'Hospitals', 'NHSU'],
      },
      {
        name: 'eHealth / MedData',
        nameUa: 'eHealth / МедДата',
        url: 'https://ehealth.gov.ua/',
        description: 'Ukraine\'s digital health system. Electronic health records infrastructure, medical institution registry, doctor registry, and medication register.',
        tags: ['Digital Health', 'eHealth', 'Registry'],
      },
    ],
  },
  {
    title: 'Healthcare Open Data (НСЗУ on data.gov.ua) — 12 datasets',
    icon: <Heart className="w-5 h-5" />,
    sources: [
      {
        name: 'Medical Guarantee Contracts',
        nameUa: 'Укладені договори про медичне обслуговування за програмою медичних гарантій',
        url: 'https://data.gov.ua/dataset/6da6e500-e3c0-4a6a-9cb1-764582b531ee',
        description: 'Contracts between NHSU and healthcare providers under the Medical Guarantees Program. Provider names, contract amounts, service packages, and validity periods.',
        tags: ['Contracts', 'Medical Guarantees', 'NHSU'],
      },
      {
        name: 'Payments to Healthcare Providers',
        nameUa: 'Оплати надавачам медичної допомоги за програмою медичних гарантій',
        url: 'https://data.gov.ua/dataset/25a46db9-2f15-4302-9b59-9bd761c80f46',
        description: 'Payment data to medical institutions under the Medical Guarantees Program. Amounts paid, service types, periods, and provider breakdowns.',
        tags: ['Payments', 'Medical Guarantees', 'Budget'],
      },
      {
        name: 'Healthcare Provider Income & Expenses',
        nameUa: 'Дані зі звітів про доходи і витрати надавачів медичних послуг',
        url: 'https://data.gov.ua/dataset/036cf661-daeb-4434-8b4e-cd249dbc45d4',
        description: 'Selected financial indicators from healthcare provider reports. Revenue, expenditures, and key metrics for institutions contracted under the Medical Guarantees Program.',
        tags: ['Financial Reports', 'Providers', 'Indicators'],
      },
      {
        name: 'Contracted Healthcare Providers',
        nameUa: 'Суб\'єкти господарювання, які уклали договір із НСЗУ за програмою медичних гарантій',
        url: 'https://data.gov.ua/dataset/a1d554df-be4b-4d3f-8063-dd0db4d83ff5',
        description: 'Registry of healthcare entities contracted with NHSU. Hospital names, addresses, specializations, and contract details under the Medical Guarantees Program.',
        tags: ['Providers', 'Registry', 'Medical Guarantees'],
      },
      {
        name: 'Primary Care Declarations',
        nameUa: 'Внесені в ЕСОЗ декларації про вибір лікаря ПМД',
        url: 'https://data.gov.ua/dataset/a8228262-5576-4a14-beb8-789573573546',
        description: 'Declarations of primary care physician choice registered in the eHealth system. Statistics on patient-doctor relationships, regional distribution, and coverage rates.',
        tags: ['Primary Care', 'Declarations', 'eHealth'],
      },
      {
        name: 'Electronic Referrals in eHealth',
        nameUa: 'Інформація про створені та виконані електронні направлення в ЕСОЗ',
        url: 'https://data.gov.ua/dataset/005286ef-ec37-4ed4-b262-9a7597f146e0',
        description: 'Electronic referral data from the eHealth system. Created and fulfilled referrals by specialty, region, healthcare facility, and time period.',
        tags: ['Referrals', 'eHealth', 'Statistics'],
      },
      {
        name: 'Drug Reimbursement Contracts',
        nameUa: 'Укладені договори за програмою реімбурсації лікарських засобів',
        url: 'https://data.gov.ua/dataset/e7f426b5-7fe2-4fee-a991-b7d0d9113710',
        description: 'Contracts under the "Affordable Medicines" reimbursement program. Pharmacy chains, contract terms, and medication categories covered.',
        tags: ['Reimbursement', 'Contracts', 'Affordable Medicines'],
      },
      {
        name: 'Reimbursement Pharmacies',
        nameUa: 'Аптечні заклади за програмою реімбурсації «Доступні ліки»',
        url: 'https://data.gov.ua/dataset/3503ea5a-456d-4780-905b-b74e7d8f09cf',
        description: 'Pharmacies contracted with NHSU under the "Affordable Medicines" program. Pharmacy names, addresses, and participation status across all regions.',
        tags: ['Pharmacies', 'Affordable Medicines', 'Registry'],
      },
      {
        name: 'E-Prescriptions Issued',
        nameUa: 'Виписані електронні рецепти за програмою реімбурсації «Доступні ліки»',
        url: 'https://data.gov.ua/dataset/9980a894-67c5-4da6-a0fc-1bab6c764cbf',
        description: 'Electronic prescriptions issued under the drug reimbursement program. Prescription volumes by medication, region, and time period.',
        tags: ['E-Prescriptions', 'Issued', 'Statistics'],
      },
      {
        name: 'E-Prescriptions Fulfilled',
        nameUa: 'Погашені електронні рецепти за програмою реімбурсації «Доступні ліки»',
        url: 'https://data.gov.ua/dataset/5334586c-5bd1-4e24-9c14-9ba826cc9fa1',
        description: 'Fulfilled electronic prescriptions — medications actually dispensed. Fulfillment rates, medication types, regional distribution, and pharmacy performance.',
        tags: ['E-Prescriptions', 'Fulfilled', 'Dispensed'],
      },
      {
        name: 'Pharmacy Reimbursement Payments',
        nameUa: 'Оплати аптечним закладам за договорами реімбурсації «Доступні ліки»',
        url: 'https://data.gov.ua/dataset/959dca0a-9b74-41ff-a7c8-f8de6398a219',
        description: 'Payments to pharmacies under the "Affordable Medicines" reimbursement program. Payment amounts, pharmacy breakdowns, and medication category totals.',
        tags: ['Payments', 'Pharmacies', 'Reimbursement'],
      },
      {
        name: 'COVID-19 Vaccination Data',
        nameUa: 'Інформація про вакцинацію населення від Коронавірусної хвороби',
        url: 'https://data.gov.ua/dataset/3fcbfe9e-7cec-4f69-b9ca-be49daae2369',
        description: 'COVID-19 vaccination statistics. Doses administered by vaccine type, region, age group, and time period across Ukraine.',
        tags: ['COVID-19', 'Vaccination', 'Statistics'],
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
        description: 'Ministry of Education open data portal. School and university statistics, educational institution registries, student enrollment data, and quality indicators.',
        tags: ['Education', 'Schools', 'Universities'],
      },
      {
        name: 'EDEBO — Education Registry',
        nameUa: 'ЄДЕБО',
        url: 'https://info.edbo.gov.ua/',
        description: 'Unified State Electronic Database on Education. Registry of educational institutions, study programs, diplomas, and student enrollment across Ukraine.',
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
        description: 'Real-time air quality monitoring network across Ukraine. 500+ monitoring stations with hourly AQI updates, meteorological indicators, and free API with CSV data exports.',
        tags: ['Air Quality', 'Real-time', 'API', '500+ Stations'],
      },
      {
        name: 'Eco-Monitoring Open Data',
        nameUa: 'Відкриті дані довкілля',
        url: 'https://data.gov.ua/dataset?groups=ecology',
        description: 'Environmental datasets on data.gov.ua. Water quality, air pollution, waste management, protected areas, and ecological inspections data from government agencies.',
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
        description: 'One of the most popular datasets on data.gov.ua — vehicle registration information. Makes and models, registration dates, regions, vehicle types, and owner categories across Ukraine.',
        tags: ['Vehicles', 'Most Popular', 'Registration'],
      },
      {
        name: 'Vehicle Inspections & Fines',
        nameUa: 'Інформаційні звіти про кількість перевірених ТЗ та накладених штрафів',
        url: 'https://data.gov.ua/dataset/dfab13fa-8911-4098-ac1e-85f210ab9b24',
        description: 'Reports on inspected vehicles and fines imposed by the State Transport Safety Service. Inspection volumes, violation types, and enforcement statistics.',
        tags: ['Inspections', 'Fines', 'Safety'],
      },
      {
        name: 'Transport Licenses & Routes',
        nameUa: 'Ліцензії та маршрути перевезень',
        url: 'https://data.gov.ua/dataset/9b29b699-a1cc-462e-bb20-5998607c182f',
        description: '16 datasets in the transport group — intercity bus route registry, passenger/cargo transport licenses, certified bus stations, and tachograph service providers.',
        tags: ['Licenses', 'Bus Routes', '16 Datasets'],
      },
    ],
  },
];

export function UADataSourcesPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors">
            <ArrowLeft className="w-4 h-4" />
            <span className="text-sm font-medium">Home</span>
          </a>
          <div className="flex items-center gap-2">
            <Scale className="w-5 h-5 text-blue-600" />
            <span className="font-semibold text-gray-900">SecondLayer</span>
          </div>
        </div>
      </div>

      {/* Hero */}
      <div className="bg-gradient-to-b from-blue-50 to-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12 sm:py-16 text-center">
          <div className="text-4xl mb-4">&#127482;&#127462;</div>
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
            Ukraine Open Data Sources
          </h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            80,000+ datasets, ranked 3rd in Europe for open data maturity (97%).
            Courts, legislation, procurement, registries, budgets, and more.
          </p>
          <div className="flex flex-wrap justify-center gap-3 mt-6">
            <span className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-full bg-green-50 text-green-700 font-medium">
              #3 in Europe
            </span>
            <span className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-full bg-blue-50 text-blue-700 font-medium">
              80,000+ datasets
            </span>
            <span className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-full bg-purple-50 text-purple-700 font-medium">
              100M+ court decisions
            </span>
            <span className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-full bg-amber-50 text-amber-700 font-medium">
              ProZorro — $6B saved
            </span>
          </div>
        </div>
      </div>

      {/* Categories */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10">
        <div className="space-y-10">
          {categories.map((category) => (
            <section key={category.title}>
              <div className="flex items-center gap-2 mb-4">
                <div className="text-blue-600">{category.icon}</div>
                <h2 className="text-xl font-semibold text-gray-900">{category.title}</h2>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {category.sources.map((source) => (
                  <a key={source.name} href={source.url} target="_blank" rel="noopener noreferrer"
                    className="group block bg-white rounded-lg border border-gray-200 p-5 hover:border-blue-300 hover:shadow-md transition-all">
                    <div className="flex items-start justify-between mb-1">
                      <h3 className="font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">{source.name}</h3>
                      <ExternalLink className="w-4 h-4 text-gray-400 group-hover:text-blue-500 flex-shrink-0 mt-0.5" />
                    </div>
                    {source.nameUa && (
                      <p className="text-xs text-gray-400 mb-2">{source.nameUa}</p>
                    )}
                    <p className="text-sm text-gray-600 mb-3 leading-relaxed">{source.description}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {source.tags.map((tag) => (
                        <span key={tag} className="inline-block text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">{tag}</span>
                      ))}
                    </div>
                  </a>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-gray-200 bg-white mt-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 text-center text-sm text-gray-500">
          <p>&copy; {new Date().getFullYear()} SecondLayer. All rights reserved.</p>
          <p className="mt-1">This page is for informational purposes only. Links lead to third-party websites.</p>
        </div>
      </footer>
    </div>
  );
}
