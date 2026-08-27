import type { Decision, Citation, VaultDocument } from '../../../types/models/Message';
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
const CH_LEGISLATION_TOOLS = new Set([
  'ch_search_legislation',
  'ch_get_act_article',
  'ch_get_act_history',
  'ch_get_decision_legislation',
  'ch_get_act_text',
]);
const CH_REGISTRY_TOOLS = new Set(['ch_search_companies', 'ch_get_company']);

const MAX_HISTORY_CITATIONS = 50;
const SUMMARY_FULL_TEXT_CHARS = 500;
const UNKNOWN_DATE_LABEL = 'Дата невідома (джерело)';
const COMPANY_BODY_CHARS = 300;
// Notes that the company has publications in SHAB rubric KK — debt collection and
// bankruptcy. Deliberately NOT a verdict and deliberately not in the title: the rubric
// covers the whole proceeding, KK07 (Widerruf) is a REVOCATION of a bankruptcy and KK09
// its closure, so "has KK publications" is the fact and "is bankrupt" is a conclusion the
// panel is not entitled to draw for the reader. The card's own rows say which it is.
const SHAB_KK_NOTE = 'Є публікації SHAB KK (стягнення/банкрутство)';

const CH_COMPANY_STATUS_LABELS: Record<string, string> = {
  active: 'у реєстрі',
  inactive: 'вилучена з реєстру',
};

const CH_CHANGE_TYPE_LABELS: Record<string, string> = {
  added: 'додано',
  modified: 'змінено',
  repealed: 'скасовано',
};

function chChangeTypeLabel(changeType: unknown): string {
  const key = String(changeType || '');
  return CH_CHANGE_TYPE_LABELS[key] || key;
}

function chRelevance(row: ToolResultData): number {
  if (row.rank == null) return 100;
  const scaled = Math.round(Number(row.rank) * 100);
  if (!Number.isFinite(scaled)) return 100;
  return Math.max(0, Math.min(100, scaled));
}

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
    date: row.decision_date_unknown ? UNKNOWN_DATE_LABEL : (row.decision_date || ''),
    summary: chDecisionSummary(row),
    relevance: chRelevance(row),
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
    // Error payloads: { error: 'not_found', ecli, doc_id } | { error: 'not_loaded', ecli, doc_id, stage }
    if (!parsed.error && (parsed.ecli || parsed.doc_id)) {
      decisions.push(toDecision(parsed));
    }
  }

  return { decisions, citations: [], documents: [] };
}

// Federal acts are cited by their SR number ("SR 220"); cantonal acts by the canton code
// and the cantonal collection number ("ZH 131.1"). A row without jurisdiction predates
// the cantonal corpus and is federal.
function chCollectionPrefix(row: ToolResultData): string {
  const jurisdiction = row.jurisdiction ? String(row.jurisdiction) : '';
  return jurisdiction && jurisdiction !== 'CH' ? jurisdiction : 'SR';
}

function chActNumber(row: ToolResultData): string {
  return `${chCollectionPrefix(row)} ${row.sr_number}`;
}

function chActTitle(act: ToolResultData): string {
  const title = act.title ? String(act.title) : '';
  return act.sr_number ? [title, `(${chActNumber(act)})`].filter(Boolean).join(' ') : title;
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
    // RegulationsTab only renders the source link inside the articleNumber badge block —
    // a search result has no article, so the abbreviation (or SR number, when no
    // abbreviation exists) stands in for it so the Fedlex link actually shows up.
    articleNumber: row.abbreviation ? String(row.abbreviation) : (row.sr_number ? String(row.sr_number) : undefined),
    url: row.eli_work_uri || undefined,
  };
}

function chArticleCitation(parsed: ToolResultData): Citation {
  const article = parsed.article || {};
  const version = parsed.version || {};
  const npaTitle = [
    article.article_number ? `Art. ${article.article_number}` : undefined,
    parsed.abbreviation ? String(parsed.abbreviation) : undefined,
    parsed.sr_number ? `(${chActNumber(parsed)})` : undefined,
  ].filter(Boolean).join(' ');
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

function chActLabel(parsed: ToolResultData): string {
  return parsed.abbreviation
    ? `${parsed.abbreviation} (${chActNumber(parsed)})`
    : chActNumber(parsed);
}

function chHistoryCitation(parsed: ToolResultData, change: ToolResultData): Citation {
  const label = chChangeTypeLabel(change.change_type);
  const npaTitle = `${label} ${change.date_applicability}`;
  return {
    text: `${label} — ст. ${change.article_number}, редакція від ${change.date_applicability}.`,
    source: chActLabel(parsed),
    npaTitle,
    articleNumber: change.article_number ? String(change.article_number) : undefined,
  };
}

function chEditionCitation(parsed: ToolResultData, edition: ToolResultData): Citation {
  const npaTitle = `Редакція ${edition.date_applicability} — ${edition.date_end_applicability ?? 'донині'}`;
  return {
    text: npaTitle,
    source: chActLabel(parsed),
    npaTitle,
  };
}

function chProvenanceCitation(parsed: ToolResultData, row: ToolResultData): Citation {
  const npaTitle = `${row.action ?? 'зміна'} ${row.effective_date ?? ''}`.trim();
  const body = [row.as_reference, row.bbl_reference].filter(Boolean).join('; ');
  return {
    text: body,
    source: chActLabel(parsed),
    npaTitle,
  };
}

// Non-exact-edition wording for ch_get_decision_legislation / ch_get_act_text, amended per
// spec: 'edition_at_date' gets a live date ("редакція на …"), the other statuses are fixed.
const CH_RETRIEVAL_STATUS_LABELS: Record<string, string> = {
  nearest_earlier_edition: '⚠ найближча раніша редакція',
  nearest_later_edition: '⚠ найближча пізніша редакція',
  no_text: 'текст недоступний',
};

function chRetrievalStatusLabel(status: unknown, effectiveDate: string): string {
  if (status === 'edition_at_date') return `редакція на ${effectiveDate}`;
  const key = String(status || '');
  return CH_RETRIEVAL_STATUS_LABELS[key] || key;
}

function chEditionInterval(edition: ToolResultData | null | undefined): string | undefined {
  if (!edition || !edition.date_applicability) return undefined;
  return `${edition.date_applicability} — ${edition.date_end_applicability || 'донині'}`;
}

// ch_get_decision_legislation: one Citation per cited act, in the edition valid at the
// decision date (or the nearest available one — the retrieval_status label says which).
function chDecisionActCitation(act: ToolResultData, effectiveDate: string): Citation {
  const npaTitle = chActTitle(act);
  const editionInterval = chEditionInterval(act.edition);
  const statusLabel = chRetrievalStatusLabel(act.retrieval_status, effectiveDate);
  const articles = Array.isArray(act.articles_cited) && act.articles_cited.length > 0
    ? ` Статті: ${act.articles_cited.join(', ')}${act.articles_truncated ? '…' : ''}.`
    : '';
  const text = [
    `${statusLabel}${editionInterval ? ` (${editionInterval})` : ''}.`,
    `Цитувань: ${act.citations_count}.`,
  ].join(' ') + articles;

  return {
    text: text.trim(),
    source: npaTitle,
    npaTitle,
    articleNumber: act.abbreviation ? String(act.abbreviation) : (act.sr_number ? String(act.sr_number) : undefined),
    sectionTitle: editionInterval,
  };
}

// ch_get_act_text: the full (possibly sliced) text of one edition → one VaultDocument.
// Title carries the edition range so the panel shows which point-in-time text this is
// without opening the document; the truncation note is separate from the raw body so a
// consumer that only wants the text (metadata.body) never sees the note mixed in.
function chActTextDocument(parsed: ToolResultData): VaultDocument {
  const npaTitle = chActTitle(parsed);
  const editionInterval = chEditionInterval(parsed.edition);
  const title = editionInterval ? `${npaTitle} (${editionInterval})` : npaTitle;
  const text = typeof parsed.text === 'string' ? parsed.text : '';
  const totalChars = parsed.text_total_chars != null ? Number(parsed.text_total_chars) : text.length;
  const truncationNote = parsed.truncated === true
    ? `показано ${text.length} з ${totalChars} символів`
    : undefined;

  return {
    id: `ch-act-text-${parsed.act_id}-${parsed.edition?.date_applicability || parsed.as_of || ''}`,
    title,
    type: 'other',
    metadata: {
      body: text,
      snippet: [truncationNote, text].filter(Boolean).join(' • '),
      act_id: parsed.act_id,
      sr_number: parsed.sr_number,
      lang: parsed.lang,
      requested_lang: parsed.requested_lang,
      as_of: parsed.as_of,
      retrieval_status: parsed.retrieval_status,
      truncated: parsed.truncated === true,
      text_offset: parsed.text_offset,
      text_total_chars: parsed.text_total_chars,
    },
  };
}

function extractChLegislationEvidence(toolName: string, parsed: ToolResultData): EvidenceResult {
  const citations: Citation[] = [];
  const documents: VaultDocument[] = [];

  if (toolName === 'ch_search_legislation') {
    const rows = Array.isArray(parsed.results) ? parsed.results : [];
    for (const row of rows) citations.push(chActSearchCitation(row));
  } else if (toolName === 'ch_get_act_article') {
    // Error payloads: { error: 'not_found', entity: 'act' } | { error: 'no_edition_for_date' } | { error: 'article_not_found' }
    if (!parsed.error && parsed.article) {
      citations.push(chArticleCitation(parsed));
    }
  } else if (toolName === 'ch_get_act_history') {
    // Error payload: { error: 'not_found', entity: 'act', sr_number }. Changes, editions, and
    // provenance are independent arrays — a history with no changes (e.g. no article filter
    // hit, or the act has no per-article diff data) still yields evidence from the others.
    if (!parsed.error) {
      if (Array.isArray(parsed.changes)) {
        for (const change of parsed.changes.slice(0, MAX_HISTORY_CITATIONS)) {
          citations.push(chHistoryCitation(parsed, change));
        }
      }
      if (Array.isArray(parsed.editions)) {
        for (const edition of parsed.editions.slice(0, MAX_HISTORY_CITATIONS)) {
          citations.push(chEditionCitation(parsed, edition));
        }
      }
      if (Array.isArray(parsed.provenance)) {
        for (const row of parsed.provenance.slice(0, MAX_HISTORY_CITATIONS)) {
          citations.push(chProvenanceCitation(parsed, row));
        }
      }
    }
  } else if (toolName === 'ch_get_decision_legislation') {
    // Error payload: { error: 'not_found', ecli } (consistent with ch_get_court_decision).
    if (!parsed.error && Array.isArray(parsed.acts)) {
      const effectiveDate = String(parsed.effective_date || parsed.decision_date || '');
      for (const act of parsed.acts) citations.push(chDecisionActCitation(act, effectiveDate));
    }
  } else if (toolName === 'ch_get_act_text') {
    // Error payload: { error: 'no_edition_for_date', act_id, earliest_edition }.
    if (!parsed.error && parsed.act_id != null) {
      documents.push(chActTextDocument(parsed));
    }
  }

  return { decisions: [], citations, documents };
}

/**
 * Zefix / SHAB company row → registry-style VaultDocument, the same shape registry.ts
 * gives openreyestr_* entities so the evidence panel renders both identically.
 *
 * `title` is "Name (UID)"; a SHAB-only company (struck off the register, so no Zefix row
 * and possibly no UID) keeps its name and is labelled by `source`. `subtitle` is the
 * one-line identity — legal form · seat · canton · status — and `snippet` is what the
 * panel actually renders, so it carries the subtitle, the SHAB counts, the KK note when
 * there is one, and then the body.
 */
function companyToDocument(row: ToolResultData, body: string, hasKkPublications: boolean): VaultDocument {
  const uid = row.uid ? String(row.uid) : '';
  const name = row.name ? String(row.name) : 'Компанія';
  const statusLabel = row.status ? (CH_COMPANY_STATUS_LABELS[String(row.status)] || String(row.status)) : '';
  const subtitle = [
    row.legal_form,
    row.legal_seat,
    row.canton,
    statusLabel,
    row.source === 'shab' ? 'лише SHAB (немає в Zefix)' : undefined,
  ].filter(Boolean).map(String).join(' · ');

  const shabLine = row.shab_count != null && Number(row.shab_count) > 0
    ? `Публікацій SHAB: ${chCount(row.shab_count, row.shab_count_capped === true)}`
      + `${row.last_shab_date ? ` (остання: ${row.last_shab_date})` : ''}`
    : undefined;

  return {
    id: `ch-company-${uid || name}`,
    title: `${name}${uid ? ` (${uid})` : ''}`,
    type: 'other',
    metadata: {
      subtitle,
      body,
      snippet: [subtitle, shabLine, hasKkPublications ? SHAB_KK_NOTE : undefined, body]
        .filter(Boolean).join(' \u2022 '),
      uid: uid || undefined,
      canton: row.canton ?? undefined,
      status: row.status ?? undefined,
      source: row.source ?? undefined,
      bankruptcy: hasKkPublications,
    },
  };
}

/**
 * A register-hit count, honest about the cap.
 *
 * ch_get_company returns at most 100 SHAB publications and 50 rows per register, so the
 * length of a section is not the company's total — it is what the tool was willing to
 * hand over. The tool says which sections it cut (`*_truncated`), and a cut count is
 * labelled "показано N" so the panel never presents a page as a total.
 */
function chCount(count: unknown, truncated: boolean): string {
  return truncated ? `показано ${count}` : String(count);
}

function chCompanyBody(row: ToolResultData): string {
  if (row.purpose) return String(row.purpose).slice(0, COMPANY_BODY_CHARS);
  return '';
}

/**
 * ch_get_company card → one company document whose body falls back to the newest SHAB
 * publication when Zefix records no purpose, plus the register-hit counts that make the
 * card worth opening (FINMA / SECO / cantonal gazette).
 */
function chCompanyCardDocument(parsed: ToolResultData): VaultDocument {
  const company = parsed.company || {};
  const shab = Array.isArray(parsed.shab) ? parsed.shab : [];
  const bankruptcies = Array.isArray(parsed.bankruptcies) ? parsed.bankruptcies : [];
  const finma = Array.isArray(parsed.finma) ? parsed.finma : [];
  const seco = Array.isArray(parsed.seco) ? parsed.seco : [];
  const kantonsblatt = Array.isArray(parsed.kantonsblatt) ? parsed.kantonsblatt : [];

  const newestShab = shab[0] || {};
  const body = chCompanyBody(company)
    || String(newestShab.content || newestShab.title || '').slice(0, COMPANY_BODY_CHARS);

  const doc = companyToDocument(
    {
      ...company,
      // The card's SHAB count is the length of a capped list, unlike ch_search_companies'
      // shab_count, which is a real count(*) — hence the flag travelling with it.
      shab_count: shab.length,
      shab_count_capped: parsed.shab_truncated === true,
      last_shab_date: newestShab.publication_date,
    },
    body,
    bankruptcies.length > 0
  );

  const registerHits = [
    bankruptcies.length > 0
      ? `Публікації SHAB KK (стягнення/банкрутство): ${chCount(bankruptcies.length, parsed.bankruptcies_truncated === true)}`
      : undefined,
    finma.length > 0 ? `FINMA: ${chCount(finma.length, parsed.finma_truncated === true)}` : undefined,
    seco.length > 0 ? `SECO (санкції): ${chCount(seco.length, parsed.seco_truncated === true)}` : undefined,
    kantonsblatt.length > 0
      ? `Кантональні відомості: ${chCount(kantonsblatt.length, parsed.kantonsblatt_truncated === true)}`
      : undefined,
  ].filter(Boolean).join(' \u2022 ');

  return {
    ...doc,
    metadata: {
      ...doc.metadata,
      register_hits: registerHits || undefined,
      finma_count: finma.length,
      seco_count: seco.length,
      kantonsblatt_count: kantonsblatt.length,
      bankruptcy_count: bankruptcies.length,
      // FINMA and SECO are matched by normalised name, not by UID — surface the note the
      // backend returns so the panel never presents a heuristic hit as a certain one.
      name_match_note: parsed.name_match_note ?? undefined,
      snippet: [doc.metadata?.snippet, registerHits].filter(Boolean).join(' \u2022 '),
    },
  };
}

function extractChRegistryEvidence(toolName: string, parsed: ToolResultData): EvidenceResult {
  const documents: VaultDocument[] = [];

  if (toolName === 'ch_search_companies') {
    const rows = Array.isArray(parsed.results) ? parsed.results : [];
    for (const row of rows) {
      documents.push(companyToDocument(row, chCompanyBody(row), row.bankruptcy === true));
    }
  } else if (toolName === 'ch_get_company') {
    // Error payload: { error: 'not_found', uid }.
    if (!parsed.error && parsed.company) {
      documents.push(chCompanyCardDocument(parsed));
    }
  }

  return { decisions: [], citations: [], documents };
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
  if (CH_REGISTRY_TOOLS.has(toolName)) {
    return extractChRegistryEvidence(toolName, data);
  }

  return { decisions: [], citations: [], documents: [] };
}
