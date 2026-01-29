import React, { useEffect, useState, useRef } from 'react';
import {
  Plus,
  MessageSquare,
  X,
  Users,
  Briefcase,
  FileText,
  Scale,
  Clock,
  Gavel,
  BookOpen,
  CheckCircle,
  LogOut,
  User,
  Bell,
  TrendingUp,
  Vote,
  BarChart3,
  History,
  FileCode,
  DollarSign } from
'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  onNewChat: () => void;
  onProfileClick?: () => void;
  onJudgesClick?: () => void;
  onLawyersClick?: () => void;
  onClientsClick?: () => void;
  onCasesClick?: () => void;
  onHistoryClick?: () => void;
  onDecisionsClick?: () => void;
  onBillingClick?: () => void;
  onLegislationMonitoringClick?: () => void;
  onCourtPracticeAnalysisClick?: () => void;
  onLegalInitiativesClick?: () => void;
  onLegislationStatisticsClick?: () => void;
  onVotingAnalysisClick?: () => void;
  onLegalCodesLibraryClick?: () => void;
  onHistoricalAnalysisClick?: () => void;
  onLogout?: () => void;
}
export function Sidebar({
  isOpen,
  onClose,
  onNewChat,
  onProfileClick,
  onJudgesClick,
  onLawyersClick,
  onClientsClick,
  onCasesClick,
  onHistoryClick,
  onDecisionsClick,
  onBillingClick,
  onLegislationMonitoringClick,
  onCourtPracticeAnalysisClick,
  onLegalInitiativesClick,
  onLegislationStatisticsClick,
  onVotingAnalysisClick,
  onLegalCodesLibraryClick,
  onHistoricalAnalysisClick,
  onLogout
}: SidebarProps) {
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
      profileMenuRef.current &&
      !profileMenuRef.current.contains(event.target as Node))
      {
        setShowProfileMenu(false);
      }
    };
    if (showProfileMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showProfileMenu]);
  const contextSections = [
  {
    id: 'clients',
    label: 'Клієнти',
    icon: Users,
    count: 12,
    onClick: onClientsClick
  },
  {
    id: 'cases',
    label: 'Справи',
    icon: Briefcase,
    count: 8,
    onClick: onCasesClick
  },
  {
    id: 'billing',
    label: 'Billing',
    icon: DollarSign,
    count: null,
    onClick: onBillingClick
  },
  {
    id: 'documents',
    label: 'Документи',
    icon: FileText,
    count: 45
  },
  {
    id: 'legal-sources',
    label: 'Джерела права',
    icon: Scale,
    count: null
  },
  {
    id: 'history',
    label: 'Історія запитів',
    icon: Clock,
    count: null,
    onClick: onHistoryClick
  }];

  const evidenceSections = [
  {
    id: 'decisions',
    label: 'Судові рішення',
    icon: Gavel,
    onClick: onDecisionsClick
  },
  {
    id: 'regulations',
    label: 'Нормативні акти',
    icon: BookOpen
  },
  {
    id: 'commentary',
    label: 'Коментарі та практика',
    icon: MessageSquare
  },
  {
    id: 'verification',
    label: 'Перевірка актуальності',
    icon: CheckCircle
  }];

  const legislativeSections = [
  {
    id: 'monitoring',
    label: 'Моніторинг змін законодавства',
    icon: Bell,
    onClick: onLegislationMonitoringClick
  },
  {
    id: 'court-analysis',
    label: 'Аналіз судової практики',
    icon: TrendingUp,
    onClick: onCourtPracticeAnalysisClick
  },
  {
    id: 'initiatives',
    label: 'Відстеження ініціатив',
    icon: FileCode,
    onClick: onLegalInitiativesClick
  },
  {
    id: 'statistics',
    label: 'Статистика прийняття законів',
    icon: BarChart3,
    onClick: onLegislationStatisticsClick
  },
  {
    id: 'voting',
    label: 'Аналіз голосувань',
    icon: Vote,
    onClick: onVotingAnalysisClick
  },
  {
    id: 'codes',
    label: 'Кодекси та закони',
    icon: BookOpen,
    onClick: onLegalCodesLibraryClick
  },
  {
    id: 'historical',
    label: 'Історичний аналіз',
    icon: History,
    onClick: onHistoricalAnalysisClick
  }];

  const handleProfileMenuClick = () => {
    setShowProfileMenu(!showProfileMenu);
  };
  const handleProfileClick = () => {
    setShowProfileMenu(false);
    if (onProfileClick) onProfileClick();
  };
  const handleLogout = () => {
    setShowProfileMenu(false);
    if (onLogout) onLogout();
  };
  return (
    <>
      {/* Mobile Backdrop */}
      <AnimatePresence>
        {isOpen &&
        <motion.div
          initial={{
            opacity: 0
          }}
          animate={{
            opacity: 1
          }}
          exit={{
            opacity: 0
          }}
          transition={{
            duration: 0.3,
            ease: [0.22, 1, 0.36, 1]
          }}
          onClick={onClose}
          className="fixed inset-0 bg-black/25 z-40 lg:hidden backdrop-blur-[2px]" />

        }
      </AnimatePresence>

      {/* Sidebar Container */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-50 w-[280px] bg-claude-sidebar border-r border-claude-border flex flex-col transition-transform duration-400 ease-[cubic-bezier(0.22,1,0.36,1)] ${isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>

        {/* Header */}
        <div className="p-4 flex items-center justify-between border-b border-claude-border/50">
          <div className="flex items-center gap-3 px-1">
            <div className="h-16 flex items-center">
              <img
                src="/Image.jpg"
                alt="Lex"
                className="h-full w-auto object-contain" />

            </div>
          </div>
          <button
            onClick={onClose}
            className="lg:hidden p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-lg transition-all duration-200">

            <X size={18} strokeWidth={2} />
          </button>
        </div>

        {/* New Chat Button */}
        <div className="p-4 pb-3">
          <button
            onClick={() => {
              onNewChat();
              if (window.innerWidth < 1024) onClose();
            }}
            className="w-full flex items-center gap-3 px-4 py-2.5 bg-white border border-claude-border hover:bg-claude-bg hover:border-claude-subtext/30 rounded-[12px] text-claude-text shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all duration-200 group active:scale-[0.98]">

            <div className="p-1 bg-claude-subtext/10 rounded-full group-hover:bg-claude-subtext/15 transition-colors duration-200">
              <Plus size={15} strokeWidth={2.5} className="text-claude-text" />
            </div>
            <span className="font-medium text-[13px] tracking-tight font-sans">
              Новий запит
            </span>
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-3 py-1">
          {/* Context Section */}
          <div className="mb-6">
            <h3 className="px-3 py-2 text-[11px] font-semibold text-claude-subtext/70 uppercase tracking-[0.5px] font-sans">
              Контекст роботи
            </h3>
            <div className="space-y-0.5">
              {contextSections.map((section) =>
              <button
                key={section.id}
                onClick={() => {
                  if (section.onClick) {
                    section.onClick();
                    if (window.innerWidth < 1024) onClose();
                  }
                }}
                className="w-full text-left px-3 py-2 rounded-lg text-[13px] text-claude-text hover:bg-claude-subtext/8 transition-all duration-200 flex items-center justify-between group">

                  <div className="flex items-center gap-3 min-w-0">
                    <section.icon
                    size={15}
                    strokeWidth={2}
                    className="text-claude-subtext/60 group-hover:text-claude-text transition-colors duration-200 flex-shrink-0" />

                    <span className="truncate font-medium tracking-tight font-sans">
                      {section.label}
                    </span>
                  </div>
                  {section.count !== null &&
                <span className="text-[11px] text-claude-subtext/50 font-medium px-1.5 py-0.5 bg-claude-subtext/5 rounded flex-shrink-0 font-sans">
                      {section.count}
                    </span>
                }
                </button>
              )}
            </div>
          </div>

          {/* Evidence Section */}
          <div className="mb-6">
            <h3 className="px-3 py-2 text-[11px] font-semibold text-claude-subtext/70 uppercase tracking-[0.5px] font-sans">
              Доказова база
            </h3>
            <div className="space-y-0.5">
              {evidenceSections.map((section) =>
              <button
                key={section.id}
                onClick={() => {
                  if (section.onClick) {
                    section.onClick();
                    if (window.innerWidth < 1024) onClose();
                  }
                }}
                className="w-full text-left px-3 py-2 rounded-lg text-[13px] text-claude-text hover:bg-claude-subtext/8 transition-all duration-200 flex items-center gap-3 group">

                  <section.icon
                  size={15}
                  strokeWidth={2}
                  className="text-claude-subtext/60 group-hover:text-claude-text transition-colors duration-200 flex-shrink-0" />

                  <span className="truncate font-medium tracking-tight font-sans">
                    {section.label}
                  </span>
                </button>
              )}
            </div>
          </div>

          {/* Legislative Monitoring Section */}
          <div className="mb-6">
            <h3 className="px-3 py-2 text-[11px] font-semibold text-claude-subtext/70 uppercase tracking-[0.5px] font-sans">
              Законодавство
            </h3>
            <div className="space-y-0.5">
              {legislativeSections.map((section) =>
              <button
                key={section.id}
                onClick={() => {
                  if (section.onClick) {
                    section.onClick();
                  }
                  if (window.innerWidth < 1024) onClose();
                }}
                className="w-full text-left px-3 py-2 rounded-lg text-[13px] text-claude-text hover:bg-claude-subtext/8 transition-all duration-200 flex items-center gap-3 group">

                  <section.icon
                  size={15}
                  strokeWidth={2}
                  className="text-claude-subtext/60 group-hover:text-claude-text transition-colors duration-200 flex-shrink-0" />

                  <span className="truncate font-medium tracking-tight font-sans">
                    {section.label}
                  </span>
                </button>
              )}
            </div>
          </div>

          {/* Judges and Lawyers Section */}
          <div className="mb-6">
            <h3 className="px-3 py-2 text-[11px] font-semibold text-claude-subtext/70 uppercase tracking-[0.5px] font-sans">
              Учасники процесу
            </h3>
            <div className="space-y-0.5">
              <button
                onClick={() => {
                  if (onJudgesClick) onJudgesClick();
                  if (window.innerWidth < 1024) onClose();
                }}
                className="w-full text-left px-3 py-2 rounded-lg text-[13px] text-claude-text hover:bg-claude-subtext/8 transition-all duration-200 flex items-center gap-3 group">

                <Scale
                  size={15}
                  strokeWidth={2}
                  className="text-claude-subtext/60 group-hover:text-claude-text transition-colors duration-200 flex-shrink-0" />

                <span className="truncate font-medium tracking-tight font-sans">
                  Судді
                </span>
              </button>
              <button
                onClick={() => {
                  if (onLawyersClick) onLawyersClick();
                  if (window.innerWidth < 1024) onClose();
                }}
                className="w-full text-left px-3 py-2 rounded-lg text-[13px] text-claude-text hover:bg-claude-subtext/8 transition-all duration-200 flex items-center gap-3 group">

                <Briefcase
                  size={15}
                  strokeWidth={2}
                  className="text-claude-subtext/60 group-hover:text-claude-text transition-colors duration-200 flex-shrink-0" />

                <span className="truncate font-medium tracking-tight font-sans">
                  Адвокати
                </span>
              </button>
            </div>
          </div>

          {/* Upgrade Card */}
          <div className="px-3 py-3 border-t border-claude-border/50">
            <div className="p-3.5 bg-gradient-to-br from-claude-subtext/5 to-claude-subtext/8 rounded-[12px] border border-claude-border">
              <h4 className="text-[13px] font-semibold text-claude-text mb-1 tracking-tight font-sans">
                Оновити до Pro
              </h4>
              <p className="text-[11px] text-claude-subtext/80 mb-3 leading-relaxed font-sans">
                Доступ до розширеної бази рішень та аналітики.
              </p>
              <button className="text-[12px] font-semibold text-white bg-claude-text hover:bg-claude-text/90 px-3 py-1.5 rounded-lg transition-all duration-200 w-full shadow-sm active:scale-[0.98] font-sans">
                Оновити
              </button>
            </div>
          </div>
        </div>

        {/* User Profile */}
        <div
          className="p-4 border-t border-claude-border relative"
          ref={profileMenuRef}>

          {/* Profile Menu Dropdown */}
          <AnimatePresence>
            {showProfileMenu &&
            <motion.div
              initial={{
                opacity: 0,
                y: 10,
                scale: 0.95
              }}
              animate={{
                opacity: 1,
                y: 0,
                scale: 1
              }}
              exit={{
                opacity: 0,
                y: 10,
                scale: 0.95
              }}
              transition={{
                duration: 0.2,
                ease: [0.22, 1, 0.36, 1]
              }}
              className="absolute bottom-full left-4 right-4 mb-2 bg-white rounded-xl border border-claude-border shadow-xl overflow-hidden z-50">

                <button
                onClick={handleProfileClick}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-claude-bg transition-colors border-b border-claude-border/50">

                  <div className="p-1.5 bg-claude-accent/10 rounded-lg">
                    <User size={16} className="text-claude-accent" />
                  </div>
                  <span className="text-[13px] font-medium text-claude-text font-sans">
                    Профіль
                  </span>
                </button>
                <button
                onClick={handleLogout}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-red-50 transition-colors">

                  <div className="p-1.5 bg-red-50 rounded-lg">
                    <LogOut size={16} className="text-red-600" />
                  </div>
                  <span className="text-[13px] font-medium text-red-600 font-sans">
                    Вихід
                  </span>
                </button>
              </motion.div>
            }
          </AnimatePresence>

          <button
            onClick={handleProfileMenuClick}
            className="w-full flex items-center gap-3 px-2 py-2 hover:bg-claude-subtext/8 rounded-lg transition-all duration-200">

            <div className="w-8 h-8 rounded-full bg-claude-subtext/15 flex items-center justify-center text-claude-subtext text-[11px] font-semibold">
              JD
            </div>
            <div className="flex-1 text-left">
              <div className="text-[13px] font-semibold text-claude-text tracking-tight font-sans">
                John Doe
              </div>
              <div className="text-[11px] text-claude-subtext/70 font-sans">
                Юрист
              </div>
            </div>
          </button>
        </div>
      </aside>
    </>);

}