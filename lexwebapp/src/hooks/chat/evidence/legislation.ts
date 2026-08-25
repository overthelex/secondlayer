import type { Citation } from '../../../types/models/Message';
import type { EvidenceResult, ToolResultData } from './types';
import { formatLegislationText } from './format-legislation';

const LEGISLATION_TOOLS = [
  'search_legislation',
  'get_legislation_articles',
  'get_legislation_section',
  'get_legislation_article', // backward-compat alias
  'find_relevant_law_articles', // backward-compat alias
];

/** Resolve a human-readable NPA title from multiple possible fields. */
function resolveNpaTitle(obj: ToolResultData, legTitle?: string): string {
  return (
    obj.npa_title ||
    obj.title ||
    legTitle ||
    obj.legislation?.title ||
    obj.rada_id ||
    ''
  );
}

/** Build a hierarchy label: НПА, Розділ X "Title", Глава Y "Title", ст. Z */
function buildSource(npaTitle: string, articleNumber: string | undefined, obj?: ToolResultData): string {
  const parts: string[] = [];
  if (npaTitle) parts.push(npaTitle);

  if (obj?.section_number || obj?.section_title) {
    const sec = obj.section_number ? `Розділ ${obj.section_number}` : '';
    const secTitle = obj.section_title ? `«${obj.section_title}»` : '';
    parts.push([sec, secTitle].filter(Boolean).join(' '));
  }

  if (obj?.chapter_number || obj?.chapter_title) {
    const ch = obj.chapter_number ? `Глава ${obj.chapter_number}` : '';
    const chTitle = obj.chapter_title ? `«${obj.chapter_title}»` : '';
    parts.push([ch, chTitle].filter(Boolean).join(' '));
  }

  if (articleNumber) parts.push(`ст. ${articleNumber}`);

  if (parts.length > 0) return parts.join(', ');
  return 'Норма';
}

/** Extract hierarchy fields from a tool result object. */
function extractHierarchy(obj: ToolResultData) {
  return {
    sectionNumber: obj.section_number ? String(obj.section_number) : undefined,
    sectionTitle: obj.section_title ? String(obj.section_title) : undefined,
    chapterNumber: obj.chapter_number ? String(obj.chapter_number) : undefined,
    chapterTitle: obj.chapter_title ? String(obj.chapter_title) : undefined,
  };
}

export function extractLegislationEvidence(toolName: string, parsed: ToolResultData): EvidenceResult {
  const citations: Citation[] = [];
  // ch_search_legislation contains 'search_legislation' as a substring; Swiss tools have their own extractor (ch.ts)
  if (toolName.startsWith('ch_') || !LEGISLATION_TOOLS.some((t) => toolName.includes(t) || toolName === t)) {
    return { decisions: [], citations, documents: [] };
  }

  // Top-level NPA title (present on search_legislation and get_legislation_section responses)
  const topLegTitle: string =
    parsed.legislation?.title ||
    parsed.title ||
    '';

  // Single article result (get_legislation_section)
  if (parsed.full_text || parsed.text || parsed.content) {
    const articleNum: string = String(parsed.article_number || parsed.section_name || '');
    const npaTitle = resolveNpaTitle(parsed, topLegTitle);
    citations.push({
      text: formatLegislationText(parsed.full_text || parsed.text || parsed.content || ''),
      source: buildSource(npaTitle, articleNum || undefined, parsed),
      npaTitle: npaTitle || undefined,
      articleNumber: articleNum || undefined,
      url: parsed.url || undefined,
      radaId: parsed.rada_id || undefined,
      ...extractHierarchy(parsed),
    });
  }

  // Array of legislation results (search_legislation top-level legislation object + articles)
  if (parsed.legislation && Array.isArray(parsed.legislation)) {
    for (const l of parsed.legislation) {
      const npaTitle = resolveNpaTitle(l, topLegTitle);
      const articleNum = String(l.article_number || '');
      citations.push({
        text: formatLegislationText(l.full_text || l.text || l.snippet || l.title || ''),
        source: buildSource(npaTitle, articleNum || undefined, l),
        npaTitle: npaTitle || undefined,
        articleNumber: articleNum || undefined,
        url: l.url || undefined,
        radaId: l.rada_id || undefined,
        ...extractHierarchy(l),
      });
    }
  }

  // find_relevant_law_articles
  if (toolName === 'find_relevant_law_articles') {
    const refs = parsed.relevant_articles || parsed.articles || (Array.isArray(parsed) ? parsed : []);
    for (const r of refs) {
      if (typeof r === 'string') {
        citations.push({ text: r, source: r });
      } else if (r?.article || r?.reference || r?.norm) {
        const npaTitle = resolveNpaTitle(r, topLegTitle);
        const articleNum = String(r.article_number || '');
        citations.push({
          text: formatLegislationText(r.text || r.content || r.description || r.article || r.reference || r.norm || ''),
          source: buildSource(npaTitle, articleNum || undefined, r) || r.article || r.reference || r.norm || 'Норма',
          npaTitle: npaTitle || undefined,
          articleNumber: articleNum || undefined,
          url: r.url || undefined,
          radaId: r.rada_id || undefined,
          ...extractHierarchy(r),
        });
      }
    }
  } else if (parsed.articles && Array.isArray(parsed.articles)) {
    // search_legislation and get_legislation_articles both return articles[]
    const legTitle = parsed.legislation?.title || topLegTitle;
    for (const a of parsed.articles) {
      if (typeof a === 'object' && a !== null) {
        const npaTitle = resolveNpaTitle(a, legTitle);
        const articleNum = String(a.article_number || '');
        citations.push({
          text: formatLegislationText(a.full_text || a.text || a.content || ''),
          source: buildSource(npaTitle, articleNum || undefined, a),
          npaTitle: npaTitle || undefined,
          articleNumber: articleNum || undefined,
          url: a.url || undefined,
          radaId: a.rada_id || parsed.rada_id || undefined,
          ...extractHierarchy(a),
        });
      }
    }
  }

  return { decisions: [], citations, documents: [] };
}
