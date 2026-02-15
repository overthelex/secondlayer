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
        description: 'Parliament\'s official open data portal. Legislative bills, voting records, deputy information, committee structure, and plenary session transcripts with full API access.',
        tags: ['Parliament', 'API', 'Voting Records'],
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
        url: 'https://map.land.gov.ua/',
        description: 'Interactive map of all registered land plots in Ukraine. View boundaries, purpose, area, and ownership type. Free access without registration.',
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
        name: 'Sanctions Lists',
        nameUa: 'Санкційні списки РНБО',
        url: 'https://sanctions.nazk.gov.ua/',
        description: 'National Security and Defense Council sanctions database. Sanctioned individuals and entities with search functionality and cross-referencing capabilities.',
        tags: ['Sanctions', 'NSDC', 'Search'],
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
        url: 'https://data.gov.ua/group/ecology',
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
        name: 'Vehicle Registry Open Data',
        nameUa: 'Відкриті дані реєстрації ТЗ',
        url: 'https://data.gov.ua/dataset/06e65b06-3120-4713-8003-7905a83f95f5',
        description: 'One of the most popular datasets on data.gov.ua — vehicle registration information. Makes and models, registration dates, regions, and vehicle types across Ukraine.',
        tags: ['Vehicles', 'Most Popular', 'Registration'],
      },
      {
        name: 'Road Safety Data',
        nameUa: 'Дані безпеки руху',
        url: 'https://data.gov.ua/group/transport',
        description: 'Transport sector datasets including road accident statistics, infrastructure data, traffic flow, and public transport information from regional authorities.',
        tags: ['Transport', 'Road Safety', 'Infrastructure'],
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
