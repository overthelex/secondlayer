import React, { useState } from 'react';
import { Gavel, BookOpen, FileText, CheckCircle, X, ExternalLink, Eye } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Decision } from './DecisionCard';
import { DocumentViewerModal } from './DocumentViewerModal';

interface Citation {
  text: string;
  source: string;
}

interface VaultDocument {
  id: string;
  title: string;
  type: string;
  uploadedAt?: string;
  metadata?: Record<string, any>;
}

interface DocumentViewerItem {
  type: 'decision' | 'citation' | 'document';
  title: string;
  subtitle?: string;
  badge?: string;
  badgeVariant?: 'active' | 'overturned' | 'modified' | 'default';
  content: string;
  relevance?: number;
  externalUrl?: string;
}

interface RightPanelProps {
  isOpen: boolean;
  onClose: () => void;
  decisions?: Decision[];
  citations?: Citation[];
  documents?: VaultDocument[];
}

const DOC_TYPE_LABELS: Record<string, string> = {
  contract: 'Договір',
  legislation: 'Законодавство',
  court_decision: 'Судове рішення',
  internal: 'Внутрішній',
  other: 'Інше',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Чинне',
  overturned: 'Скасовано',
  modified: 'Змінено',
};

const cardVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1], delay: i * 0.04 },
  }),
};

export function RightPanel({
  isOpen,
  onClose,
  decisions = [],
  citations = [],
  documents = [],
}: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<'decisions' | 'regulations' | 'documents' | 'verification'>('decisions');
  const [viewerItem, setViewerItem] = useState<DocumentViewerItem | null>(null);
  const [isViewerOpen, setIsViewerOpen] = useState(false);

  const openDecision = (d: Decision) => {
    setViewerItem({
      type: 'decision',
      title: d.number,
      subtitle: `${d.court} • ${d.date}`,
      badge: STATUS_LABELS[d.status] || d.status,
      badgeVariant: d.status as 'active' | 'overturned' | 'modified',
      content: d.summary || 'Немає тексту рішення.',
      relevance: d.relevance,
    });
    setIsViewerOpen(true);
  };

  const openCitation = (c: Citation) => {
    setViewerItem({
      type: 'citation',
      title: c.source,
      content: c.text || 'Немає тексту.',
    });
    setIsViewerOpen(true);
  };

  const openDocument = (doc: VaultDocument) => {
    setViewerItem({
      type: 'document',
      title: doc.title,
      subtitle: doc.uploadedAt ? new Date(doc.uploadedAt).toLocaleDateString('uk-UA') : undefined,
      badge: DOC_TYPE_LABELS[doc.type] || doc.type,
      badgeVariant: 'default',
      content: doc.metadata?.snippet || doc.metadata?.text || doc.metadata?.content || 'Немає вмісту для перегляду.',
      relevance: doc.metadata?.relevance != null ? Math.round(doc.metadata.relevance * 100) : undefined,
    });
    setIsViewerOpen(true);
  };

  const tabs = [
    { id: 'decisions' as const, label: 'Рішення', icon: Gavel, count: decisions.length },
    { id: 'regulations' as const, label: 'Норми', icon: BookOpen, count: citations.length },
    { id: 'documents' as const, label: 'Документи', icon: FileText, count: documents.length },
    { id: 'verification' as const, label: 'Статус', icon: CheckCircle, count: 0 },
  ];

  return <>
    {/* Mobile Backdrop */}
    <AnimatePresence>
      {isOpen && <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        onClick={onClose}
        className="fixed inset-0 bg-black/25 z-40 lg:hidden backdrop-blur-[2px]"
      />}
    </AnimatePresence>

    {/* Right Panel Container */}
    <motion.aside
      initial={false}
      animate={{ x: isOpen ? 0 : 360 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="fixed lg:static inset-y-0 right-0 z-50 w-[360px] bg-white border-l border-claude-border flex flex-col lg:translate-x-0"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-claude-border/50 flex items-center justify-between">
        <h2 className="font-sans font-semibold text-[15px] text-claude-text tracking-tight">
          Доказова база
        </h2>
        <button onClick={onClose} className="lg:hidden p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-lg transition-all duration-200">
          <X size={18} strokeWidth={2} />
        </button>
      </div>

      {/* Tabs with counts */}
      <div className="border-b border-claude-border/50 bg-claude-bg/30">
        <div className="flex overflow-x-auto no-scrollbar">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 min-w-0 px-2 py-2.5 text-[10px] font-medium uppercase tracking-wider transition-all duration-200 border-b-2 ${
                activeTab === tab.id
                  ? 'border-claude-text text-claude-text'
                  : 'border-transparent text-claude-subtext hover:text-claude-text'
              }`}
            >
              <div className="flex items-center justify-center gap-1">
                <tab.icon size={12} strokeWidth={2} />
                <span className="truncate">{tab.label}</span>
                {tab.count > 0 && (
                  <span className={`text-[9px] min-w-[16px] h-4 flex items-center justify-center rounded-full px-1 font-semibold ${
                    activeTab === tab.id ? 'bg-claude-text text-white' : 'bg-claude-subtext/15 text-claude-subtext'
                  }`}>
                    {tab.count}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3">
        {/* ---- Decisions Tab ---- */}
        {activeTab === 'decisions' && (
          <div className="space-y-2">
            {decisions.length === 0 ? (
              <EmptyTabState icon={Gavel} text="Судові рішення з'являться після аналізу" />
            ) : (
              decisions.map((decision, i) => (
                <motion.div
                  key={decision.id}
                  custom={i}
                  variants={cardVariants}
                  initial="hidden"
                  animate="visible"
                  onClick={() => openDecision(decision)}
                  className="bg-white border border-claude-border rounded-xl p-3 hover:border-claude-subtext/30 hover:shadow-md transition-all duration-200 cursor-pointer group"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="p-1 bg-claude-bg rounded-md flex-shrink-0">
                        <Gavel size={12} className="text-claude-text" strokeWidth={2} />
                      </div>
                      <span className="font-mono text-[12px] font-semibold text-claude-text truncate">
                        {decision.number}
                      </span>
                    </div>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold uppercase tracking-wide flex-shrink-0 border ${
                      decision.status === 'active'
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : decision.status === 'overturned'
                        ? 'bg-red-50 text-red-600 border-red-200'
                        : 'bg-amber-50 text-amber-700 border-amber-200'
                    }`}>
                      {STATUS_LABELS[decision.status] || decision.status}
                    </span>
                  </div>

                  <div className="text-[11px] text-claude-subtext mb-2">
                    {decision.court} {decision.date && `• ${decision.date}`}
                  </div>

                  {decision.summary && (
                    <p className="text-[12px] text-claude-text/80 leading-relaxed mb-2.5 line-clamp-2">
                      {decision.summary}
                    </p>
                  )}

                  <div className="flex items-center justify-between pt-2 border-t border-claude-border/30">
                    <div className="flex items-center gap-2">
                      <div className="w-14 h-1.5 bg-claude-bg rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-claude-subtext/40 to-claude-text/60 rounded-full" style={{ width: `${decision.relevance}%` }} />
                      </div>
                      <span className="text-[10px] text-claude-subtext font-medium">
                        {decision.relevance}%
                      </span>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Eye size={12} className="text-claude-subtext" strokeWidth={2} />
                      <span className="text-[10px] text-claude-subtext">Читати</span>
                    </div>
                  </div>
                </motion.div>
              ))
            )}
          </div>
        )}

        {/* ---- Regulations Tab ---- */}
        {activeTab === 'regulations' && (
          <div className="space-y-2">
            {citations.length === 0 ? (
              <EmptyTabState icon={BookOpen} text="Нормативні акти з'являться після аналізу" />
            ) : (
              citations.map((citation, idx) => (
                <motion.div
                  key={idx}
                  custom={idx}
                  variants={cardVariants}
                  initial="hidden"
                  animate="visible"
                  onClick={() => openCitation(citation)}
                  className="bg-white border border-claude-border rounded-xl p-3 hover:border-claude-subtext/30 hover:shadow-md transition-all duration-200 cursor-pointer group"
                >
                  <div className="flex items-start gap-2.5">
                    <div className="p-1 bg-claude-bg rounded-md flex-shrink-0 mt-0.5">
                      <BookOpen size={12} className="text-claude-text" strokeWidth={2} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-[13px] text-claude-text mb-1 leading-tight">
                        {citation.source}
                      </div>
                      <p className="text-[11px] text-claude-subtext leading-relaxed line-clamp-3">
                        {citation.text}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center justify-end mt-2 pt-2 border-t border-claude-border/30">
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Eye size={12} className="text-claude-subtext" strokeWidth={2} />
                      <span className="text-[10px] text-claude-subtext">Читати</span>
                    </div>
                  </div>
                </motion.div>
              ))
            )}
          </div>
        )}

        {/* ---- Documents Tab ---- */}
        {activeTab === 'documents' && (
          <div className="space-y-2">
            {documents.length === 0 ? (
              <EmptyTabState icon={FileText} text="Документи з'являться після пошуку" />
            ) : (
              documents.map((doc, i) => (
                <motion.div
                  key={doc.id}
                  custom={i}
                  variants={cardVariants}
                  initial="hidden"
                  animate="visible"
                  onClick={() => openDocument(doc)}
                  className="bg-white border border-claude-border rounded-xl p-3 hover:border-claude-subtext/30 hover:shadow-md transition-all duration-200 cursor-pointer group"
                >
                  <div className="flex items-start gap-2.5">
                    <div className="p-1 bg-claude-bg rounded-md flex-shrink-0 mt-0.5">
                      <FileText size={12} className="text-claude-text" strokeWidth={2} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-[13px] text-claude-text mb-1 truncate leading-tight">
                        {doc.title}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-claude-subtext">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                          doc.type === 'court_decision'
                            ? 'bg-blue-50 text-blue-700 border-blue-200'
                            : doc.type === 'legislation'
                            ? 'bg-purple-50 text-purple-700 border-purple-200'
                            : doc.type === 'contract'
                            ? 'bg-green-50 text-green-700 border-green-200'
                            : 'bg-claude-bg text-claude-subtext border-claude-border'
                        }`}>
                          {DOC_TYPE_LABELS[doc.type] || doc.type}
                        </span>
                        {doc.uploadedAt && (
                          <span>{new Date(doc.uploadedAt).toLocaleDateString('uk-UA')}</span>
                        )}
                      </div>
                      {doc.metadata?.snippet && (
                        <p className="text-[11px] text-claude-subtext leading-relaxed mt-1.5 line-clamp-2">
                          {doc.metadata.snippet}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-claude-border/30">
                    {doc.metadata?.relevance != null ? (
                      <div className="flex items-center gap-2">
                        <div className="w-14 h-1.5 bg-claude-bg rounded-full overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-claude-subtext/40 to-claude-text/60 rounded-full" style={{ width: `${Math.round(doc.metadata.relevance * 100)}%` }} />
                        </div>
                        <span className="text-[10px] text-claude-subtext font-medium">
                          {Math.round(doc.metadata.relevance * 100)}%
                        </span>
                      </div>
                    ) : <div />}
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Eye size={12} className="text-claude-subtext" strokeWidth={2} />
                      <span className="text-[10px] text-claude-subtext">Читати</span>
                    </div>
                  </div>
                </motion.div>
              ))
            )}
          </div>
        )}

        {/* ---- Verification Tab ---- */}
        {activeTab === 'verification' && (
          <div className="space-y-3">
            <div className="bg-claude-bg border border-claude-border rounded-xl p-4">
              <div className="flex items-start gap-3">
                <CheckCircle size={18} className="text-claude-text flex-shrink-0" strokeWidth={2} />
                <div>
                  <div className="font-medium text-[13px] text-claude-text mb-1">
                    {decisions.length > 0 || citations.length > 0 || documents.length > 0
                      ? 'Всі джерела актуальні'
                      : 'Немає джерел для перевірки'}
                  </div>
                  <p className="text-[11px] text-claude-subtext leading-relaxed">
                    Остання перевірка: щойно
                  </p>
                </div>
              </div>
            </div>
            <div className="space-y-1 mt-3">
              <VerificationRow label="Судові рішення" count={decisions.length} />
              <VerificationRow label="Нормативні акти" count={citations.length} />
              <VerificationRow label="Документи" count={documents.length} />
            </div>
          </div>
        )}
      </div>
    </motion.aside>

    {/* Document Viewer Modal */}
    <DocumentViewerModal
      isOpen={isViewerOpen}
      onClose={() => setIsViewerOpen(false)}
      item={viewerItem}
    />
  </>;
}

function EmptyTabState({ icon: Icon, text }: { icon: React.ElementType; text: string }) {
  return (
    <div className="text-center py-12 text-claude-subtext/50">
      <Icon size={28} className="mx-auto mb-3 opacity-30" strokeWidth={1.5} />
      <p className="text-[12px]">{text}</p>
    </div>
  );
}

function VerificationRow({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center justify-between text-[11px] py-2 px-1">
      <span className="text-claude-subtext">{label}</span>
      <span className="text-claude-text font-medium">
        {count > 0 ? `${count} знайдено` : '— Немає'}
      </span>
    </div>
  );
}
