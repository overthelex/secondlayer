/**
 * Main Layout
 * Common layout structure with sidebar, header, and content area
 */

import React from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { X, Menu, PanelRightOpen } from 'lucide-react';
import { Sidebar } from '../components/Sidebar';
import { RightPanel } from '../components/RightPanel';
import { TimeTrackerWidget } from '../components/time/TimeTrackerWidget';
import { useAuth } from '../contexts/AuthContext';
import { useUIStore } from '../stores';
import { ROUTES } from '../router/routes';

// Map routes to page titles
const PAGE_TITLES: Record<string, string> = {
  [ROUTES.CHAT]: 'Чат',
  [ROUTES.PROFILE]: 'Профіль',
  [ROUTES.BILLING]: 'Білінг',
  [ROUTES.JUDGES]: 'Судді',
  [ROUTES.LAWYERS]: 'Адвокати',
  [ROUTES.CLIENTS]: 'Клієнти',
  [ROUTES.DOCUMENTS]: 'Документи',
  [ROUTES.MATTERS]: 'Справи (юридичні)',
  [ROUTES.HISTORY]: 'Історія запитів',
  [ROUTES.DECISIONS_SEARCH]: 'Пошук судових рішень',
  [ROUTES.CASE_ANALYSIS]: 'Аналіз справи',
  [ROUTES.LEGISLATION_MONITORING]: 'Моніторинг законодавства',
  [ROUTES.COURT_PRACTICE_ANALYSIS]: 'Аналіз судової практики',
  [ROUTES.LEGAL_INITIATIVES]: 'Законодавчі ініціативи',
  [ROUTES.LEGISLATION_STATISTICS]: 'Статистика законів',
  [ROUTES.VOTING_ANALYSIS]: 'Аналіз голосувань',
  [ROUTES.LEGAL_CODES_LIBRARY]: 'Бібліотека кодексів',
  [ROUTES.HISTORICAL_ANALYSIS]: 'Історичний аналіз',
  [ROUTES.CLIENT_MESSAGING]: 'Відправити повідомлення',
  [ROUTES.TIME_ENTRIES]: 'Time Entries',
  [ROUTES.INVOICES]: 'Invoices',
  [ROUTES.CALENDAR]: 'Calendar',
  [ROUTES.ADMIN_OVERVIEW]: 'System Overview',
  [ROUTES.ADMIN_MONITORING]: 'Data Sources Monitoring',
  [ROUTES.ADMIN_USERS]: 'User Management',
  [ROUTES.ADMIN_COSTS]: 'API Costs & Analytics',
  [ROUTES.ADMIN_DATA_SOURCES]: 'Джерела даних',
};

export function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { logout } = useAuth();

  // Use UI store for sidebar and panel state
  const {
    isSidebarOpen,
    isRightPanelOpen,
    toggleSidebar,
    toggleRightPanel,
    setSidebarOpen,
  } = useUIStore();

  const handleNewChat = () => {
    navigate(ROUTES.CHAT, { replace: true, state: { reset: true } });
  };

  const handleLogout = () => {
    logout();
  };

  // Get current page title based on route
  const getPageTitle = () => {
    // Check for exact match
    if (PAGE_TITLES[location.pathname]) {
      return PAGE_TITLES[location.pathname];
    }

    // Check for dynamic routes
    if (location.pathname.startsWith('/judges/')) {
      return 'Деталі судді';
    }
    if (location.pathname.startsWith('/lawyers/')) {
      return 'Деталі адвоката';
    }
    if (location.pathname.startsWith('/clients/')) {
      if (location.pathname === ROUTES.CLIENT_MESSAGING) {
        return PAGE_TITLES[ROUTES.CLIENT_MESSAGING];
      }
      return 'Деталі клієнта';
    }
    if (location.pathname.startsWith('/matters/')) {
      return 'Деталі справи';
    }

    return 'SecondLayer';
  };

  const pageTitle = getPageTitle();

  return (
    <div className="flex h-screen bg-claude-bg overflow-hidden">
      {/* Sidebar */}
      <div className={`${isSidebarOpen ? 'block' : 'hidden'} lg:block h-full`}>
        <Sidebar
          isOpen={isSidebarOpen}
          onClose={() => setSidebarOpen(false)}
          onNewChat={handleNewChat}
          onProfileClick={() => navigate(ROUTES.PROFILE)}
          onJudgesClick={() => navigate(ROUTES.JUDGES)}
          onLawyersClick={() => navigate(ROUTES.LAWYERS)}
          onClientsClick={() => navigate(ROUTES.CLIENTS)}
          onMattersClick={() => navigate(ROUTES.MATTERS)}
          onTimeEntriesClick={() => navigate(ROUTES.TIME_ENTRIES)}
          onInvoicesClick={() => navigate(ROUTES.INVOICES)}
          onDocumentsClick={() => navigate(ROUTES.DOCUMENTS)}
          onCasesClick={() => navigate(ROUTES.CASE_ANALYSIS)}
          onHistoryClick={() => navigate(ROUTES.HISTORY)}
          onDecisionsClick={() => navigate(ROUTES.DECISIONS_SEARCH)}
          onBillingClick={() => navigate(ROUTES.BILLING)}
          onTeamClick={() => navigate(ROUTES.TEAM)}
          onLegislationMonitoringClick={() => navigate(ROUTES.LEGISLATION_MONITORING)}
          onCourtPracticeAnalysisClick={() => navigate(ROUTES.COURT_PRACTICE_ANALYSIS)}
          onLegalInitiativesClick={() => navigate(ROUTES.LEGAL_INITIATIVES)}
          onLegislationStatisticsClick={() => navigate(ROUTES.LEGISLATION_STATISTICS)}
          onVotingAnalysisClick={() => navigate(ROUTES.VOTING_ANALYSIS)}
          onLegalCodesLibraryClick={() => navigate(ROUTES.LEGAL_CODES_LIBRARY)}
          onHistoricalAnalysisClick={() => navigate(ROUTES.HISTORICAL_ANALYSIS)}
          onAdminOverviewClick={() => navigate(ROUTES.ADMIN_OVERVIEW)}
          onAdminMonitoringClick={() => navigate(ROUTES.ADMIN_MONITORING)}
          onAdminUsersClick={() => navigate(ROUTES.ADMIN_USERS)}
          onAdminCostsClick={() => navigate(ROUTES.ADMIN_COSTS)}
          onAdminDataSourcesClick={() => navigate(ROUTES.ADMIN_DATA_SOURCES)}
          onLogout={handleLogout}
        />
      </div>

      <main className="flex-1 flex flex-col min-w-0 relative h-full">
        {/* Desktop Header */}
        <header className="hidden lg:flex items-center justify-between px-6 py-3 border-b border-claude-border bg-white/80 backdrop-blur-sm sticky top-0 z-30">
          {/* Left: Toggle button */}
          <div className="flex items-center gap-3 w-[200px]">
            <button
              onClick={toggleSidebar}
              className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-lg transition-all duration-200"
              title={isSidebarOpen ? 'Сховати меню' : 'Показати меню'}
            >
              {isSidebarOpen ? (
                <X size={18} strokeWidth={2} />
              ) : (
                <Menu size={18} strokeWidth={2} />
              )}
            </button>
          </div>

          {/* Center: Page title */}
          <div className="flex-1 flex items-center justify-center">
            <h1 className="font-sans text-lg text-claude-text font-medium">
              {pageTitle}
            </h1>
          </div>

          {/* Right: Toggle right panel button */}
          <div className="flex items-center justify-end gap-2 w-[200px]">
            <button
              onClick={toggleRightPanel}
              className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-lg transition-all duration-200"
              title={isRightPanelOpen ? 'Сховати панель' : 'Показати панель'}
            >
              {isRightPanelOpen ? (
                <X size={18} strokeWidth={2} />
              ) : (
                <PanelRightOpen size={18} strokeWidth={2} />
              )}
            </button>
          </div>
        </header>

        {/* Mobile Header */}
        <header className="lg:hidden flex items-center justify-between px-4 py-2.5 border-b border-claude-border bg-white/80 backdrop-blur-md sticky top-0 z-30">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-lg transition-all duration-200"
          >
            <img
              src="/Image_1.jpg"
              alt="Menu"
              className="w-6 h-6 object-contain"
            />
          </button>
          <div className="flex items-center">
            {pageTitle ? (
              <h1 className="text-base font-sans text-claude-text font-medium">
                {pageTitle}
              </h1>
            ) : (
              <img
                src="/Image.jpg"
                alt="Lex"
                className="h-10 w-auto object-contain"
              />
            )}
          </div>
          <button
            onClick={() => useUIStore.getState().setRightPanelOpen(true)}
            className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-lg transition-all duration-200"
          >
            <PanelRightOpen size={20} strokeWidth={2} />
          </button>
        </header>

        {/* Main Content Area - Outlet renders child routes */}
        <div className="flex-1 flex flex-col relative overflow-hidden">
          <Outlet />
        </div>
      </main>

      {/* Right Panel */}
      <div className={`${isRightPanelOpen ? 'block' : 'hidden'}`}>
        <RightPanel
          isOpen={isRightPanelOpen}
          onClose={() => useUIStore.getState().setRightPanelOpen(false)}
        />
      </div>

      {/* Time Tracker Widget */}
      <TimeTrackerWidget />
    </div>
  );
}
