/**
 * Netherlands Open Data Sources Page
 * Public informational page listing Dutch legal open data sources
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
        name: 'Rechtspraak.nl',
        url: 'https://www.rechtspraak.nl/Uitspraken/Paginas/default.aspx',
        description: 'Official judiciary portal. Free access to published court decisions from all Dutch courts — Supreme Court, courts of appeal, district courts, and tribunals.',
        tags: ['Official', 'Free', 'All Courts'],
      },
      {
        name: 'Rechtspraak Open Data',
        url: 'https://www.rechtspraak.nl/Uitspraken/Paginas/Uitspraken-Open-Data.aspx',
        description: 'Bulk data feed of Dutch court decisions in XML format. Updated daily with full-text rulings via open API for developers and researchers.',
        tags: ['API', 'Bulk Data', 'XML'],
      },
      {
        name: 'ECLI Search (European Case Law Identifier)',
        url: 'https://linkeddata.overheid.nl/front/portal/ecli',
        description: 'Search Dutch and European case law by ECLI number. Linked open data with cross-references between court decisions.',
        tags: ['Linked Data', 'ECLI', 'Cross-reference'],
      },
    ],
  },
  {
    title: 'Legislation',
    icon: <BookOpen className="w-5 h-5" />,
    sources: [
      {
        name: 'wetten.overheid.nl',
        url: 'https://wetten.overheid.nl',
        description: 'Official consolidated legislation portal. All Dutch acts, decrees, and regulations in their current form with version history and linked data.',
        tags: ['Official', 'Consolidated', 'Free'],
      },
      {
        name: 'Tweede Kamer (House of Representatives)',
        url: 'https://www.tweedekamer.nl/kamerstukken',
        description: 'Parliamentary documents. Bills, motions, amendments, committee reports, and plenary debates from the Dutch lower house.',
        tags: ['Parliament', 'Bills', 'Debates'],
      },
      {
        name: 'Eerste Kamer (Senate)',
        url: 'https://www.eerstekamer.nl/wetsvoorstellen',
        description: 'Dutch Senate legislative tracking. Bills in the final stage of parliamentary review with debates, voting records, and committee proceedings.',
        tags: ['Senate', 'Bills', 'Voting'],
      },
    ],
  },
  {
    title: 'Regulations & Government Publications',
    icon: <FileText className="w-5 h-5" />,
    sources: [
      {
        name: 'Staatscourant (Government Gazette)',
        url: 'https://zoek.officielebekendmakingen.nl/zoeken/staatscourant',
        description: 'Official government gazette. Ministerial orders, policy rules, subsidy regulations, and official announcements — searchable archive since 2009.',
        tags: ['Gazette', 'Official', 'Searchable'],
      },
      {
        name: 'Autoriteit Persoonsgegevens',
        url: 'https://www.autoriteitpersoonsgegevens.nl/nl/publicaties',
        description: 'Dutch Data Protection Authority publications. GDPR enforcement decisions, guidelines, investigation reports, and annual reviews.',
        tags: ['Data Protection', 'GDPR', 'Enforcement'],
      },
      {
        name: 'Autoriteit Consument & Markt (ACM)',
        url: 'https://www.acm.nl/nl/publicaties',
        description: 'Consumer and market authority decisions. Competition enforcement, telecom regulation, energy market oversight, and consumer protection.',
        tags: ['Competition', 'Consumer', 'Telecom'],
      },
    ],
  },
  {
    title: 'Business Registries',
    icon: <Building2 className="w-5 h-5" />,
    sources: [
      {
        name: 'KVK (Kamer van Koophandel)',
        url: 'https://www.kvk.nl/zoeken/',
        description: 'Dutch Chamber of Commerce company search. Basic company information is free — registration number, address, legal form, and active status.',
        tags: ['Official', 'Company Search', 'Free Basics'],
      },
      {
        name: 'KVK Open Data API',
        url: 'https://developers.kvk.nl',
        description: 'Developer API for Chamber of Commerce data. Search companies, retrieve profiles, and access trade register information programmatically.',
        tags: ['API', 'Developer', 'Official'],
      },
      {
        name: 'UBO Register',
        url: 'https://www.kvk.nl/inschrijven-en-wijzigen/ubo-register/',
        description: 'Ultimate Beneficial Owner register maintained by KVK. Information on beneficial owners of Dutch companies and legal entities.',
        tags: ['Beneficial Ownership', 'AML', 'Official'],
      },
    ],
  },
  {
    title: 'Open Data Portals',
    icon: <Database className="w-5 h-5" />,
    sources: [
      {
        name: 'data.overheid.nl',
        url: 'https://data.overheid.nl',
        description: 'Dutch government open data portal. Over 18,000 datasets from national, provincial, and municipal governments with DCAT metadata.',
        tags: ['Open Data', 'Government', 'DCAT'],
      },
      {
        name: 'CBS (Centraal Bureau voor de Statistiek)',
        url: 'https://www.cbs.nl/en-gb',
        description: 'Statistics Netherlands. Comprehensive statistics on economy, population, trade, health, and society with open API (StatLine).',
        tags: ['Statistics', 'API', 'Official'],
      },
      {
        name: 'PDOK (Public Services on the Map)',
        url: 'https://www.pdok.nl',
        description: 'Dutch geospatial open data platform. Cadastral data, topographic maps, BAG (address registry), and environmental datasets via standard APIs.',
        tags: ['Geospatial', 'Cadastre', 'API'],
      },
    ],
  },
  {
    title: 'Intellectual Property',
    icon: <Shield className="w-5 h-5" />,
    sources: [
      {
        name: 'BOIP (Benelux IP Office)',
        url: 'https://www.boip.int/en',
        description: 'Benelux Office for Intellectual Property. Search and register trademarks and designs valid across Netherlands, Belgium, and Luxembourg.',
        tags: ['Trademarks', 'Designs', 'Benelux'],
      },
      {
        name: 'Espacenet — NL Patents',
        url: 'https://worldwide.espacenet.com',
        description: 'European Patent Office search tool. Access Dutch and worldwide patents with full-text search, patent families, and legal status information.',
        tags: ['Patents', 'European', 'Free'],
      },
    ],
  },
];

export function NLDataSourcesPage() {
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
            Netherlands Legal Open Data Sources
          </h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            A curated directory of free and open data sources for Dutch courts,
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
