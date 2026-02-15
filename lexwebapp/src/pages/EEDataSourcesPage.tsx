/**
 * Estonia Open Data Sources Page
 * Public informational page listing Estonian legal open data sources
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
        name: 'Riigi Teataja — Court Decisions',
        url: 'https://www.riigiteataja.ee/kohtulahendid.html',
        description: 'Official state gazette court decisions portal. Searchable database of Supreme Court, circuit court, and county court rulings in Estonian and English.',
        tags: ['Official', 'Free', 'English Available'],
      },
      {
        name: 'Supreme Court of Estonia',
        url: 'https://www.riigikohus.ee/en',
        description: 'Riigikohus decisions database. Full text of constitutional review, civil, criminal, and administrative chamber judgments with English translations.',
        tags: ['Supreme Court', 'English', 'Free'],
      },
      {
        name: 'KIS (Court Information System)',
        url: 'https://www.kohus.ee/en',
        description: 'Estonian courts portal. Court calendar, public hearings, e-file access, and general information about the court system.',
        tags: ['Court System', 'E-file', 'Public'],
      },
    ],
  },
  {
    title: 'Legislation',
    icon: <BookOpen className="w-5 h-5" />,
    sources: [
      {
        name: 'Riigi Teataja (State Gazette)',
        url: 'https://www.riigiteataja.ee/en/',
        description: 'Official electronic legislation portal. All Estonian acts, regulations, and local government legislation in consolidated form. English translations for major laws.',
        tags: ['Official', 'Consolidated', 'English'],
      },
      {
        name: 'Riigikogu (Parliament)',
        url: 'https://www.riigikogu.ee/en/legislation/',
        description: 'Estonian Parliament legislative tracker. Bills, proceedings, committee reports, voting records, and plenary session transcripts.',
        tags: ['Parliament', 'Bills', 'Voting'],
      },
      {
        name: 'eelnoud.valitsus.ee',
        url: 'https://eelnoud.valitsus.ee',
        description: 'Government draft legislation system (EIS). Track draft laws and regulations during the government coordination phase before parliament.',
        tags: ['Drafts', 'Government', 'Pre-parliamentary'],
      },
    ],
  },
  {
    title: 'Regulations & E-Government',
    icon: <FileText className="w-5 h-5" />,
    sources: [
      {
        name: 'eesti.ee',
        url: 'https://www.eesti.ee/en/',
        description: 'Estonia\'s central e-government portal. Digital public services, government information, and citizen-facing administrative procedures.',
        tags: ['E-Government', 'Services', 'Digital'],
      },
      {
        name: 'Andmekaitse Inspektsioon (DPA)',
        url: 'https://www.aki.ee/en',
        description: 'Estonian Data Protection Inspectorate. GDPR enforcement decisions, guidelines, and supervisory reports on data protection compliance.',
        tags: ['Data Protection', 'GDPR', 'Enforcement'],
      },
      {
        name: 'Konkurentsiamet',
        url: 'https://www.konkurentsiamet.ee/en',
        description: 'Estonian Competition Authority. Competition enforcement decisions, merger control, and energy/telecom/water/rail regulatory oversight.',
        tags: ['Competition', 'Energy', 'Telecom'],
      },
    ],
  },
  {
    title: 'Business Registries',
    icon: <Building2 className="w-5 h-5" />,
    sources: [
      {
        name: 'e-Business Register',
        url: 'https://ariregister.rik.ee/eng',
        description: 'Estonian commercial register. Free basic search for all legal entities — company data, board members, share capital, and annual reports.',
        tags: ['Free', 'Official', 'Company Data'],
      },
      {
        name: 'e-Business Register Open Data',
        url: 'https://avaandmed.ariregister.rik.ee',
        description: 'Bulk open data from the Estonian business register. Downloadable datasets of companies, annual reports, and beneficial ownership data.',
        tags: ['Open Data', 'Bulk Download', 'API'],
      },
      {
        name: 'Land Register',
        url: 'https://kinnistusraamat.rik.ee/en/',
        description: 'Estonian electronic land register. Search property ownership, encumbrances, mortgages, and real estate transaction records.',
        tags: ['Property', 'Official', 'E-Register'],
      },
    ],
  },
  {
    title: 'Open Data Portals',
    icon: <Database className="w-5 h-5" />,
    sources: [
      {
        name: 'Estonian Open Data Portal',
        url: 'https://avaandmed.eesti.ee',
        description: 'National open data platform. Datasets from government agencies covering economy, environment, transport, health, education, and public finances.',
        tags: ['Open Data', 'Government', 'Datasets'],
      },
      {
        name: 'Statistics Estonia',
        url: 'https://andmed.stat.ee/en/stat',
        description: 'Official statistical database. Economic indicators, population, trade, tourism, and social statistics with interactive tools and API.',
        tags: ['Statistics', 'API', 'Interactive'],
      },
      {
        name: 'X-Road Data Tracker',
        url: 'https://x-tee.ee/factsheet/EE/',
        description: 'Estonia\'s X-Road data exchange layer statistics. Monitor inter-institutional data exchange, service usage, and digital infrastructure metrics.',
        tags: ['X-Road', 'Infrastructure', 'Statistics'],
      },
    ],
  },
  {
    title: 'Intellectual Property',
    icon: <Shield className="w-5 h-5" />,
    sources: [
      {
        name: 'Estonian Patent Office',
        url: 'https://www.epa.ee/en',
        description: 'Patents, trademarks, utility models, and industrial designs in Estonia. Online search tools and electronic filing system.',
        tags: ['Patents', 'Trademarks', 'Official'],
      },
      {
        name: 'EPA Register Search',
        url: 'https://register2.epa.ee',
        description: 'Search Estonian IP registers. Trademarks, patents, utility models, and industrial designs with status tracking and document access.',
        tags: ['Register', 'Search', 'Free'],
      },
    ],
  },
];

export function EEDataSourcesPage() {
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
            Estonia Legal Open Data Sources
          </h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            A curated directory of free and open data sources for Estonian courts,
            legislation, e-government services, business registers, and public data.
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
