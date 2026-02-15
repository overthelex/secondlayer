/**
 * UK Open Data Sources Page
 * Public informational page listing UK legal open data sources
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
    title: 'Courts & Tribunals',
    icon: <Scale className="w-5 h-5" />,
    sources: [
      {
        name: 'The National Archives — Case Law',
        url: 'https://caselaw.nationalarchives.gov.uk',
        description: 'Official repository of UK court judgments. Free access to decisions from the Supreme Court, Court of Appeal, High Court, and tribunals.',
        tags: ['Judgments', 'Official', 'Free'],
      },
      {
        name: 'BAILII',
        url: 'https://www.bailii.org',
        description: 'British and Irish Legal Information Institute. Free searchable database of case law from UK and Irish courts, plus EU courts.',
        tags: ['Case Law', 'Free', 'Searchable'],
      },
      {
        name: 'Courts and Tribunals Judiciary',
        url: 'https://www.judiciary.uk',
        description: 'Official judiciary website with recent judgments, practice directions, sentencing remarks, and judicial guidance.',
        tags: ['Judiciary', 'Official', 'Guidance'],
      },
    ],
  },
  {
    title: 'Legislation',
    icon: <BookOpen className="w-5 h-5" />,
    sources: [
      {
        name: 'Legislation.gov.uk',
        url: 'https://www.legislation.gov.uk',
        description: 'Official home of UK legislation. Acts of Parliament, Statutory Instruments, Scottish/Welsh/NI legislation with revision tracking and API.',
        tags: ['Official', 'API', 'Revised Law'],
      },
      {
        name: 'UK Parliament — Bills',
        url: 'https://bills.parliament.uk',
        description: 'Track Bills through Parliament. Full text, amendments, committee stages, debates, and voting records for current and past sessions.',
        tags: ['Bills', 'Parliamentary', 'Tracking'],
      },
      {
        name: 'Hansard',
        url: 'https://hansard.parliament.uk',
        description: 'Official record of UK Parliamentary debates. Searchable transcripts from House of Commons and House of Lords since 1803.',
        tags: ['Debates', 'Official', 'Historical'],
      },
    ],
  },
  {
    title: 'Regulations & Guidance',
    icon: <FileText className="w-5 h-5" />,
    sources: [
      {
        name: 'GOV.UK',
        url: 'https://www.gov.uk',
        description: 'Central UK government portal. Policy papers, consultations, regulatory guidance, and official publications from all departments.',
        tags: ['Government', 'Policy', 'Guidance'],
      },
      {
        name: 'Financial Conduct Authority',
        url: 'https://www.fca.org.uk/about/handbook',
        description: 'FCA Handbook with financial regulations, sourcebooks, and regulatory guides. Searchable with version history.',
        tags: ['Financial', 'Regulations', 'Handbook'],
      },
      {
        name: 'ICO — Data Protection',
        url: 'https://ico.org.uk',
        description: 'Information Commissioner\'s Office. UK GDPR guidance, enforcement actions, decision notices, and data protection resources.',
        tags: ['Data Protection', 'GDPR', 'Enforcement'],
      },
    ],
  },
  {
    title: 'Business Registries',
    icon: <Building2 className="w-5 h-5" />,
    sources: [
      {
        name: 'Companies House',
        url: 'https://find-and-update.company-information.service.gov.uk',
        description: 'Official UK company register. Free access to company filings, director details, accounts, charges, and beneficial ownership (PSC) data.',
        tags: ['Free', 'API', 'Company Data'],
      },
      {
        name: 'Companies House API',
        url: 'https://developer.company-information.service.gov.uk',
        description: 'RESTful API for Companies House data. Bulk downloads, streaming API for real-time filing updates, and search endpoints.',
        tags: ['API', 'Bulk Data', 'Real-time'],
      },
      {
        name: 'Land Registry — Price Paid Data',
        url: 'https://www.gov.uk/government/collections/price-paid-data',
        description: 'HM Land Registry data on property transactions in England and Wales. Monthly updates with full price paid records since 1995.',
        tags: ['Property', 'Open Data', 'Monthly'],
      },
    ],
  },
  {
    title: 'Open Data Portals',
    icon: <Database className="w-5 h-5" />,
    sources: [
      {
        name: 'data.gov.uk',
        url: 'https://www.data.gov.uk',
        description: 'UK government\'s central open data portal. Thousands of datasets from central and local government covering transport, health, crime, and more.',
        tags: ['Open Data', 'Government', 'Datasets'],
      },
      {
        name: 'Office for National Statistics',
        url: 'https://www.ons.gov.uk',
        description: 'UK\'s largest independent producer of official statistics. Census, population, economy, labour market, and social data.',
        tags: ['Statistics', 'Official', 'API'],
      },
      {
        name: 'Charity Commission',
        url: 'https://register-of-charities.charitycommission.gov.uk',
        description: 'Register of charities in England and Wales. Search charity details, finances, trustees, and regulatory actions.',
        tags: ['Charities', 'Free', 'Register'],
      },
    ],
  },
  {
    title: 'Intellectual Property',
    icon: <Shield className="w-5 h-5" />,
    sources: [
      {
        name: 'Intellectual Property Office',
        url: 'https://www.gov.uk/government/organisations/intellectual-property-office',
        description: 'UK IPO. Search patents, trademarks, and registered designs. Free patent search via Espacenet integration.',
        tags: ['Patents', 'Trademarks', 'Official'],
      },
      {
        name: 'IPO — Patent Search',
        url: 'https://www.ipo.gov.uk/p-find-publication.htm',
        description: 'Search published UK patent applications and granted patents. Includes patent journal and decisions database.',
        tags: ['Patents', 'Search', 'Free'],
      },
    ],
  },
];

export function UKDataSourcesPage() {
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
            UK Legal Open Data Sources
          </h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            A curated directory of free and open data sources for UK courts,
            legislation, regulations, company registries, and public data.
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
