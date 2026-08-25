/**
 * RegulationsTab — renders legislation/norm citation cards.
 * Shows НПА title, article number badge, full article text and source link.
 */

import { BookOpen, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { ExpandableCard, EmptyTabState } from './ExpandableCard';
import { useExpandableCards } from '../../hooks/useExpandableCards';

/** Host shown next to an article link: zakon.rada.gov.ua for UA, fedlex.admin.ch for CH, whatever the source is. */
function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'zakon.rada.gov.ua';
  }
}

interface Citation {
  text: string;
  source: string;
  npaTitle?: string;
  articleNumber?: string;
  url?: string;
  radaId?: string;
  sectionNumber?: string;
  sectionTitle?: string;
  chapterNumber?: string;
  chapterTitle?: string;
}

interface RegulationsTabProps {
  citations: Citation[];
  onOpenModal: (citation: Citation) => void;
}

export function RegulationsTab({ citations, onOpenModal }: RegulationsTabProps) {
  const { isExpanded, toggleCard } = useExpandableCards();

  if (citations.length === 0) {
    return <EmptyTabState icon={BookOpen} text="Нормативні акти з'являться після аналізу" />;
  }

  return (
    <div className="space-y-2">
      {citations.map((citation, idx) => {
        const cardId = `citation-${idx}`;
        const expanded = isExpanded(cardId);
        // Safeguard: citation.text may arrive as an object/array from MCP content blocks
        const safeText = typeof citation.text === 'string' ? citation.text : JSON.stringify(citation.text);

        // Resolve display fields with fallbacks
        const npaTitle = citation.npaTitle || '';
        const articleNum = citation.articleNumber;
        const articleUrl = citation.url;

        // Build hierarchy breadcrumb: Розділ X «Title» → Глава Y «Title»
        const hierarchyParts: string[] = [];
        if (citation.sectionNumber || citation.sectionTitle) {
          const sec = citation.sectionNumber ? `Розділ ${citation.sectionNumber}` : '';
          const secTitle = citation.sectionTitle ? `«${citation.sectionTitle}»` : '';
          hierarchyParts.push([sec, secTitle].filter(Boolean).join(' '));
        }
        if (citation.chapterNumber || citation.chapterTitle) {
          const ch = citation.chapterNumber ? `Глава ${citation.chapterNumber}` : '';
          const chTitle = citation.chapterTitle ? `«${citation.chapterTitle}»` : '';
          hierarchyParts.push([ch, chTitle].filter(Boolean).join(' '));
        }
        const hierarchyLabel = hierarchyParts.length > 0 ? hierarchyParts.join(' → ') : '';

        return (
          <ExpandableCard
            key={idx}
            id={cardId}
            index={idx}
            icon={BookOpen}
            isExpanded={expanded}
            onToggle={() => toggleCard(cardId)}
            content={safeText || 'Немає тексту.'}
            onOpenModal={() => onOpenModal(citation)}
            header={
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  {/* НПА title — prominent */}
                  {npaTitle && (
                    <div className="font-medium text-[11.5px] text-zinc-800 leading-snug mb-0.5">
                      {npaTitle}
                    </div>
                  )}
                  {/* Hierarchy breadcrumb: Розділ → Глава */}
                  {hierarchyLabel && (
                    <div className="text-[10px] text-zinc-500 leading-snug mb-1">
                      {hierarchyLabel}
                    </div>
                  )}
                  {/* Article number badge + optional link */}
                  {articleNum && (
                    <div className="flex items-center gap-1.5">
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-zinc-100 border border-zinc-200 text-[9.5px] font-medium text-zinc-500 uppercase tracking-[0.04em]">
                        ст.&nbsp;{articleNum}
                      </span>
                      {articleUrl && (
                        <a
                          href={articleUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-0.5 text-[9.5px] text-zinc-400 hover:text-zinc-700 transition-colors duration-100"
                        >
                          <ExternalLink size={9} strokeWidth={2} />
                          {linkHost(articleUrl)}
                        </a>
                      )}
                    </div>
                  )}
                  {/* Fallback: show source if neither npaTitle nor articleNum resolved */}
                  {!npaTitle && !articleNum && (
                    <div className="font-medium text-[11.5px] text-zinc-800 leading-snug">
                      {citation.source}
                    </div>
                  )}
                </div>
                {expanded
                  ? <ChevronUp size={13} className="text-zinc-400 flex-shrink-0 mt-0.5" strokeWidth={2} />
                  : <ChevronDown size={13} className="text-zinc-400 flex-shrink-0 mt-0.5" strokeWidth={2} />
                }
              </div>
            }
            preview={
              safeText ? (
                <p className="text-[11px] text-zinc-500 leading-relaxed line-clamp-3 mt-1.5">
                  {safeText}
                </p>
              ) : null
            }
          />
        );
      })}
    </div>
  );
}
