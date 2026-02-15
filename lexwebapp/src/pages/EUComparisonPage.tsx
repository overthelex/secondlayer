/**
 * EU Open Data Comparison Page
 * Compares European countries with Ukraine across open data metrics
 */

import { ArrowLeft, Scale, TrendingUp, Database, Building2, FileText, Clock, CheckCircle, AlertCircle, MinusCircle } from 'lucide-react';

type Status = 'yes' | 'partial' | 'no';

interface CountryData {
  name: string;
  flag: string;
  maturityScore: number | null;
  maturityClass: string;
  datasets: string;
  courtDecisions: Status;
  courtNotes: string;
  businessRegistry: Status;
  registryNotes: string;
  foiYear: number;
  foiLaw: string;
  dataPortal: string;
  dataPortalUrl: string;
  highlight?: boolean;
}

const countries: CountryData[] = [
  {
    name: 'France',
    flag: 'FR',
    maturityScore: 100,
    maturityClass: 'Trendsetter',
    datasets: '~50,000',
    courtDecisions: 'partial',
    courtNotes: 'Legifrance has top courts; <1% of first-instance decisions published',
    businessRegistry: 'partial',
    registryNotes: 'Basic info via Pappers free; full data via INPI API',
    foiYear: 1978,
    foiLaw: 'Loi sur la transparence administrative',
    dataPortal: 'data.gouv.fr',
    dataPortalUrl: 'https://www.data.gouv.fr',
  },
  {
    name: 'Ukraine',
    flag: 'UA',
    maturityScore: 97,
    maturityClass: 'Trendsetter',
    datasets: '80,000+',
    courtDecisions: 'yes',
    courtNotes: 'Full Register of Court Decisions (REYESTR) since 2006',
    businessRegistry: 'partial',
    registryNotes: 'Basic data free via OpenReyestr; detailed reports paid',
    foiYear: 1992,
    foiLaw: 'Law on Information',
    dataPortal: 'data.gov.ua',
    dataPortalUrl: 'https://data.gov.ua',
    highlight: true,
  },
  {
    name: 'Poland',
    flag: 'PL',
    maturityScore: 98,
    maturityClass: 'Trendsetter',
    datasets: '43,000+',
    courtDecisions: 'yes',
    courtNotes: 'ECLI system, publicly accessible court decisions',
    businessRegistry: 'yes',
    registryNotes: 'KRS National Court Register — fully free, RESTful API',
    foiYear: 2001,
    foiLaw: 'Access to Public Information Act',
    dataPortal: 'dane.gov.pl',
    dataPortalUrl: 'https://dane.gov.pl',
  },
  {
    name: 'Spain',
    flag: 'ES',
    maturityScore: 95,
    maturityClass: 'Trendsetter',
    datasets: '100,000+',
    courtDecisions: 'yes',
    courtNotes: 'CENDOJ — free judicial search engine, ECLI system',
    businessRegistry: 'partial',
    registryNotes: 'Registro Mercantil basic free; detailed reports paid',
    foiYear: 2013,
    foiLaw: 'Transparency, Access and Good Governance Act',
    dataPortal: 'datos.gob.es',
    dataPortalUrl: 'https://datos.gob.es',
  },
  {
    name: 'Italy',
    flag: 'IT',
    maturityScore: 95,
    maturityClass: 'Trendsetter',
    datasets: '55,000+',
    courtDecisions: 'yes',
    courtNotes: 'ItalGiure, DeJure — court decisions publicly accessible',
    businessRegistry: 'partial',
    registryNotes: 'InfoCamere basic free; full data ~1 EUR per extract',
    foiYear: 1990,
    foiLaw: 'Law No. 241 (Chapter V)',
    dataPortal: 'dati.gov.it',
    dataPortalUrl: 'https://dati.gov.it',
  },
  {
    name: 'Estonia',
    flag: 'EE',
    maturityScore: 94,
    maturityClass: 'Trendsetter',
    datasets: '~800',
    courtDecisions: 'yes',
    courtNotes: 'Riigi Teataja — Supreme Court + lower courts, English available',
    businessRegistry: 'yes',
    registryNotes: 'e-Business Register — fully free since Oct 2022, bulk API',
    foiYear: 2000,
    foiLaw: 'Public Information Act',
    dataPortal: 'avaandmed.eesti.ee',
    dataPortalUrl: 'https://avaandmed.eesti.ee',
  },
  {
    name: 'Austria',
    flag: 'AT',
    maturityScore: 86,
    maturityClass: 'Fast-tracker',
    datasets: '55,000+',
    courtDecisions: 'yes',
    courtNotes: 'RIS (Rechtsinformationssystem) — free, official, comprehensive',
    businessRegistry: 'partial',
    registryNotes: 'Firmenbuch public searches available; some costs apply',
    foiYear: 1987,
    foiLaw: 'Auskunftspflichtgesetz (new comprehensive act 2025)',
    dataPortal: 'data.gv.at',
    dataPortalUrl: 'https://data.gv.at',
  },
  {
    name: 'Germany',
    flag: 'DE',
    maturityScore: 77,
    maturityClass: 'Follower',
    datasets: '120,000+',
    courtDecisions: 'yes',
    courtNotes: 'openJur community DB + official federal/state portals',
    businessRegistry: 'partial',
    registryNotes: 'Unternehmensregister free basic; Handelsregister paid extracts',
    foiYear: 2005,
    foiLaw: 'Informationsfreiheitsgesetz (IFG)',
    dataPortal: 'govdata.de',
    dataPortalUrl: 'https://www.govdata.de',
  },
  {
    name: 'Netherlands',
    flag: 'NL',
    maturityScore: 77,
    maturityClass: 'Follower',
    datasets: '20,000+',
    courtDecisions: 'yes',
    courtNotes: 'Rechtspraak.nl — free, daily updates, open XML API',
    businessRegistry: 'partial',
    registryNotes: 'KVK basic search free; extracts 2.85-18.55 EUR',
    foiYear: 1978,
    foiLaw: 'Wet open overheid (Woo, replaced Wob)',
    dataPortal: 'data.overheid.nl',
    dataPortalUrl: 'https://data.overheid.nl',
  },
  {
    name: 'United Kingdom',
    flag: 'GB',
    maturityScore: null,
    maturityClass: 'Not assessed',
    datasets: '47,000+',
    courtDecisions: 'yes',
    courtNotes: 'National Archives case law + BAILII, senior courts & tribunals',
    businessRegistry: 'yes',
    registryNotes: 'Companies House — fully free, bulk downloads, streaming API',
    foiYear: 2000,
    foiLaw: 'Freedom of Information Act 2000',
    dataPortal: 'data.gov.uk',
    dataPortalUrl: 'https://www.data.gov.uk',
  },
];

function StatusBadge({ status, label }: { status: Status; label: string }) {
  if (status === 'yes') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full bg-green-50 text-green-700">
        <CheckCircle className="w-3 h-3" /> {label}
      </span>
    );
  }
  if (status === 'partial') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full bg-amber-50 text-amber-700">
        <AlertCircle className="w-3 h-3" /> {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full bg-red-50 text-red-700">
      <MinusCircle className="w-3 h-3" /> {label}
    </span>
  );
}

function MaturityBar({ score, className: cls }: { score: number | null; className: string }) {
  if (score === null) {
    return <span className="text-xs text-gray-400 italic">N/A</span>;
  }
  const color = score >= 90 ? 'bg-green-500' : score >= 80 ? 'bg-blue-500' : score >= 70 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs font-medium text-gray-700 w-8 text-right">{score}%</span>
      <span className="text-xs text-gray-400 hidden sm:inline">({cls})</span>
    </div>
  );
}

const statusLabels: Record<Status, string> = { yes: 'Free', partial: 'Partial', no: 'No' };

export function EUComparisonPage() {
  const sorted = [...countries].sort((a, b) => (b.maturityScore ?? 0) - (a.maturityScore ?? 0));

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
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
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12 sm:py-16 text-center">
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
            EU Open Data Comparison
          </h1>
          <p className="text-lg text-gray-600 max-w-3xl mx-auto">
            How does Ukraine compare with European countries on open legal data?
            Maturity scores, dataset volumes, court transparency, and business registry
            access — side by side.
          </p>
          <p className="text-sm text-gray-400 mt-3">
            Source: EU Open Data Maturity Report 2024 (data.europa.eu)
          </p>
        </div>
      </div>

      {/* Key Insights */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="w-4 h-4 text-green-600" />
              <span className="text-sm font-semibold text-gray-900">Ukraine: 97%</span>
            </div>
            <p className="text-xs text-gray-500">Open Data Maturity score — 3rd in Europe, ahead of most EU members</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <div className="flex items-center gap-2 mb-2">
              <Database className="w-4 h-4 text-blue-600" />
              <span className="text-sm font-semibold text-gray-900">80,000+ datasets</span>
            </div>
            <p className="text-xs text-gray-500">Ukraine's data.gov.ua — one of the largest national portals in Europe</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <div className="flex items-center gap-2 mb-2">
              <Scale className="w-4 h-4 text-purple-600" />
              <span className="text-sm font-semibold text-gray-900">Full court access</span>
            </div>
            <p className="text-xs text-gray-500">Ukraine publishes all court decisions since 2006 — REYESTR with 100M+ records</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <div className="flex items-center gap-2 mb-2">
              <Building2 className="w-4 h-4 text-amber-600" />
              <span className="text-sm font-semibold text-gray-900">3 fully free registries</span>
            </div>
            <p className="text-xs text-gray-500">Only Estonia, UK, and Poland offer fully free business registry data</p>
          </div>
        </div>
      </div>

      {/* Maturity Rankings */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pb-8">
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-blue-600" />
              Open Data Maturity Index 2024
            </h2>
            <p className="text-sm text-gray-500 mt-1">EU assessment covering policy, impact, portal quality, and data quality</p>
          </div>
          <div className="divide-y divide-gray-50">
            {sorted.map((c, i) => (
              <div key={c.name} className={`px-5 py-3 flex items-center gap-4 ${c.highlight ? 'bg-blue-50/50' : ''}`}>
                <span className="text-sm text-gray-400 w-6 text-right">{i + 1}.</span>
                <span className="text-lg w-8">{getFlagEmoji(c.flag)}</span>
                <span className={`text-sm font-medium w-28 ${c.highlight ? 'text-blue-700' : 'text-gray-900'}`}>{c.name}</span>
                <div className="flex-1 max-w-md">
                  <MaturityBar score={c.maturityScore} className={c.maturityClass} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Detailed Comparison Table */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pb-8">
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <FileText className="w-5 h-5 text-blue-600" />
              Detailed Comparison
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left">
                  <th className="px-4 py-3 font-semibold text-gray-700 sticky left-0 bg-gray-50 z-[1]">Country</th>
                  <th className="px-4 py-3 font-semibold text-gray-700">Datasets</th>
                  <th className="px-4 py-3 font-semibold text-gray-700">Court Decisions</th>
                  <th className="px-4 py-3 font-semibold text-gray-700">Business Registry</th>
                  <th className="px-4 py-3 font-semibold text-gray-700">FOI Law</th>
                  <th className="px-4 py-3 font-semibold text-gray-700">Data Portal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sorted.map((c) => (
                  <tr key={c.name} className={c.highlight ? 'bg-blue-50/30' : 'hover:bg-gray-50'}>
                    <td className={`px-4 py-3 font-medium sticky left-0 z-[1] ${c.highlight ? 'bg-blue-50/30' : 'bg-white'}`}>
                      <span className="mr-2">{getFlagEmoji(c.flag)}</span>
                      <span className={c.highlight ? 'text-blue-700' : ''}>{c.name}</span>
                    </td>
                    <td className="px-4 py-3 text-gray-700 font-medium">{c.datasets}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={c.courtDecisions} label={statusLabels[c.courtDecisions]} />
                      <p className="text-xs text-gray-400 mt-1 max-w-[200px]">{c.courtNotes}</p>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={c.businessRegistry} label={statusLabels[c.businessRegistry]} />
                      <p className="text-xs text-gray-400 mt-1 max-w-[200px]">{c.registryNotes}</p>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Clock className="w-3 h-3 text-gray-400" />
                        <span className="text-gray-700">{c.foiYear}</span>
                      </div>
                      <p className="text-xs text-gray-400 mt-1 max-w-[180px]">{c.foiLaw}</p>
                    </td>
                    <td className="px-4 py-3">
                      <a href={c.dataPortalUrl} target="_blank" rel="noopener noreferrer"
                        className="text-blue-600 hover:text-blue-800 hover:underline text-xs font-medium">
                        {c.dataPortal}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Methodology */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pb-10">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Methodology & Sources</h3>
          <ul className="text-xs text-gray-500 space-y-1">
            <li>Open Data Maturity scores from the <a href="https://data.europa.eu/en/open-data-maturity/2024" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">2024 EU Open Data Maturity Report</a> by data.europa.eu</li>
            <li>Dataset counts from each country's national open data portal (as of early 2025)</li>
            <li>Court decision and business registry access assessed based on official portal capabilities</li>
            <li>FOI law dates reflect the year of first major freedom-of-information legislation</li>
            <li>The UK is not included in EU assessment as it is no longer an EU member state</li>
          </ul>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-gray-200 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 text-center text-sm text-gray-500">
          <p>&copy; {new Date().getFullYear()} SecondLayer. All rights reserved.</p>
          <p className="mt-1">This page is for informational purposes only. Data sourced from official EU reports and national portals.</p>
        </div>
      </footer>
    </div>
  );
}

function getFlagEmoji(countryCode: string): string {
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map((char) => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}
