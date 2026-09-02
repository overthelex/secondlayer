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
const CH_CITATION_TOOLS = new Set(['ch_get_citation_graph', 'ch_check_precedent_status']);
const CH_COMMENTARY_TOOLS = new Set(['ch_get_commentary', 'ch_search_commentary']);
const CH_MATERIALS_TOOLS = new Set(['ch_search_materials', 'ch_get_material', 'ch_get_article_purpose']);

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

const CH_COMPLETENESS_TITLE = 'Повнота видачі';
const CH_UNRESOLVED_ABBR_EXAMPLES = 3;

/**
 * ch_get_decision_legislation: a synthetic, non-act summary Citation appended after the
 * real acts so the evidence panel never looks like the complete citation list of a decision
 * when the backend actually cut it short (acts_truncated) or couldn't resolve some citations
 * to an act at all (unresolved.count). Not backed by any one act, so — unlike the other CH
 * citations built in this file — it carries no sr_number/articleNumber: a fake one would
 * read as a real act. Mirrors registry.ts's synthetic "Статистика реєстру" citation (text +
 * source, no article badge). Returns null when neither condition applies (the common case).
 */
function chDecisionCompletenessFooter(parsed: ToolResultData): Citation | null {
  const actsShown = Array.isArray(parsed.acts) ? parsed.acts.length : 0;
  const totalActs = parsed.total_cited_acts != null ? Number(parsed.total_cited_acts) : actsShown;
  const actsTruncated = parsed.acts_truncated === true;

  const unresolved = parsed.unresolved && typeof parsed.unresolved === 'object' ? parsed.unresolved : {};
  const unresolvedCount = unresolved.count != null ? Number(unresolved.count) : 0;

  if (!actsTruncated && !(unresolvedCount > 0)) return null;

  const sentences: string[] = [];
  if (actsTruncated) {
    sentences.push(`Показано ${actsShown} з ${totalActs} актів.`);
  }
  if (unresolvedCount > 0) {
    const topAbbrs = Array.isArray(unresolved.top_abbrs) ? unresolved.top_abbrs : [];
    const abbrList = topAbbrs
      .slice(0, CH_UNRESOLVED_ABBR_EXAMPLES)
      .map((a: ToolResultData) => a?.abbr)
      .filter(Boolean)
      .join(', ');
    sentences.push(`Нерозпізнаних цитувань: ${unresolvedCount}${abbrList ? ` (наприклад: ${abbrList}…)` : '.'}`);
  }

  return {
    text: sentences.join(' '),
    source: CH_COMPLETENESS_TITLE,
    npaTitle: CH_COMPLETENESS_TITLE,
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
      const footer = chDecisionCompletenessFooter(parsed);
      if (footer) citations.push(footer);
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


// ─── Citation graph / precedent status ───────────────────────────────

const CH_PRECEDENT_STATUS_LABELS: Record<string, string> = {
  actively_cited: 'активно цитується',
  previously_cited: 'цитувалося раніше',
  uncited: 'не цитується',
};

// A graph/status row names a decision only by ecli/docket/court code — there is no
// court_name, abstract or URL on the edge, so the Decision card is deliberately
// minimal: identity, date, and a one-line role summary.
function citationRowToDecision(
  id: string, court: string | null, docket: string | null,
  date: string | null, summary: string
): Decision {
  return {
    id,
    number: [court, docket || id].filter(Boolean).join(' · '),
    court: court || '',
    date: date || '',
    summary,
    relevance: 100,
    status: 'active',
  };
}

function extractChCitationEvidence(toolName: string, parsed: ToolResultData): EvidenceResult {
  const decisions: Decision[] = [];

  if (toolName === 'ch_get_citation_graph') {
    // Error payloads: { error: 'not_found' | 'not_loaded', ... }
    if (parsed.error) return { decisions, citations: [], documents: [] };

    const outbound = Array.isArray(parsed.outbound?.cases) ? parsed.outbound.cases : [];
    for (const row of outbound) {
      // An unresolved reference has no target decision to render — it is already
      // summarised in outbound.unresolved_refs.
      if (!row.resolved || !row.to_ecli) continue;
      decisions.push(citationRowToDecision(
        String(row.to_ecli), row.court_code ?? null, row.docket_number ?? row.to_raw ?? null,
        row.decision_date ?? null, 'Цитується цим рішенням'));
    }
    const inbound = Array.isArray(parsed.inbound?.recent) ? parsed.inbound.recent : [];
    for (const row of inbound) {
      if (!row.from_ecli) continue;
      decisions.push(citationRowToDecision(
        String(row.from_ecli), row.from_court ?? null, null,
        row.from_date ?? null, 'Цитує це рішення'));
    }
  } else if (toolName === 'ch_check_precedent_status') {
    // { status: 'not_in_corpus', reference } and { error: ... } render nothing.
    if (parsed.error || parsed.status === 'not_in_corpus' || !parsed.ecli) {
      return { decisions, citations: [], documents: [] };
    }
    const statusLabel = CH_PRECEDENT_STATUS_LABELS[String(parsed.status)] || String(parsed.status);
    const counts = `цитувань: ${parsed.cited_by_count ?? 0} (судів: ${parsed.citing_courts ?? 0})`;
    const last = parsed.last_citing_date ? `, останнє: ${parsed.last_citing_date}` : '';
    decisions.push(citationRowToDecision(
      String(parsed.ecli), parsed.court_code ?? null, parsed.docket_number ?? null,
      parsed.decision_date ?? null, `Статус прецеденту: ${statusLabel}; ${counts}${last}`));
    const recent = Array.isArray(parsed.recent_citings) ? parsed.recent_citings : [];
    for (const row of recent) {
      if (!row.from_ecli) continue;
      decisions.push(citationRowToDecision(
        String(row.from_ecli), row.from_court ?? null, null,
        row.from_date ?? null, 'Цитує це рішення'));
    }
  }

  return { decisions, citations: [], documents: [] };
}

// ch_get_commentary: one commentary → one VaultDocument, body = the text slice the tool
// returned. The title names the authors and the source with its licence (CC BY requires
// attribution wherever the text is re-served), the attribution line the tool built goes
// into the snippet ahead of the text, and the truncation note follows the ch_get_act_text
// convention so the panel shows a partial text as partial.
function chCommentaryDocument(parsed: ToolResultData): VaultDocument {
  const text = typeof parsed.text === 'string' ? parsed.text : '';
  const totalChars = parsed.text_total_chars != null ? Number(parsed.text_total_chars) : text.length;
  const truncationNote = parsed.truncated === true
    ? `показано ${text.length} з ${totalChars} символів`
    : undefined;
  const authors = Array.isArray(parsed.authors) && parsed.authors.length > 0
    ? parsed.authors.join(', ')
    : undefined;
  const provenance = [authors, parsed.source, parsed.licence ? `(${parsed.licence})` : undefined]
    .filter(Boolean).join(' ');
  const title = `${parsed.title || 'Коментар'} — ${provenance}`;

  return {
    id: `ch-commentary-${parsed.source}-${parsed.source_id}`,
    title,
    type: 'other',
    metadata: {
      body: text,
      snippet: [truncationNote, parsed.attribution, text].filter(Boolean).join(' • '),
      source: parsed.source,
      source_url: parsed.source_url,
      licence: parsed.licence,
      attribution: parsed.attribution,
      sr_number: parsed.sr_number,
      article_number: parsed.article_number,
      lang: parsed.lang,
      version_date: parsed.version_date,
      truncated: parsed.truncated === true,
      text_offset: parsed.text_offset,
      text_total_chars: parsed.text_total_chars,
    },
  };
}

// ch_search_commentary: one Citation per hit. The snippet is the tool's ts_headline
// fragment; source names the site and licence so the attribution travels with the hit.
function chCommentarySearchCitation(row: ToolResultData): Citation {
  const authors = Array.isArray(row.authors) && row.authors.length > 0
    ? ` ${row.authors.join(', ')}.`
    : '';
  const edition = row.version_date ? ` Редакція ${row.version_date}.` : '';
  const snippet = row.snippet ? ` ${String(row.snippet).replace(/<\/?b>/g, '')}` : '';
  const text = `${row.title || ''}.${authors}${edition}${snippet}`.trim();
  const npaTitle = row.act_title
    ? `${row.act_title}${row.sr_number ? ` (SR ${row.sr_number})` : ''}`
    : (row.sr_number ? `SR ${row.sr_number}` : String(row.abbr || ''));

  return {
    text,
    source: `${row.source || ''}${row.licence ? ` (${row.licence})` : ''}`.trim(),
    npaTitle,
    articleNumber: row.article_number ? String(row.article_number) : undefined,
    url: row.source_url || undefined,
  };
}

function extractChCommentaryEvidence(toolName: string, parsed: ToolResultData): EvidenceResult {
  const citations: Citation[] = [];
  const documents: VaultDocument[] = [];

  if (toolName === 'ch_get_commentary') {
    // Error payload: { error: 'not_found', sr_number, article, available_langs, available_articles }.
    if (!parsed.error && parsed.source_id != null) {
      documents.push(chCommentaryDocument(parsed));
    }
  } else if (toolName === 'ch_search_commentary') {
    const rows = Array.isArray(parsed.results) ? parsed.results : [];
    for (const row of rows) citations.push(chCommentarySearchCitation(row));
  }

  return { decisions: [], citations, documents };
}

const CH_MATERIAL_TYPE_LABELS: Record<string, string> = {
  botschaft: 'Botschaft (послання Федеральної ради)',
  bericht_br: 'Звіт Федеральної ради',
  stellungnahme_br: 'Позиція Федеральної ради',
  bericht_kommission: 'Звіт парламентської комісії',
};

function chMaterialTypeLabel(kind: unknown): string {
  const key = String(kind || '');
  return CH_MATERIAL_TYPE_LABELS[key] || key;
}

// ch_search_materials: one Citation per hit — the Gazette citation is the article
// number badge (the thing a lawyer writes), the Fedlex PDF is the link.
function chMaterialSearchCitation(row: ToolResultData): Citation {
  const date = row.date_document || row.publication_date;
  const snippet = row.snippet ? ` ${String(row.snippet).replace(/<\/?b>/g, '')}` : '';
  const text = `${chMaterialTypeLabel(row.material_type)}${date ? ` від ${date}` : ''}.${snippet}`.trim();
  return {
    text,
    source: String(row.title || row.historical_id || 'Bundesblatt'),
    npaTitle: String(row.title || ''),
    articleNumber: row.historical_id ? String(row.historical_id) : undefined,
    url: row.pdf_url || undefined,
  };
}

// ch_get_material: the text slice → one VaultDocument, truncation note as elsewhere.
function chMaterialDocument(parsed: ToolResultData): VaultDocument {
  const text = typeof parsed.text === 'string' ? parsed.text : '';
  const totalChars = parsed.text_total_chars != null ? Number(parsed.text_total_chars) : text.length;
  const truncationNote = parsed.truncated === true
    ? `показано ${text.length} з ${totalChars} символів`
    : undefined;
  const unavailable = parsed.text_available === false ? 'текст ще не завантажено' : undefined;
  const title = `${parsed.title || chMaterialTypeLabel(parsed.material_type)}${parsed.historical_id ? ` (${parsed.historical_id})` : ''}`;
  return {
    id: `ch-material-${parsed.material_id}`,
    title,
    type: 'other',
    metadata: {
      body: text,
      snippet: [unavailable, truncationNote, text].filter(Boolean).join(' • '),
      material_id: parsed.material_id,
      eli_work_uri: parsed.eli_work_uri,
      material_type: parsed.material_type,
      historical_id: parsed.historical_id,
      pdf_url: parsed.pdf_url,
      lang: parsed.lang,
      date_document: parsed.date_document,
      publication_date: parsed.publication_date,
      truncated: parsed.truncated === true,
      text_offset: parsed.text_offset,
      text_total_chars: parsed.text_total_chars,
    },
  };
}

// ch_get_article_purpose: one Citation per paragraph of every linked material, each
// naming the act and article it explains and linking to the Fedlex PDF.
function chArticlePurposeCitations(parsed: ToolResultData): Citation[] {
  const out: Citation[] = [];
  const npaTitle = [
    parsed.article ? `Art. ${parsed.article}` : undefined,
    parsed.abbreviation ? String(parsed.abbreviation) : undefined,
    parsed.act_title ? String(parsed.act_title) : undefined,
    parsed.sr_number ? `(SR ${parsed.sr_number})` : undefined,
  ].filter(Boolean).join(' ');
  const materials = Array.isArray(parsed.materials) ? parsed.materials : [];
  for (const m of materials) {
    const label = `${m.title || chMaterialTypeLabel(m.material_type)}${m.historical_id ? `, ${m.historical_id}` : ''}`;
    const paragraphs = Array.isArray(m.paragraphs) ? m.paragraphs : [];
    if (paragraphs.length === 0) {
      out.push({
        text: m.text_available === false ? `${label}: текст ще не завантажено.` : `${label}: абзаців зі згадкою статті не знайдено.`,
        source: label,
        npaTitle,
        articleNumber: parsed.article ? String(parsed.article) : undefined,
        url: m.pdf_url || undefined,
      });
      continue;
    }
    for (const p of paragraphs) {
      out.push({
        text: String(p.text || ''),
        source: label,
        npaTitle,
        articleNumber: parsed.article ? String(parsed.article) : undefined,
        url: m.pdf_url || undefined,
      });
    }
  }
  return out;
}

function extractChMaterialsEvidence(toolName: string, parsed: ToolResultData): EvidenceResult {
  const citations: Citation[] = [];
  const documents: VaultDocument[] = [];
  if (toolName === 'ch_search_materials') {
    const rows = Array.isArray(parsed.results) ? parsed.results : [];
    for (const row of rows) citations.push(chMaterialSearchCitation(row));
  } else if (toolName === 'ch_get_material') {
    if (!parsed.error && parsed.material_id != null) documents.push(chMaterialDocument(parsed));
  } else if (toolName === 'ch_get_article_purpose') {
    // Error payloads: { error: 'not_found', entity: 'act' } | { error: 'no_materials_linked', bbl_references }
    if (!parsed.error) citations.push(...chArticlePurposeCitations(parsed));
  }
  return { decisions: [], citations, documents };
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
  if (CH_CITATION_TOOLS.has(toolName)) {
    return extractChCitationEvidence(toolName, data);
  }
  if (CH_COMMENTARY_TOOLS.has(toolName)) {
    return extractChCommentaryEvidence(toolName, data);
  }
  if (CH_MATERIALS_TOOLS.has(toolName)) {
    return extractChMaterialsEvidence(toolName, data);
  }

  return { decisions: [], citations: [], documents: [] };
}
