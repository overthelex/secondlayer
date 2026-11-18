import type { VaultDocument } from '../../../types/models/Message';
import type { EvidenceResult, ToolResultData } from './types';

/**
 * Financial-statement key figures (search_registry registry=financial_statements,
 * get_financial_statements and the financial_statements section of
 * get_company_dossier) go to the right panel as
 * one document per filing, figures in the snippet.
 */

interface Figure {
  key: string;
  line: string;
  label: string;
  current: number | null;
  prior: number | null;
}

const fmt = (n: number) => n.toLocaleString('uk-UA', { maximumFractionDigits: 1 });

function figuresSnippet(figures: Figure[], units: string, columns: ToolResultData | undefined): string {
  const priorLabel = (f: Figure) =>
    (f.key.startsWith('net_') || f.key.endsWith('_profit') || f.key === 'profit_before_tax'
      ? columns?.income?.prior
      : columns?.balance?.prior) || 'попередній період';
  return figures
    .filter((f) => f.current !== null || f.prior !== null)
    .map((f) => {
      const cur = f.current !== null ? `${fmt(f.current)} ${units}` : '—';
      const pri = f.prior !== null ? ` (${priorLabel(f)}: ${fmt(f.prior)})` : '';
      return `${f.label} [р. ${f.line}]: ${cur}${pri}`;
    })
    .join(' • ');
}

function filingToDocument(r: ToolResultData, edrpou?: string): VaultDocument {
  const units = r.units || 'тис. грн';
  return {
    id: `finstmt-${r.tin || edrpou || ''}-${r.period_year}-${r.period_month}-${r.form_type || r.c_doc_sub}${r.source ? `-${r.source}` : ''}`,
    title: `Фінансова звітність, ${r.period || r.period_year}: ${r.form_name || r.form_type}`,
    type: 'other',
    metadata: {
      snippet: [
        (r.tin || edrpou) && `ЄДРПОУ: ${r.tin || edrpou}`,
        r.report_date && `Станом на ${r.report_date}`,
        r.filed_on && `Подано ${r.filed_on}`,
        figuresSnippet(r.figures as Figure[], units, r.columns),
        r.balance_check === false && 'Актив (р. 1300) не дорівнює пасиву (р. 1900) у поданому звіті',
      ].filter(Boolean).join(' • '),
      edrpou: r.tin || edrpou,
      source: r.source_name || 'Фінансова звітність (ДПС, data.gov.ua)',
    },
  };
}

export function extractFinancialEvidence(toolName: string, parsed: ToolResultData): EvidenceResult {
  const documents: VaultDocument[] = [];

  if (toolName === 'search_registry' && Array.isArray(parsed.results)) {
    for (const r of parsed.results) {
      if (r && Array.isArray(r.figures) && r.figures.length && r.form_type) documents.push(filingToDocument(r));
    }
  }

  if (toolName === 'get_financial_statements' && Array.isArray(parsed.results)) {
    for (const r of parsed.results) {
      if (r && Array.isArray(r.figures) && r.figures.length) documents.push(filingToDocument(r, parsed.edrpou));
    }
  }

  if (toolName === 'get_company_dossier') {
    const latest = parsed.sections?.financial_statements?.latest;
    if (latest && Array.isArray(latest.figures) && latest.figures.length) {
      documents.push({
        id: `finstmt-latest-${parsed.edrpou}-${latest.period_year}-${latest.period_month}`,
        title: `Фінансова звітність, ${latest.period}`,
        type: 'other',
        metadata: {
          snippet: [
            parsed.edrpou && `ЄДРПОУ: ${parsed.edrpou}`,
            latest.source && `Джерело: ${latest.source}`,
            figuresSnippet(latest.figures as Figure[], latest.units || 'тис. грн', latest.columns),
          ].filter(Boolean).join(' • '),
          edrpou: parsed.edrpou,
          source: 'Фінансова звітність (ДПС, data.gov.ua)',
        },
      });
    }
  }

  return { decisions: [], citations: [], documents };
}
