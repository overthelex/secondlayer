/**
 * US Open Data Sources Page
 * Public informational page listing US legal open data sources
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
    title: 'Federal Courts',
    icon: <Scale className="w-5 h-5" />,
    sources: [
      {
        name: 'PACER',
        url: 'https://pacer.uscourts.gov',
        description: 'Public Access to Court Electronic Records. Federal court filings, dockets, and case documents across all U.S. district, bankruptcy, and appellate courts.',
        tags: ['Filings', 'Dockets', 'Federal'],
      },
      {
        name: 'CourtListener',
        url: 'https://www.courtlistener.com',
        description: 'Free Law Project\'s searchable database of millions of federal and state court opinions, oral arguments, and PACER filings.',
        tags: ['Opinions', 'Free', 'API'],
      },
      {
        name: 'RECAP Archive',
        url: 'https://www.courtlistener.com/recap/',
        description: 'Community-sourced archive of PACER documents. Free access to millions of federal court documents contributed by RECAP browser extension users.',
        tags: ['Free', 'Community', 'PACER Mirror'],
      },
    ],
  },
  {
    title: 'Legislation',
    icon: <BookOpen className="w-5 h-5" />,
    sources: [
      {
        name: 'Congress.gov',
        url: 'https://www.congress.gov',
        description: 'Official source for U.S. federal legislative information. Bill text, status, summaries, committee reports, and Congressional Record.',
        tags: ['Bills', 'Official', 'Federal'],
      },
      {
        name: 'GovInfo (GPO)',
        url: 'https://www.govinfo.gov',
        description: 'Government Publishing Office\'s digital repository. Federal Register, Code of Federal Regulations, Congressional documents, and more.',
        tags: ['Official', 'Bulk Data', 'API'],
      },
      {
        name: 'U.S. Code',
        url: 'https://uscode.house.gov',
        description: 'Official compilation of federal statutes organized by subject. Maintained by the Office of the Law Revision Counsel.',
        tags: ['Statutes', 'Official', 'Codified Law'],
      },
    ],
  },
  {
    title: 'Regulations',
    icon: <FileText className="w-5 h-5" />,
    sources: [
      {
        name: 'Federal Register',
        url: 'https://www.federalregister.gov',
        description: 'Daily journal of the U.S. government. Proposed rules, final rules, executive orders, and agency notices with full-text search and API.',
        tags: ['Rulemaking', 'API', 'Daily Updates'],
      },
      {
        name: 'eCFR',
        url: 'https://www.ecfr.gov',
        description: 'Electronic Code of Federal Regulations. Up-to-date, unofficial version of the CFR with full-text search and version comparison.',
        tags: ['Regulations', 'Current', 'Searchable'],
      },
      {
        name: 'Regulations.gov',
        url: 'https://www.regulations.gov',
        description: 'Public comment portal for federal rulemaking. Search proposed rules, submit comments, and access regulatory dockets.',
        tags: ['Public Comments', 'Rulemaking', 'API'],
      },
    ],
  },
  {
    title: 'Case Law',
    icon: <Scale className="w-5 h-5" />,
    sources: [
      {
        name: 'Caselaw Access Project',
        url: 'https://case.law',
        description: 'Harvard Law School\'s initiative providing free access to 6.9 million state and federal court decisions spanning 360+ years.',
        tags: ['Free', 'Historical', 'API', 'Bulk Data'],
      },
      {
        name: 'Google Scholar — Case Law',
        url: 'https://scholar.google.com',
        description: 'Free search engine for legal opinions and journals. Covers federal and state court opinions with citation analysis.',
        tags: ['Free', 'Search', 'Citations'],
      },
    ],
  },
  {
    title: 'Business Registries',
    icon: <Building2 className="w-5 h-5" />,
    sources: [
      {
        name: 'SEC EDGAR',
        url: 'https://www.sec.gov/edgar/searchedgar/companysearch',
        description: 'Electronic Data Gathering, Analysis, and Retrieval. Public company filings — 10-K, 10-Q, 8-K, proxy statements, and beneficial ownership reports.',
        tags: ['SEC Filings', 'Public Companies', 'API'],
      },
      {
        name: 'OpenCorporates',
        url: 'https://opencorporates.com',
        description: 'Largest open database of corporate entities worldwide. Aggregates data from state Secretaries of State and international registries.',
        tags: ['Corporate Data', 'Global', 'API'],
      },
    ],
  },
  {
    title: 'Open Data Portals',
    icon: <Database className="w-5 h-5" />,
    sources: [
      {
        name: 'Data.gov',
        url: 'https://data.gov',
        description: 'U.S. government\'s open data portal. Over 300,000 datasets from federal agencies covering health, education, finance, climate, and more.',
        tags: ['Datasets', 'Federal', 'Open Data'],
      },
      {
        name: 'USAspending.gov',
        url: 'https://www.usaspending.gov',
        description: 'Official source for federal spending data. Track government contracts, grants, loans, and other financial assistance awards.',
        tags: ['Spending', 'Contracts', 'API'],
      },
    ],
  },
  {
    title: 'Patents & Intellectual Property',
    icon: <Shield className="w-5 h-5" />,
    sources: [
      {
        name: 'USPTO PatentsView',
        url: 'https://patentsview.org',
        description: 'U.S. Patent and Trademark Office data platform. Searchable patent and inventor data with visualization tools and bulk download.',
        tags: ['Patents', 'API', 'Bulk Data'],
      },
      {
        name: 'Copyright.gov',
        url: 'https://www.copyright.gov',
        description: 'U.S. Copyright Office. Search copyright registrations, records, and learn about copyright law and registration process.',
        tags: ['Copyright', 'Official', 'Search'],
      },
    ],
  },
];

export function USDataSourcesPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <a
            href="/"
            className="flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
          >
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
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12 sm:py-16 text-center">
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
            U.S. Legal Open Data Sources
          </h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            A curated directory of free and open data sources for U.S. federal courts,
            legislation, regulations, case law, business registries, and more.
          </p>
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
                  <a
                    key={source.name}
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group block bg-white rounded-lg border border-gray-200 p-5 hover:border-blue-300 hover:shadow-md transition-all"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <h3 className="font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">
                        {source.name}
                      </h3>
                      <ExternalLink className="w-4 h-4 text-gray-400 group-hover:text-blue-500 flex-shrink-0 mt-0.5" />
                    </div>
                    <p className="text-sm text-gray-600 mb-3 leading-relaxed">
                      {source.description}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {source.tags.map((tag) => (
                        <span
                          key={tag}
                          className="inline-block text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700"
                        >
                          {tag}
                        </span>
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
          <p className="mt-1">
            This page is for informational purposes only. Links lead to third-party websites.
          </p>
        </div>
      </footer>
    </div>
  );
}
