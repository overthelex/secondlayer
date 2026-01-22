import React, { useState } from 'react';
import { Gavel, BookOpen, MessageSquare, CheckCircle, X, ChevronDown, ExternalLink } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
interface RightPanelProps {
  isOpen: boolean;
  onClose: () => void;
}
export function RightPanel({
  isOpen,
  onClose
}: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<'decisions' | 'regulations' | 'commentary' | 'verification'>('decisions');
  const tabs = [{
    id: 'decisions' as const,
    label: 'Судебные решения',
    icon: Gavel
  }, {
    id: 'regulations' as const,
    label: 'Нормативные акты',
    icon: BookOpen
  }, {
    id: 'commentary' as const,
    label: 'Комментарии',
    icon: MessageSquare
  }, {
    id: 'verification' as const,
    label: 'Актуальность',
    icon: CheckCircle
  }];
  const mockDecisions = [{
    id: 1,
    number: '910/12345/23',
    court: 'Верховний Суд',
    date: '15.05.2023',
    relevance: 95,
    status: 'active' as const
  }, {
    id: 2,
    number: '910/5432/22',
    court: 'Апеляційний суд',
    date: '20.11.2022',
    relevance: 88,
    status: 'active' as const
  }, {
    id: 3,
    number: '910/1111/21',
    court: 'Господарський суд',
    date: '10.02.2021',
    relevance: 72,
    status: 'overturned' as const
  }];
  const mockRegulations = [{
    id: 1,
    title: 'ЦКУ ст. 625',
    description: "Відповідальність за порушення зобов'язання",
    updated: '01.01.2023'
  }, {
    id: 2,
    title: 'ГКУ ст. 231',
    description: 'Договір поставки',
    updated: '15.03.2022'
  }];
  return <>
      {/* Mobile Backdrop */}
      <AnimatePresence>
        {isOpen && <motion.div initial={{
        opacity: 0
      }} animate={{
        opacity: 1
      }} exit={{
        opacity: 0
      }} transition={{
        duration: 0.3,
        ease: [0.22, 1, 0.36, 1]
      }} onClick={onClose} className="fixed inset-0 bg-black/25 z-40 lg:hidden backdrop-blur-[2px]" />}
      </AnimatePresence>

      {/* Right Panel Container */}
      <motion.aside initial={false} animate={{
      x: isOpen ? 0 : 360
    }} transition={{
      duration: 0.4,
      ease: [0.22, 1, 0.36, 1]
    }} className="fixed lg:static inset-y-0 right-0 z-50 w-[360px] bg-white border-l border-claude-border flex flex-col lg:translate-x-0">
        {/* Header */}
        <div className="p-4 border-b border-claude-border/50 flex items-center justify-between">
          <h2 className="font-sans font-semibold text-base text-claude-text tracking-tight">
            Доказательная база
          </h2>
          <button onClick={onClose} className="lg:hidden p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-lg transition-all duration-200">
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b border-claude-border/50 bg-claude-bg/30">
          <div className="flex overflow-x-auto no-scrollbar">
            {tabs.map((tab) => <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`flex-1 min-w-0 px-3 py-3 text-[11px] font-medium uppercase tracking-wider transition-all duration-200 border-b-2 ${activeTab === tab.id ? 'border-claude-text text-claude-text' : 'border-transparent text-claude-subtext hover:text-claude-text'}`}>
                <div className="flex items-center justify-center gap-1.5">
                  <tab.icon size={13} strokeWidth={2} />
                  <span className="hidden sm:inline truncate">{tab.label}</span>
                </div>
              </button>)}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {activeTab === 'decisions' && <div className="space-y-3">
              <div className="flex items-center justify-between mb-4">
                <span className="text-[11px] font-semibold text-claude-subtext uppercase tracking-wider">
                  Найдено: {mockDecisions.length}
                </span>
                <button className="text-[11px] text-claude-text hover:underline font-medium">
                  Экспорт
                </button>
              </div>

              {mockDecisions.map((decision) => <motion.div key={decision.id} initial={{
            opacity: 0,
            y: 10
          }} animate={{
            opacity: 1,
            y: 0
          }} className="bg-white border border-claude-border rounded-lg p-3 hover:border-claude-subtext/30 hover:shadow-sm transition-all duration-200 cursor-pointer group">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Gavel size={14} className="text-claude-text flex-shrink-0" strokeWidth={2} />
                      <span className="font-mono text-[12px] font-medium text-claude-text">
                        {decision.number}
                      </span>
                    </div>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium uppercase tracking-wide ${decision.status === 'active' ? 'bg-claude-bg text-claude-text border border-claude-border' : 'bg-claude-subtext/10 text-claude-subtext border border-claude-border'}`}>
                      {decision.status === 'active' ? 'В силе' : 'Отменено'}
                    </span>
                  </div>

                  <div className="text-[11px] text-claude-subtext mb-2">
                    {decision.court} • {decision.date}
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-1 bg-claude-bg rounded-full overflow-hidden">
                        <div className="h-full bg-claude-text/60 rounded-full" style={{
                    width: `${decision.relevance}%`
                  }} />
                      </div>
                      <span className="text-[10px] text-claude-subtext font-medium">
                        {decision.relevance}%
                      </span>
                    </div>
                    <ExternalLink size={12} className="text-claude-subtext/50 group-hover:text-claude-text transition-colors" strokeWidth={2} />
                  </div>
                </motion.div>)}
            </div>}

          {activeTab === 'regulations' && <div className="space-y-3">
              <div className="mb-4">
                <span className="text-[11px] font-semibold text-claude-subtext uppercase tracking-wider">
                  Применимые нормы
                </span>
              </div>

              {mockRegulations.map((reg) => <motion.div key={reg.id} initial={{
            opacity: 0,
            y: 10
          }} animate={{
            opacity: 1,
            y: 0
          }} className="bg-white border border-claude-border rounded-lg p-3 hover:border-claude-subtext/30 hover:shadow-sm transition-all duration-200 cursor-pointer group">
                  <div className="flex items-start gap-2 mb-2">
                    <BookOpen size={14} className="text-claude-text flex-shrink-0 mt-0.5" strokeWidth={2} />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-[13px] text-claude-text mb-1">
                        {reg.title}
                      </div>
                      <p className="text-[11px] text-claude-subtext leading-relaxed">
                        {reg.description}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-claude-border/30">
                    <span className="text-[10px] text-claude-subtext">
                      Обновлено: {reg.updated}
                    </span>
                    <ExternalLink size={12} className="text-claude-subtext/50 group-hover:text-claude-text transition-colors" strokeWidth={2} />
                  </div>
                </motion.div>)}
            </div>}

          {activeTab === 'commentary' && <div className="space-y-3">
              <div className="mb-4">
                <span className="text-[11px] font-semibold text-claude-subtext uppercase tracking-wider">
                  Комментарии и практика
                </span>
              </div>
              <div className="text-center py-12 text-claude-subtext/50">
                <MessageSquare size={32} className="mx-auto mb-3 opacity-30" strokeWidth={1.5} />
                <p className="text-[12px]">
                  Комментарии появятся после анализа
                </p>
              </div>
            </div>}

          {activeTab === 'verification' && <div className="space-y-3">
              <div className="mb-4">
                <span className="text-[11px] font-semibold text-claude-subtext uppercase tracking-wider">
                  Проверка актуальности
                </span>
              </div>
              <div className="bg-claude-bg border border-claude-border rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <CheckCircle size={18} className="text-claude-text flex-shrink-0" strokeWidth={2} />
                  <div>
                    <div className="font-medium text-[13px] text-claude-text mb-1">
                      Все источники актуальны
                    </div>
                    <p className="text-[11px] text-claude-subtext leading-relaxed">
                      Последняя проверка: сегодня в 14:30
                    </p>
                  </div>
                </div>
              </div>
              <div className="space-y-2 mt-4">
                <div className="flex items-center justify-between text-[11px] py-2">
                  <span className="text-claude-subtext">Судебные решения</span>
                  <span className="text-claude-text font-medium">
                    ✓ Актуально
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px] py-2">
                  <span className="text-claude-subtext">Нормативные акты</span>
                  <span className="text-claude-text font-medium">
                    ✓ Актуально
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px] py-2">
                  <span className="text-claude-subtext">Комментарии</span>
                  <span className="text-claude-text font-medium">
                    ✓ Актуально
                  </span>
                </div>
              </div>
            </div>}
        </div>
      </motion.aside>
    </>;
}