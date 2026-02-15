/**
 * Germany Open Data Sources Page
 * Public informational page listing German legal open data sources
 */

import { ArrowLeft, ExternalLink, Scale, BookOpen, FileText, Building2, Database, Shield } from 'lucide-react';

interface DataSource {
  name: string;
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
    title: 'Courts & Case Law',
    icon: <Scale className="w-5 h-5" />,
    sources: [
      {
        name: 'Bundesgerichtshof (BGH)',
        url: 'https://www.bundesgerichtshof.de/DE/Entscheidungen/entscheidungen_node.html',
        description: 'Federal Court of Justice decisions database. Free access to civil and criminal rulings from Germany\'s highest court of ordinary jurisdiction.',
        tags: ['Federal Court', 'Free', 'Official'],
      },
      {
        name: 'Bundesverfassungsgericht (BVerfG)',
        url: 'https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html',
        description: 'Federal Constitutional Court decisions. Full text of all major constitutional rulings with press releases and annual statistics.',
        tags: ['Constitutional', 'Official', 'Free'],
      },
      {
        name: 'openJur',
        url: 'https://openjur.de',
        description: 'Community-driven open case law database with over 400,000 court decisions from all German jurisdictions. Full-text searchable.',
        tags: ['Free', 'Community', 'Searchable'],
      },
      {
        name: 'dejure.org',
        url: 'https://dejure.org',
        description: 'Free legal information portal linking statutes to related case law. Cross-referenced database of laws and court decisions.',
        tags: ['Cross-referenced', 'Free', 'Statutes'],
      },
    ],
  },
  {
    title: 'Legislation',
    icon: <BookOpen className="w-5 h-5" />,
    sources: [
      {
        name: 'Gesetze im Internet',
        url: 'https://www.gesetze-im-internet.de',
        description: 'Official portal of the Federal Ministry of Justice. All federal laws and regulations in current consolidated form, with English translations for major codes.',
        tags: ['Official', 'Free', 'English Available'],
      },
      {
        name: 'Bundesgesetzblatt (BGBl)',
        url: 'https://www.recht.bund.de/bgbl/',
        description: 'Federal Law Gazette — official publication of new laws and amendments. Free access to the digital version since 2023.',
        tags: ['Official', 'Gazette', 'Free Since 2023'],
      },
      {
        name: 'Dokumentations- und Informationssystem (DIP)',
        url: 'https://dip.bundestag.de',
        description: 'Bundestag documentation system. Track bills, motions, committee reports, plenary protocols, and the full legislative process.',
        tags: ['Parliament', 'Bills', 'Tracking'],
      },
    ],
  },
  {
    title: 'Regulations & Administrative Law',
    icon: <FileText className="w-5 h-5" />,
    sources: [
      {
        name: 'Verwaltungsvorschriften im Internet',
        url: 'https://www.verwaltungsvorschriften-im-internet.de',
        description: 'Federal administrative regulations and guidelines. Official collection maintained by the Federal Ministry of Justice.',
        tags: ['Administrative', 'Official', 'Free'],
      },
      {
        name: 'EUR-Lex (German Implementation)',
        url: 'https://eur-lex.europa.eu/collection/n-law/n-law-by-country.html?country=DE',
        description: 'EU law as implemented in Germany. Track directives transposition, regulations, and European Court decisions affecting German law.',
        tags: ['EU Law', 'Transposition', 'Free'],
      },
    ],
  },
  {
    title: 'Business Registries',
    icon: <Building2 className="w-5 h-5" />,
    sources: [
      {
        name: 'Handelsregister (Common Register Portal)',
        url: 'https://www.handelsregister.de',
        description: 'Unified portal for German commercial, cooperative, and partnership registers. Company filings, annual accounts, and structural data.',
        tags: ['Official', 'Company Data', 'Register'],
      },
      {
        name: 'Unternehmensregister',
        url: 'https://www.unternehmensregister.de',
        description: 'Central company register. Financial statements, corporate announcements, insolvency proceedings, and capital market disclosures.',
        tags: ['Financial Statements', 'Free', 'Insolvency'],
      },
      {
        name: 'Transparenzregister',
        url: 'https://www.transparenzregister.de',
        description: 'Beneficial ownership register for German companies. Information on ultimate beneficial owners as required by anti-money laundering laws.',
        tags: ['Beneficial Ownership', 'AML', 'Official'],
      },
    ],
  },
  {
    title: 'Open Data Portals',
    icon: <Database className="w-5 h-5" />,
    sources: [
      {
        name: 'GovData',
        url: 'https://www.govdata.de',
        description: 'Germany\'s central open data portal. Aggregates datasets from federal, state, and municipal governments across all domains.',
        tags: ['Open Data', 'Government', 'Datasets'],
      },
      {
        name: 'Destatis (Federal Statistical Office)',
        url: 'https://www.destatis.de/EN/',
        description: 'Official statistics on Germany\'s economy, society, environment. GENESIS database with downloadable tables and API access.',
        tags: ['Statistics', 'Official', 'API'],
      },
      {
        name: 'FragDenStaat',
        url: 'https://fragdenstaat.de',
        description: 'Freedom of information portal. Submit and browse public information requests to German government agencies. Over 300,000 requests archived.',
        tags: ['FOI', 'Transparency', 'Community'],
      },
    ],
  },
  {
    title: 'Intellectual Property',
    icon: <Shield className="w-5 h-5" />,
    sources: [
      {
        name: 'DPMA (Deutsches Patent- und Markenamt)',
        url: 'https://www.dpma.de/english/',
        description: 'German Patent and Trade Mark Office. Search patents, trademarks, utility models, and registered designs. Free online search tools.',
        tags: ['Patents', 'Trademarks', 'Official'],
      },
      {
        name: 'DPMAregister',
        url: 'https://register.dpma.de/DPMAregister/Uebersicht',
        description: 'Online register for German IP rights. Real-time status of patents, trademarks, and designs with file inspection capabilities.',
        tags: ['Register', 'Free', 'Search'],
      },
    ],
  },
];

export function DEDataSourcesPage() {
  return (
    <div className="min-h-screen bg-gray-50">
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

      <div className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12 sm:py-16 text-center">
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
            Germany Legal Open Data Sources
          </h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            A curated directory of free and open data sources for German courts,
            legislation, commercial registers, and public data.
          </p>
        </div>
      </div>

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
                    <div className="flex items-start justify-between mb-2">
                      <h3 className="font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">{source.name}</h3>
                      <ExternalLink className="w-4 h-4 text-gray-400 group-hover:text-blue-500 flex-shrink-0 mt-0.5" />
                    </div>
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

      <footer className="border-t border-gray-200 bg-white mt-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 text-center text-sm text-gray-500">
          <p>&copy; {new Date().getFullYear()} SecondLayer. All rights reserved.</p>
          <p className="mt-1">This page is for informational purposes only. Links lead to third-party websites.</p>
        </div>
      </footer>
    </div>
  );
}
