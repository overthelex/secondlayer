import React, { useEffect, useState, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ROUTES } from '../router/routes';
import showToast from '../utils/toast';
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
  DollarSign,
  CreditCard,
  Tag,
  UsersRound,
  Trash2,
  Edit3,
  ChevronDown,
  ChevronsUpDown,
  Activity,
  Database,
  Globe,
  Server,
  Boxes,
  Settings,
  Terminal } from
'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '../contexts/AuthContext';
import { useChatStore } from '../stores/chatStore';
import type { UserRole } from '../types/models/User';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  onLogout?: () => void;
}

export function Sidebar({ isOpen, onClose, onLogout }: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const role: UserRole = user?.role || 'user';
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  const allSectionIds = ['conversations', 'context', 'evidence', 'legislation', 'finance', 'participants', 'monitoring'] as const;
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  const toggleSection = (sectionId: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  };

  const toggleAllSections = () => {
    if (collapsedSections.size === allSectionIds.length) {
      setCollapsedSections(new Set());
    } else {
      setCollapsedSections(new Set(allSectionIds));
    }
  };

  const allCollapsed = collapsedSections.size === allSectionIds.length;
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const {
    conversations,
    conversationId: activeConversationId,
    loadConversations,
    switchConversation,
    deleteConversation,
    renameConversation,
    newConversation,
  } = useChatStore();

  useEffect(() => {
    loadConversations();
  }, []);

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

  const handleNavigation = (route: string) => {
    navigate(route);
    if (window.innerWidth < 1024) onClose();
  };

  const handleNewChat = () => {
    newConversation();
    navigate(ROUTES.CHAT);
    if (window.innerWidth < 1024) onClose();
  };

  const handleSwitchConversation = async (convId: string) => {
    if (switchingId) return;
    setSwitchingId(convId);
    try {
      await switchConversation(convId);
      if (location.pathname !== ROUTES.CHAT) {
        navigate(ROUTES.CHAT);
      }
    } finally {
      setSwitchingId(null);
      if (window.innerWidth < 1024) onClose();
    }
  };

  // Items hidden for 'user' role (law firm features)
  const companyOnlyContextIds = ['clients', 'matters', 'time-entries', 'invoices'];

  const allContextSections = [
  {
    id: 'clients',
    label: 'Клієнти',
    icon: Users,
    count: 12,
    route: ROUTES.CLIENTS,
  },
  {
    id: 'matters',
    label: 'Справи (юр.)',
    icon: Briefcase,
    count: null,
    route: ROUTES.MATTERS,
  },
  {
    id: 'time-entries',
    label: 'Time Entries',
    icon: Clock,
    count: null,
    route: ROUTES.TIME_ENTRIES,
  },
  {
    id: 'invoices',
    label: 'Invoices',
    icon: FileText,
    count: null,
    route: ROUTES.INVOICES,
  },
  {
    id: 'cases',
    label: 'Аналіз справ',
    icon: Briefcase,
    count: null,
    route: ROUTES.CASE_ANALYSIS,
  },
  {
    id: 'documents',
    label: 'Документи',
    icon: FileText,
    count: null,
    route: ROUTES.DOCUMENTS,
  },
  {
    id: 'legal-sources',
    label: 'Джерела права',
    icon: Scale,
    count: null,
    route: null,
  },
  {
    id: 'history',
    label: 'Історія запитів',
    icon: Clock,
    count: null,
    route: ROUTES.HISTORY,
  }];

  const contextSections = role === 'user'
    ? allContextSections.filter(s => !companyOnlyContextIds.includes(s.id))
    : allContextSections;

  const monitoringSections = [
    { id: 'system-overview', label: 'Огляд системи', icon: Activity, route: ROUTES.ADMIN_OVERVIEW },
    { id: 'external-sources', label: 'Зовнішні джерела', icon: Database, route: ROUTES.ADMIN_MONITORING },
    { id: 'admin-users', label: 'Користувачі', icon: Users, route: ROUTES.ADMIN_USERS },
    { id: 'api-costs', label: 'Витрати API', icon: DollarSign, route: ROUTES.ADMIN_COSTS },
    { id: 'infrastructure', label: 'Інфраструктура', icon: Server, route: ROUTES.ADMIN_INFRASTRUCTURE },
    { id: 'containers', label: 'Контейнери', icon: Boxes, route: ROUTES.ADMIN_CONTAINERS },
    { id: 'data-sources', label: 'Джерела даних', icon: Globe, route: ROUTES.ADMIN_DATA_SOURCES },
    { id: 'admin-billing', label: 'Біллінг', icon: CreditCard, route: ROUTES.ADMIN_BILLING },
    { id: 'system-config', label: 'Конфігурація', icon: Settings, route: ROUTES.ADMIN_CONFIG },
    { id: 'db-compare', label: 'Порівняння БД', icon: Database, route: ROUTES.ADMIN_DB_COMPARE },
    { id: 'service-pricing', label: 'Собівартість сервісів', icon: Tag, route: ROUTES.ADMIN_SERVICE_PRICING },
    { id: 'terminal', label: 'Термінал', icon: Terminal, route: ROUTES.ADMIN_TERMINAL },
    { id: 'zo-stats', label: 'Статистика рішень', icon: BarChart3, route: ROUTES.ADMIN_ZO_STATS },
  ];

  const evidenceSections = [
  {
    id: 'decisions',
    label: 'Судові рішення',
    icon: Gavel,
    route: ROUTES.DECISIONS_SEARCH,
  },
  {
    id: 'regulations',
    label: 'Нормативні акти',
    icon: BookOpen,
    route: null,
  },
  {
    id: 'commentary',
    label: 'Коментарі та практика',
    icon: MessageSquare,
    route: null,
  },
  {
    id: 'verification',
    label: 'Перевірка актуальності',
    icon: CheckCircle,
    route: null,
  }];

  const legislativeSections = [
  {
    id: 'monitoring',
    label: 'Моніторинг змін законодавства',
    icon: Bell,
    route: ROUTES.LEGISLATION_MONITORING,
  },
  {
    id: 'court-analysis',
    label: 'Аналіз судової практики',
    icon: TrendingUp,
    route: ROUTES.COURT_PRACTICE_ANALYSIS,
  },
  {
    id: 'initiatives',
    label: 'Відстеження ініціатив',
    icon: FileCode,
    route: ROUTES.LEGAL_INITIATIVES,
  },
  {
    id: 'statistics',
    label: 'Статистика прийняття законів',
    icon: BarChart3,
    route: ROUTES.LEGISLATION_STATISTICS,
  },
  {
    id: 'voting',
    label: 'Аналіз голосувань',
    icon: Vote,
    route: ROUTES.VOTING_ANALYSIS,
  },
  {
    id: 'codes',
    label: 'Кодекси та закони',
    icon: BookOpen,
    route: ROUTES.LEGAL_CODES_LIBRARY,
  },
  {
    id: 'historical',
    label: 'Історичний аналіз',
    icon: History,
    route: ROUTES.HISTORICAL_ANALYSIS,
  }];

  const handleProfileMenuClick = () => {
    setShowProfileMenu(!showProfileMenu);
  };

  const handleProfileClick = () => {
    setShowProfileMenu(false);
    navigate(ROUTES.PROFILE);
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
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          onClick={onClose}
          className="fixed inset-0 bg-black/25 z-40 lg:hidden backdrop-blur-[2px]" />
        }
      </AnimatePresence>

      {/* Sidebar Container */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 lg:inset-auto z-50 w-[280px] h-screen lg:h-full bg-claude-sidebar border-r border-claude-border flex flex-col transition-transform duration-400 ease-[cubic-bezier(0.22,1,0.36,1)] ${isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>

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
            onClick={handleNewChat}
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
          {/* Collapse/Expand All Button */}
          <div className="flex justify-end px-1 py-1">
            <button
              onClick={toggleAllSections}
              title={allCollapsed ? 'Розгорнути все' : 'Згорнути все'}
              className="p-1.5 text-claude-subtext/50 hover:text-claude-text hover:bg-claude-subtext/8 rounded-lg transition-all duration-200"
            >
              <ChevronsUpDown size={14} strokeWidth={2} />
            </button>
          </div>

          {/* Conversation History */}
          {conversations.length > 0 && (
            <div className="mb-4">
              <button
                onClick={() => toggleSection('conversations')}
                className="w-full flex items-center justify-between px-3 py-2 group cursor-pointer"
              >
                <h3 className="text-[11px] font-semibold text-claude-subtext/70 uppercase tracking-[0.5px] font-sans">
                  Розмови
                </h3>
                <ChevronDown
                  size={12}
                  strokeWidth={2.5}
                  className={`text-claude-subtext/40 group-hover:text-claude-subtext/70 transition-transform duration-200 ${collapsedSections.has('conversations') ? '-rotate-90' : ''}`}
                />
              </button>
              {!collapsedSections.has('conversations') && (
                <div className="space-y-0.5 max-h-[320px] overflow-y-auto">
                  {conversations.map((conv) => (
                    <div
                      key={conv.id}
                      className={`group flex items-center gap-1 px-3 py-2 rounded-lg text-[13px] cursor-pointer transition-all duration-200 ${
                        activeConversationId === conv.id
                          ? 'bg-claude-accent/10 text-claude-accent'
                          : 'text-claude-text hover:bg-claude-subtext/8'
                      } ${switchingId === conv.id ? 'opacity-60 pointer-events-none' : ''}`}
                      onClick={() => handleSwitchConversation(conv.id)}
                    >
                      <MessageSquare size={14} strokeWidth={2} className="flex-shrink-0 opacity-60" />
                      {editingId === conv.id ? (
                        <input
                          className="flex-1 min-w-0 bg-white border border-claude-border rounded px-1 py-0.5 text-[13px] outline-none"
                          value={editTitle}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              renameConversation(conv.id, editTitle);
                              setEditingId(null);
                            } else if (e.key === 'Escape') {
                              setEditingId(null);
                            }
                          }}
                          onBlur={() => {
                            renameConversation(conv.id, editTitle);
                            setEditingId(null);
                          }}
                          autoFocus
                        />
                      ) : (
                        <span className="flex-1 truncate font-medium tracking-tight font-sans">
                          {conv.title}
                        </span>
                      )}
                      {switchingId === conv.id ? (
                        <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin flex-shrink-0 opacity-50" />
                      ) : (
                        <div className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingId(conv.id);
                              setEditTitle(conv.title);
                            }}
                            className="p-1 hover:bg-claude-subtext/15 rounded transition-colors"
                          >
                            <Edit3 size={12} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteConversation(conv.id);
                            }}
                            className="p-1 hover:bg-red-100 text-red-500 rounded transition-colors"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Context Section — hidden for administrator */}
          {role !== 'administrator' && (
          <div className="mb-6">
            <button
              onClick={() => toggleSection('context')}
              className="w-full flex items-center justify-between px-3 py-2 group cursor-pointer"
            >
              <h3 className="text-[11px] font-semibold text-claude-subtext/70 uppercase tracking-[0.5px] font-sans">
                Контекст роботи
              </h3>
              <ChevronDown
                size={12}
                strokeWidth={2.5}
                className={`text-claude-subtext/40 group-hover:text-claude-subtext/70 transition-transform duration-200 ${collapsedSections.has('context') ? '-rotate-90' : ''}`}
              />
            </button>
            {!collapsedSections.has('context') && (
              <div className="space-y-0.5">
                {contextSections.map((section) =>
                <button
                  key={section.id}
                  onClick={() => {
                    if (section.route) {
                      handleNavigation(section.route);
                    } else {
                      showToast.info('Скоро буде доступно');
                    }
                  }}
                  className={`w-full text-left px-3 py-2 rounded-lg text-[13px] transition-all duration-200 flex items-center justify-between group ${section.route && location.pathname === section.route ? 'bg-claude-accent/10 text-claude-accent' : 'text-claude-text hover:bg-claude-subtext/8'}`}>
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
            )}
          </div>
          )}

          {/* Evidence Section — hidden for administrator */}
          {role !== 'administrator' && (
          <div className="mb-6">
            <button
              onClick={() => toggleSection('evidence')}
              className="w-full flex items-center justify-between px-3 py-2 group cursor-pointer"
            >
              <h3 className="text-[11px] font-semibold text-claude-subtext/70 uppercase tracking-[0.5px] font-sans">
                Доказова база
              </h3>
              <ChevronDown
                size={12}
                strokeWidth={2.5}
                className={`text-claude-subtext/40 group-hover:text-claude-subtext/70 transition-transform duration-200 ${collapsedSections.has('evidence') ? '-rotate-90' : ''}`}
              />
            </button>
            {!collapsedSections.has('evidence') && (
              <div className="space-y-0.5">
                {evidenceSections.map((section) =>
                <button
                  key={section.id}
                  onClick={() => {
                    if (section.route) {
                      handleNavigation(section.route);
                    } else {
                      showToast.info('Скоро буде доступно');
                    }
                  }}
                  className={`w-full text-left px-3 py-2 rounded-lg text-[13px] transition-all duration-200 flex items-center gap-3 group ${section.route && location.pathname === section.route ? 'bg-claude-accent/10 text-claude-accent' : 'text-claude-text hover:bg-claude-subtext/8'}`}>
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
            )}
          </div>
          )}

          {/* Legislative Monitoring Section — hidden for administrator */}
          {role !== 'administrator' && (
          <div className="mb-6">
            <button
              onClick={() => toggleSection('legislation')}
              className="w-full flex items-center justify-between px-3 py-2 group cursor-pointer"
            >
              <h3 className="text-[11px] font-semibold text-claude-subtext/70 uppercase tracking-[0.5px] font-sans">
                Законодавство
              </h3>
              <ChevronDown
                size={12}
                strokeWidth={2.5}
                className={`text-claude-subtext/40 group-hover:text-claude-subtext/70 transition-transform duration-200 ${collapsedSections.has('legislation') ? '-rotate-90' : ''}`}
              />
            </button>
            {!collapsedSections.has('legislation') && (
              <div className="space-y-0.5">
                {legislativeSections.map((section) =>
                <button
                  key={section.id}
                  onClick={() => {
                    if (section.route) {
                      handleNavigation(section.route);
                    } else {
                      showToast.info('Скоро буде доступно');
                    }
                  }}
                  className={`w-full text-left px-3 py-2 rounded-lg text-[13px] transition-all duration-200 flex items-center gap-3 group ${section.route && location.pathname === section.route ? 'bg-claude-accent/10 text-claude-accent' : 'text-claude-text hover:bg-claude-subtext/8'}`}>
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
            )}
          </div>
          )}

          {/* Finance Section — hidden for administrator */}
          {role !== 'administrator' && (
          <div className="mb-6">
            <button
              onClick={() => toggleSection('finance')}
              className="w-full flex items-center justify-between px-3 py-2 group cursor-pointer"
            >
              <h3 className="text-[11px] font-semibold text-claude-subtext/70 uppercase tracking-[0.5px] font-sans">
                Фінанси
              </h3>
              <ChevronDown
                size={12}
                strokeWidth={2.5}
                className={`text-claude-subtext/40 group-hover:text-claude-subtext/70 transition-transform duration-200 ${collapsedSections.has('finance') ? '-rotate-90' : ''}`}
              />
            </button>
            {!collapsedSections.has('finance') && (
              <div className="space-y-0.5">
                <button
                  onClick={() => handleNavigation(ROUTES.BILLING)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-[13px] transition-all duration-200 flex items-center gap-3 group ${location.pathname === ROUTES.BILLING ? 'bg-claude-accent/10 text-claude-accent' : 'text-claude-text hover:bg-claude-subtext/8'}`}>
                  <CreditCard
                    size={15}
                    strokeWidth={2}
                    className="text-claude-subtext/60 group-hover:text-claude-text transition-colors duration-200 flex-shrink-0" />
                  <span className="truncate font-medium tracking-tight font-sans">
                    Біллінг
                  </span>
                </button>
                {role === 'company' && (
                <button
                  onClick={() => handleNavigation(ROUTES.TEAM)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-[13px] transition-all duration-200 flex items-center gap-3 group ${location.pathname === ROUTES.TEAM ? 'bg-claude-accent/10 text-claude-accent' : 'text-claude-text hover:bg-claude-subtext/8'}`}>
                  <UsersRound
                    size={15}
                    strokeWidth={2}
                    className="text-claude-subtext/60 group-hover:text-claude-text transition-colors duration-200 flex-shrink-0" />
                  <span className="truncate font-medium tracking-tight font-sans">
                    Команда
                  </span>
                </button>
                )}
              </div>
            )}
          </div>
          )}

          {/* Judges and Lawyers Section — hidden for administrator */}
          {role !== 'administrator' && (
          <div className="mb-6">
            <button
              onClick={() => toggleSection('participants')}
              className="w-full flex items-center justify-between px-3 py-2 group cursor-pointer"
            >
              <h3 className="text-[11px] font-semibold text-claude-subtext/70 uppercase tracking-[0.5px] font-sans">
                Учасники процесу
              </h3>
              <ChevronDown
                size={12}
                strokeWidth={2.5}
                className={`text-claude-subtext/40 group-hover:text-claude-subtext/70 transition-transform duration-200 ${collapsedSections.has('participants') ? '-rotate-90' : ''}`}
              />
            </button>
            {!collapsedSections.has('participants') && (
              <div className="space-y-0.5">
                <button
                  onClick={() => handleNavigation(ROUTES.JUDGES)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-[13px] transition-all duration-200 flex items-center gap-3 group ${location.pathname === ROUTES.JUDGES ? 'bg-claude-accent/10 text-claude-accent' : 'text-claude-text hover:bg-claude-subtext/8'}`}>
                  <Scale
                    size={15}
                    strokeWidth={2}
                    className="text-claude-subtext/60 group-hover:text-claude-text transition-colors duration-200 flex-shrink-0" />
                  <span className="truncate font-medium tracking-tight font-sans">
                    Судді
                  </span>
                </button>
                <button
                  onClick={() => handleNavigation(ROUTES.LAWYERS)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-[13px] transition-all duration-200 flex items-center gap-3 group ${location.pathname === ROUTES.LAWYERS ? 'bg-claude-accent/10 text-claude-accent' : 'text-claude-text hover:bg-claude-subtext/8'}`}>
                  <Briefcase
                    size={15}
                    strokeWidth={2}
                    className="text-claude-subtext/60 group-hover:text-claude-text transition-colors duration-200 flex-shrink-0" />
                  <span className="truncate font-medium tracking-tight font-sans">
                    Адвокати
                  </span>
                </button>
              </div>
            )}
          </div>
          )}

          {/* Admin Monitoring Section — only for administrator */}
          {role === 'administrator' && (
          <div className="mb-6">
            <button
              onClick={() => toggleSection('monitoring')}
              className="w-full flex items-center justify-between px-3 py-2 group cursor-pointer"
            >
              <h3 className="text-[11px] font-semibold text-claude-subtext/70 uppercase tracking-[0.5px] font-sans">
                Моніторинг
              </h3>
              <ChevronDown
                size={12}
                strokeWidth={2.5}
                className={`text-claude-subtext/40 group-hover:text-claude-subtext/70 transition-transform duration-200 ${collapsedSections.has('monitoring') ? '-rotate-90' : ''}`}
              />
            </button>
            {!collapsedSections.has('monitoring') && (
              <div className="space-y-0.5">
                {monitoringSections.map((section) =>
                <button
                  key={section.id}
                  onClick={() => {
                    if (section.route) {
                      handleNavigation(section.route);
                    }
                  }}
                  className={`w-full text-left px-3 py-2 rounded-lg text-[13px] transition-all duration-200 flex items-center gap-3 group ${section.route && location.pathname === section.route ? 'bg-claude-accent/10 text-claude-accent' : 'text-claude-text hover:bg-claude-subtext/8'}`}>
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
            )}
          </div>
          )}

          {/* Upgrade Card — hidden for administrator */}
          {role !== 'administrator' && (
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
          )}
        </div>

        {/* User Profile */}
        <div
          className="p-4 border-t border-claude-border relative"
          ref={profileMenuRef}>

          {/* Profile Menu Dropdown */}
          <AnimatePresence>
            {showProfileMenu &&
            <motion.div
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.95 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
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
            {user?.picture ?
            <img
              src={user.picture}
              alt={user.name}
              className="w-8 h-8 rounded-full object-cover" /> :
            <div className="w-8 h-8 rounded-full bg-claude-subtext/15 flex items-center justify-center text-claude-subtext text-[11px] font-semibold">
              {user?.name?.split(' ').map(n => n[0]).join('').toUpperCase() || '?'}
            </div>
            }
            <div className="flex-1 text-left">
              <div className="text-[13px] font-semibold text-claude-text tracking-tight font-sans">
                {user?.name || 'Користувач'}
              </div>
              <div className="text-[11px] text-claude-subtext/70 font-sans">
                {user?.email || ''}
              </div>
            </div>
          </button>
        </div>
      </aside>
    </>);
}
