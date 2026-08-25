import type { Decision, Citation } from '../../../types/models/Message';
import type { EvidenceResult, ToolResultData } from './types';
import { formatLegislationText } from './format-legislation';

/**
 * Swiss (CH) tool result → evidence panel extraction.
 *
 * Unlike the other extractors, matching is by exact tool name rather than
 * `toolName.includes(...)` — the CH tool names (`ch_search_court_decisions`,
 * `ch_get_court_decision`) are substrings of existing EDRSR tool names
 * (`search_court_decisions`, `get_court_decision`), so a loose match would
 * double-fire the EDRSR extractor in court.ts against CH row shapes and
 * produce bogus reyestr.court.gov.ua links. court.ts is guarded against this
 * with a `ch_` prefix exclusion; this file additionally only matches the
 * exact CH tool names it knows about.
 */

const CH_COURT_TOOLS = new Set(['ch_search_court_decisions', 'ch_get_court_decision']);
const CH_LEGISLATION_TOOLS = new Set(['ch_search_legislation', 'ch_get_act_article', 'ch_get_act_history']);

const MAX_HISTORY_CITATIONS = 50;
const SUMMARY_FULL_TEXT_CHARS = 500;

function chDecisionTitle(row: ToolResultData): string {
  const court = row.court_name || row.court_code || '';
  const number = row.docket_number || row.ecli || '';
  return [court, number].filter(Boolean).join(' · ');
}

function chDecisionSummary(row: ToolResultData): string {
  if (row.snippet) return String(row.snippet);
  if (row.abstract) return String(row.abstract);
  if (typeof row.full_text === 'string' && row.full_text.length > 0) {
    return row.full_text.slice(0, SUMMARY_FULL_TEXT_CHARS);
  }
  return '';
}

function toDecision(row: ToolResultData): Decision {
  return {
    id: row.ecli || `ch-${row.doc_id || Math.random().toString(36).slice(2, 8)}`,
    number: chDecisionTitle(row),
    court: row.court_name || row.court_code || '',
    date: row.decision_date || '',
    summary: chDecisionSummary(row),
    relevance: 100,
    status: 'active',
    externalUrl: row.html_url || row.pdf_url || undefined,
    docId: row.doc_id ? String(row.doc_id) : undefined,
  };
}

function extractChCourtEvidence(toolName: string, parsed: ToolResultData): EvidenceResult {
  const decisions: Decision[] = [];

  if (toolName === 'ch_search_court_decisions') {
    const rows = Array.isArray(parsed.results) ? parsed.results : [];
    for (const row of rows) decisions.push(toDecision(row));
  } else if (toolName === 'ch_get_court_decision') {
    // Error payload: { error: 'not_found', ecli, doc_id }
    if (!parsed.error && (parsed.ecli || parsed.doc_id)) {
      decisions.push(toDecision(parsed));
    }
  }

  return { decisions, citations: [], documents: [] };
}

function chActTitle(act: ToolResultData): string {
  return act.sr_number ? `${act.title} (SR ${act.sr_number})` : String(act.title || '');
}

function chActSearchCitation(row: ToolResultData): Citation {
  const npaTitle = chActTitle(row);
  const status = row.in_force ? 'Чинний' : 'Не чинний';
  const from = row.date_entry_force ? ` з ${row.date_entry_force}` : '';
  const until = row.date_no_longer_in_force ? ` до ${row.date_no_longer_in_force}` : '';
  const editions = row.editions_count != null
    ? ` Редакцій: ${row.editions_count}${row.latest_edition_date ? ` (остання: ${row.latest_edition_date})` : ''}.`
    : '';
  const abbrev = row.abbreviation ? `${row.abbreviation}. ` : '';
  const text = `${abbrev}${row.title || ''}. ${status}${from}${until}.${editions}`.trim();

  return {
    text: formatLegislationText(text),
    source: npaTitle,
    npaTitle,
    url: row.eli_work_uri || undefined,
  };
}

function chArticleCitation(parsed: ToolResultData): Citation {
  const article = parsed.article || {};
  const version = parsed.version || {};
  const npaTitle = `Art. ${article.article_number} ${parsed.abbreviation} (SR ${parsed.sr_number})`;
  const editionInterval = version.date_applicability
    ? `${version.date_applicability} — ${version.date_end_applicability || 'донині'}`
    : undefined;

  return {
    text: formatLegislationText(article.text || ''),
    source: npaTitle,
    npaTitle,
    articleNumber: article.article_number ? String(article.article_number) : undefined,
    url: version.eli_consolidation_uri || undefined,
    sectionTitle: editionInterval,
  };
}

function chHistoryCitation(parsed: ToolResultData, change: ToolResultData): Citation {
  const npaTitle = `${change.change_type} ${change.date_applicability}`;
  const actLabel = parsed.abbreviation
    ? `${parsed.abbreviation} (SR ${parsed.sr_number})`
    : `SR ${parsed.sr_number}`;
  return {
    text: `${change.change_type} — ст. ${change.article_number}, редакція від ${change.date_applicability}.`,
    source: actLabel,
    npaTitle,
    articleNumber: change.article_number ? String(change.article_number) : undefined,
  };
}

function extractChLegislationEvidence(toolName: string, parsed: ToolResultData): EvidenceResult {
  const citations: Citation[] = [];

  if (toolName === 'ch_search_legislation') {
    const rows = Array.isArray(parsed.results) ? parsed.results : [];
    for (const row of rows) citations.push(chActSearchCitation(row));
  } else if (toolName === 'ch_get_act_article') {
    // Error payloads: { error: 'act_not_found' | 'no_edition_for_date' | 'article_not_found', ... }
    if (!parsed.error && parsed.article) {
      citations.push(chArticleCitation(parsed));
    }
  } else if (toolName === 'ch_get_act_history') {
    // Error payload: { error: 'act_not_found', sr_number }
    if (!parsed.error && Array.isArray(parsed.changes)) {
      for (const change of parsed.changes.slice(0, MAX_HISTORY_CITATIONS)) {
        citations.push(chHistoryCitation(parsed, change));
      }
    }
  }

  return { decisions: [], citations, documents: [] };
}

export function extractChEvidence(toolName: string, data: ToolResultData): EvidenceResult {
  if (!data || typeof data !== 'object') {
    return { decisions: [], citations: [], documents: [] };
  }

  if (CH_COURT_TOOLS.has(toolName)) {
    return extractChCourtEvidence(toolName, data);
  }
  if (CH_LEGISLATION_TOOLS.has(toolName)) {
    return extractChLegislationEvidence(toolName, data);
  }

  return { decisions: [], citations: [], documents: [] };
}
