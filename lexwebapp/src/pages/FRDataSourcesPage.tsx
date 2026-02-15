/**
 * France Open Data Sources Page
 * Public informational page listing French legal open data sources
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
        name: 'Legifrance — Jurisprudence',
        url: 'https://www.legifrance.gouv.fr/search/juri',
        description: 'Official French legal portal. Free access to decisions from the Cour de cassation, Conseil d\'Etat, Conseil constitutionnel, and courts of appeal.',
        tags: ['Official', 'Free', 'All Courts'],
      },
      {
        name: 'Conseil constitutionnel',
        url: 'https://www.conseil-constitutionnel.fr/decisions',
        description: 'Constitutional Council decisions database. All rulings on constitutional questions (QPC), election disputes, and legislative review.',
        tags: ['Constitutional', 'Official', 'Free'],
      },
      {
        name: 'Judilibre',
        url: 'https://www.courdecassation.fr/acces-rapide-judilibre',
        description: 'Cour de cassation open data portal. Full-text search of Supreme Court decisions with metadata, open API, and bulk download.',
        tags: ['Supreme Court', 'API', 'Open Data'],
      },
    ],
  },
  {
    title: 'Legislation',
    icon: <BookOpen className="w-5 h-5" />,
    sources: [
      {
        name: 'Legifrance',
        url: 'https://www.legifrance.gouv.fr',
        description: 'Official platform for all French law. Codes, laws, decrees, EU treaties, collective agreements — all consolidated and version-tracked.',
        tags: ['Official', 'Consolidated', 'Free'],
      },
      {
        name: 'Assemblee-nationale.fr',
        url: 'https://www.assemblee-nationale.fr/dyn/documents',
        description: 'National Assembly documents. Bills, committee reports, amendment tracking, session transcripts, and legislative dossiers.',
        tags: ['Parliament', 'Bills', 'Amendments'],
      },
      {
        name: 'Senat.fr',
        url: 'https://www.senat.fr/dossiers-legislatifs/index.html',
        description: 'French Senate legislative dossiers. Track bills through both chambers, access committee reports, debates, and voting records.',
        tags: ['Senate', 'Legislative Tracking', 'Votes'],
      },
    ],
  },
  {
    title: 'Regulations & Administrative Data',
    icon: <FileText className="w-5 h-5" />,
    sources: [
      {
        name: 'Journal officiel (JORF)',
        url: 'https://www.legifrance.gouv.fr/jorf/',
        description: 'Official Journal of the French Republic. Daily publication of new laws, decrees, ministerial orders, and official announcements.',
        tags: ['Official Journal', 'Daily', 'Free'],
      },
      {
        name: 'CNIL Decisions',
        url: 'https://www.cnil.fr/fr/les-sanctions-prononcees-par-la-cnil',
        description: 'French data protection authority sanctions and decisions. GDPR enforcement actions, guidance, and compliance recommendations.',
        tags: ['Data Protection', 'GDPR', 'Enforcement'],
      },
      {
        name: 'Autorite de la concurrence',
        url: 'https://www.autoritedelaconcurrence.fr/fr/decisions',
        description: 'French Competition Authority decisions. Merger control, antitrust rulings, sector inquiries, and opinions on market regulation.',
        tags: ['Competition', 'Antitrust', 'Official'],
      },
    ],
  },
  {
    title: 'Business Registries',
    icon: <Building2 className="w-5 h-5" />,
    sources: [
      {
        name: 'Pappers',
        url: 'https://www.pappers.fr',
        description: 'Free company information platform. Access to all French company data from official registers — financials, directors, statutes, and legal publications.',
        tags: ['Free', 'Company Data', 'Financials'],
      },
      {
        name: 'data.inpi.fr',
        url: 'https://data.inpi.fr',
        description: 'INPI open data portal. French national register of companies (RNCS), trademarks, patents, and designs — bulk API access.',
        tags: ['API', 'Bulk Data', 'Official'],
      },
      {
        name: 'Societe.com',
        url: 'https://www.societe.com',
        description: 'Company search and financial data. Key figures, legal announcements, director networks, and corporate structure for French companies.',
        tags: ['Company Search', 'Free Tier', 'Networks'],
      },
    ],
  },
  {
    title: 'Open Data Portals',
    icon: <Database className="w-5 h-5" />,
    sources: [
      {
        name: 'data.gouv.fr',
        url: 'https://www.data.gouv.fr',
        description: 'France\'s official open data platform. Over 45,000 datasets from public administration — budget, transport, health, education, and more.',
        tags: ['Open Data', 'Government', 'API'],
      },
      {
        name: 'INSEE',
        url: 'https://www.insee.fr/en/',
        description: 'National Institute of Statistics. Economic indicators, demographic data, census results, and national accounts with API access.',
        tags: ['Statistics', 'Official', 'API'],
      },
      {
        name: 'CADA — Transparency Decisions',
        url: 'https://www.cada.fr/administration/les-avis',
        description: 'Commission for Access to Administrative Documents. Opinions and guidance on public access to government information.',
        tags: ['Transparency', 'FOI', 'Guidance'],
      },
    ],
  },
  {
    title: 'Intellectual Property',
    icon: <Shield className="w-5 h-5" />,
    sources: [
      {
        name: 'INPI (Institut National de la Propriete Industrielle)',
        url: 'https://www.inpi.fr/en',
        description: 'French Industrial Property Office. Search patents, trademarks, designs, and geographical indications. Free online search tools.',
        tags: ['Patents', 'Trademarks', 'Official'],
      },
      {
        name: 'Espacenet — FR Patents',
        url: 'https://worldwide.espacenet.com/?locale=en_EP',
        description: 'European Patent Office search tool. Access French and worldwide patents with full-text search, patent families, and citation analysis.',
        tags: ['Patents', 'European', 'Free'],
      },
    ],
  },
];

export function FRDataSourcesPage() {
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
            France Legal Open Data Sources
          </h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            A curated directory of free and open data sources for French courts,
            legislation, company registers, and public data.
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
