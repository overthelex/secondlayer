import React, { useState } from 'react';
import { Sidebar } from './Sidebar';
import { RightPanel } from './RightPanel';
import { ChatInput } from './ChatInput';
import { MessageThread } from './MessageThread';
import { EmptyState } from './EmptyState';
import { ProfilePage } from './ProfilePage';
import { useChatStore } from '../stores';
import { useMCPTool, useAIChat } from '../hooks/useMCPTool';
import showToast from '../utils/toast';
import { JudgesPage } from './JudgesPage';
import { LawyersPage } from './LawyersPage';
import { ClientsPage } from './ClientsPage';
import { HistoryPage } from './HistoryPage';
import { DecisionsSearchPage } from './DecisionsSearchPage';
import { PersonDetailPage } from './PersonDetailPage';
import { ClientDetailPage } from './ClientDetailPage';
import { ClientMessagingPage } from './ClientMessagingPage';
import { CaseAnalysisPage } from './CaseAnalysisPage';
import { LegislationMonitoringPage } from './LegislationMonitoringPage';
import { CourtPracticeAnalysisPage } from './CourtPracticeAnalysisPage';
import { LegalInitiativesPage } from './LegalInitiativesPage';
import { LegislationStatisticsPage } from './LegislationStatisticsPage';
import { VotingAnalysisPage } from './VotingAnalysisPage';
import { LegalCodesLibraryPage } from './LegalCodesLibraryPage';
import { HistoricalAnalysisPage } from './HistoricalAnalysisPage';
import { BillingDashboard } from './BillingDashboard';
import { useAuth } from '../contexts/AuthContext';
import {
  PanelRightOpen,
  X,
  Menu } from
'lucide-react';
type ViewState =
'chat' |
'profile' |
'judges' |
'lawyers' |
'clients' |
'cases' |
'history' |
'decisions' |
'billing' |
'person-detail' |
'client-detail' |
'client-messaging' |
'case-analysis' |
'legislation-monitoring' |
'court-practice-analysis' |
'legal-initiatives' |
'legislation-statistics' |
'voting-analysis' |
'legal-codes-library' |
'historical-analysis';
interface SelectedPerson {
  type: 'judge' | 'lawyer';
  data: {
    id: string;
    name: string;
    position: string;
    cases: number;
    successRate: number;
    specialization: string;
  };
}
interface Client {
  id: string;
  organization_id: string;
  client_name: string;
  client_type: 'individual' | 'business' | 'government';
  contact_email: string | null;
  tax_id: string | null;
  status: 'active' | 'inactive' | 'archived';
  conflict_check_date: string | null;
  conflict_status: 'unchecked' | 'clear' | 'flagged' | 'conflicted';
  metadata: Record<string, any>;
  created_at: string;
  created_by: string;
}
export function ChatLayout() {
  const { logout } = useAuth();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(true);
  const [selectedTool, setSelectedTool] = useState('ai_chat');
  const [currentView, setCurrentView] = useState<ViewState>('chat');
  const [selectedPerson, setSelectedPerson] = useState<SelectedPerson | null>(
    null
  );
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [messagingClientIds, setMessagingClientIds] = useState<string[]>([]);

  // Use Zustand store for messages and streaming state
  const { messages, isStreaming, cancelStream, removeMessage } = useChatStore();

  // Aggregate evidence from ALL messages in the current chat (deduplicated)
  const allDecisions = React.useMemo(() => {
    const seen = new Set<string>();
    return messages.flatMap(m => m.decisions || []).filter(d => {
      if (seen.has(d.id)) return false;
      seen.add(d.id);
      return true;
    });
  }, [messages]);

  const allCitations = React.useMemo(() => {
    const seen = new Set<string>();
    return messages.flatMap(m => m.citations || []).filter(c => {
      const key = `${c.source}::${c.text.slice(0, 50)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [messages]);

  const allDocuments = React.useMemo(() => {
    const seen = new Set<string>();
    return messages.flatMap(m => m.documents || []).filter(d => {
      if (seen.has(d.id)) return false;
      seen.add(d.id);
      return true;
    });
  }, [messages]);

  const hasSearchResults = allDecisions.length > 0 || allCitations.length > 0 || allDocuments.length > 0;

  // Auto-open RightPanel when search results arrive
  React.useEffect(() => {
    if (hasSearchResults && currentView === 'chat') {
      setIsRightPanelOpen(true);
    }
  }, [hasSearchResults, currentView]);

  // MCP Tool hook (for manual tool mode)
  const { executeTool } = useMCPTool(selectedTool === 'ai_chat' ? 'search_legal_precedents' : selectedTool, {
    enableStreaming: import.meta.env.VITE_ENABLE_SSE_STREAMING !== 'false',
  });

  // AI Chat hook (agentic mode)
  const { executeChat } = useAIChat();
  /**
   * Parse content to tool-specific parameters
   */
  const parseContentToToolParams = (toolName: string, content: string, documentIds?: string[]): any => {
    const base: any = {};
    if (documentIds && documentIds.length > 0) {
      base.document_ids = documentIds;
    }

    switch (toolName) {
      case 'search_legal_precedents':
        return {
          ...base,
          query: content,
          limit: 10,
        };

      case 'search_legislation':
        return {
          ...base,
          query: content,
          limit: 5,
        };

      default:
        return { ...base, query: content };
    }
  };

  const handleSend = async (content: string, toolName?: string, documentIds?: string[]) => {
    const tool = toolName || selectedTool;

    try {
      if (tool === 'ai_chat') {
        // AI Chat mode — agentic LLM loop
        await executeChat(content, documentIds);
      } else {
        // Manual tool mode — direct tool call
        const params = parseContentToToolParams(tool, content, documentIds);
        await executeTool(params);
      }
    } catch (error: any) {
      console.error('MCP tool execution error:', error);
      showToast.error(
        error.message || 'Помилка при зверненні до API. Спробуйте пізніше.'
      );
    }
  };

  const handleRegenerate = React.useCallback((userQuery: string) => {
    const msgs = useChatStore.getState().messages;
    const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant) removeMessage(lastAssistant.id);
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    if (lastUser) removeMessage(lastUser.id);
    handleSend(userQuery);
  }, [selectedTool, removeMessage]);
  const handleNewChat = () => {
    useChatStore.getState().clearMessages();
    setCurrentView('chat');
    setSelectedPerson(null);
    setSelectedClient(null);
    setMessagingClientIds([]);
  };
  const handleLogout = () => {
    // Clear chat state
    useChatStore.getState().clearMessages();
    setSelectedPerson(null);
    setSelectedClient(null);
    setMessagingClientIds([]);
    // Call logout from AuthContext (will redirect to login page)
    logout();
  };
  // Get page title based on current view
  const getPageTitle = () => {
    if (currentView === 'chat') return 'Чат';
    if (currentView === 'profile') return 'Профіль';
    if (currentView === 'judges') return 'Судді';
    if (currentView === 'lawyers') return 'Адвокати';
    if (currentView === 'clients') return 'Клієнти';
    if (currentView === 'cases') return 'Справи';
    if (currentView === 'history') return 'Історія запитів';
    if (currentView === 'decisions') return 'Пошук судових рішень';
    if (currentView === 'client-messaging') return 'Відправити повідомлення';
    if (currentView === 'case-analysis') return 'Аналіз справи';
    if (currentView === 'legislation-monitoring')
    return 'Моніторинг законодавства';
    if (currentView === 'court-practice-analysis')
    return 'Аналіз судової практики';
    if (currentView === 'legal-initiatives') return 'Законодавчі ініціативи';
    if (currentView === 'legislation-statistics') return 'Статистика законів';
    if (currentView === 'voting-analysis') return 'Аналіз голосувань';
    if (currentView === 'legal-codes-library') return 'Бібліотека кодексів';
    if (currentView === 'historical-analysis') return 'Історичний аналіз';
    if (selectedPerson) return selectedPerson.data.name;
    if (selectedClient) return selectedClient.client_name;
    return 'Чат';
  };
  const renderContent = () => {
    if (currentView === 'profile') {
      return (
        <div className="flex-1 overflow-hidden relative">
          <button
            onClick={() => setCurrentView('chat')}
            className="absolute top-4 right-4 z-10 p-2 bg-white rounded-full shadow-sm border border-claude-border text-claude-subtext hover:text-claude-text transition-colors">

            <X size={20} />
          </button>
          <ProfilePage />
        </div>);

    }
    if (currentView === 'judges') {
      return (
        <div className="flex-1 overflow-hidden relative">
          <button
            onClick={() => setCurrentView('chat')}
            className="absolute top-4 right-4 z-10 p-2 bg-white rounded-full shadow-sm border border-claude-border text-claude-subtext hover:text-claude-text transition-colors">

            <X size={20} />
          </button>
          <JudgesPage
            onSelectJudge={(judge) => {
              setSelectedPerson({
                type: 'judge',
                data: {
                  id: judge.id,
                  name: judge.name,
                  position: judge.court,
                  cases: judge.cases,
                  successRate: judge.approvalRate,
                  specialization: judge.specialization
                }
              });
              setCurrentView('person-detail');
            }} />

        </div>);

    }
    if (currentView === 'lawyers') {
      return (
        <div className="flex-1 overflow-hidden relative">
          <button
            onClick={() => setCurrentView('chat')}
            className="absolute top-4 right-4 z-10 p-2 bg-white rounded-full shadow-sm border border-claude-border text-claude-subtext hover:text-claude-text transition-colors">

            <X size={20} />
          </button>
          <LawyersPage
            onSelectLawyer={(lawyer) => {
              setSelectedPerson({
                type: 'lawyer',
                data: {
                  id: lawyer.id,
                  name: lawyer.name,
                  position: lawyer.firm,
                  cases: lawyer.cases,
                  successRate: lawyer.successRate,
                  specialization: lawyer.specialization
                }
              });
              setCurrentView('person-detail');
            }} />

        </div>);

    }
    if (currentView === 'clients') {
      return (
        <div className="flex-1 overflow-hidden relative">
          <button
            onClick={() => setCurrentView('chat')}
            className="absolute top-4 right-4 z-10 p-2 bg-white rounded-full shadow-sm border border-claude-border text-claude-subtext hover:text-claude-text transition-colors">

            <X size={20} />
          </button>
          <ClientsPage
            onSelectClient={(client) => {
              setSelectedClient(client);
              setCurrentView('client-detail');
            }} />

        </div>);

    }
    if (currentView === 'history') {
      return (
        <div className="flex-1 overflow-hidden relative">
          <button
            onClick={() => setCurrentView('chat')}
            className="absolute top-4 right-4 z-10 p-2 bg-white rounded-full shadow-sm border border-claude-border text-claude-subtext hover:text-claude-text transition-colors">

            <X size={20} />
          </button>
          <HistoryPage />
        </div>);

    }
    if (currentView === 'decisions') {
      return (
        <div className="flex-1 overflow-hidden relative">
          <button
            onClick={() => setCurrentView('chat')}
            className="absolute top-4 right-4 z-10 p-2 bg-white rounded-full shadow-sm border border-claude-border text-claude-subtext hover:text-claude-text transition-colors">

            <X size={20} />
          </button>
          <DecisionsSearchPage />
        </div>);

    }
    if (currentView === 'case-analysis') {
      return <CaseAnalysisPage onBack={() => setCurrentView('chat')} />;
    }
    if (currentView === 'legislation-monitoring') {
      return <LegislationMonitoringPage onBack={() => setCurrentView('chat')} />;
    }
    if (currentView === 'court-practice-analysis') {
      return <CourtPracticeAnalysisPage onBack={() => setCurrentView('chat')} />;
    }
    if (currentView === 'legal-initiatives') {
      return <LegalInitiativesPage onBack={() => setCurrentView('chat')} />;
    }
    if (currentView === 'legislation-statistics') {
      return <LegislationStatisticsPage onBack={() => setCurrentView('chat')} />;
    }
    if (currentView === 'voting-analysis') {
      return <VotingAnalysisPage onBack={() => setCurrentView('chat')} />;
    }
    if (currentView === 'legal-codes-library') {
      return <LegalCodesLibraryPage onBack={() => setCurrentView('chat')} />;
    }
    if (currentView === 'historical-analysis') {
      return <HistoricalAnalysisPage onBack={() => setCurrentView('chat')} />;
    }
    if (currentView === 'billing') {
      return <BillingDashboard onBack={() => setCurrentView('chat')} />;
    }
    if (currentView === 'person-detail' && selectedPerson) {
      return (
        <PersonDetailPage
          type={selectedPerson.type}
          person={selectedPerson.data}
          onBack={() => {
            if (selectedPerson.type === 'judge') setCurrentView('judges');else
            setCurrentView('lawyers');
            setSelectedPerson(null);
          }} />);


    }
    if (currentView === 'client-detail' && selectedClient) {
      return (
        <ClientDetailPage
          client={selectedClient as any}
          onBack={() => {
            setCurrentView('clients');
            setSelectedClient(null);
          }} />);


    }
    if (currentView === 'client-messaging') {
      return (
        <ClientMessagingPage
          clientIds={messagingClientIds}
          onBack={() => {
            setCurrentView('clients');
            setMessagingClientIds([]);
          }} />);


    }
    return (
      <>
        {messages.length === 0 ?
        <EmptyState onSelectPrompt={handleSend} /> :

        <MessageThread messages={messages} onRegenerate={handleRegenerate} />
        }
        <div className="w-full bg-gradient-to-t from-white via-white to-transparent pt-6 pb-4 z-20 border-t border-claude-border/30">
          <ChatInput
            onSend={handleSend}
            disabled={isStreaming}
            isStreaming={isStreaming}
            onCancel={cancelStream}
            selectedTool={selectedTool}
            onToolChange={setSelectedTool}
          />
        </div>
      </>);

  };
  const pageTitle = getPageTitle();
  return (
    <div className="flex h-screen bg-claude-bg overflow-hidden">
      {/* Sidebar */}
      <div className={`${isSidebarOpen ? 'block' : 'hidden'} lg:block h-full flex-shrink-0`}>
        <Sidebar
          isOpen={isSidebarOpen}
          onClose={() => setIsSidebarOpen(false)}
          onNewChat={handleNewChat}
          onProfileClick={() => {
            setCurrentView('profile');
            setIsSidebarOpen(false);
          }}
          onJudgesClick={() => {
            setCurrentView('judges');
            setIsSidebarOpen(false);
          }}
          onLawyersClick={() => {
            setCurrentView('lawyers');
            setIsSidebarOpen(false);
          }}
          onClientsClick={() => {
            setCurrentView('clients');
            setIsSidebarOpen(false);
          }}
          onCasesClick={() => {
            setCurrentView('cases');
            setIsSidebarOpen(false);
          }}
          onHistoryClick={() => {
            setCurrentView('history');
            setIsSidebarOpen(false);
          }}
          onDecisionsClick={() => {
            setCurrentView('decisions');
            setIsSidebarOpen(false);
          }}
          onBillingClick={() => {
            setCurrentView('billing');
            setIsSidebarOpen(false);
          }}
          onLegislationMonitoringClick={() => {
            setCurrentView('legislation-monitoring');
            setIsSidebarOpen(false);
          }}
          onCourtPracticeAnalysisClick={() => {
            setCurrentView('court-practice-analysis');
            setIsSidebarOpen(false);
          }}
          onLegalInitiativesClick={() => {
            setCurrentView('legal-initiatives');
            setIsSidebarOpen(false);
          }}
          onLegislationStatisticsClick={() => {
            setCurrentView('legislation-statistics');
            setIsSidebarOpen(false);
          }}
          onVotingAnalysisClick={() => {
            setCurrentView('voting-analysis');
            setIsSidebarOpen(false);
          }}
          onLegalCodesLibraryClick={() => {
            setCurrentView('legal-codes-library');
            setIsSidebarOpen(false);
          }}
          onHistoricalAnalysisClick={() => {
            setCurrentView('historical-analysis');
            setIsSidebarOpen(false);
          }}
          onLogout={handleLogout} />

      </div>

      <main className="flex-1 flex flex-col min-w-0 relative h-full">
        {/* Desktop Header */}
        <header className="hidden lg:flex items-center justify-between px-6 py-3 border-b border-claude-border bg-white/80 backdrop-blur-sm sticky top-0 z-30">
          {/* Left: Toggle button */}
          <div className="flex items-center gap-3 w-[200px]">
            <button
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-lg transition-all duration-200"
              title={isSidebarOpen ? 'Сховати меню' : 'Показати меню'}>

              {isSidebarOpen ?
              <X size={18} strokeWidth={2} /> :

              <Menu size={18} strokeWidth={2} />
              }
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
              onClick={() => setIsRightPanelOpen(!isRightPanelOpen)}
              className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-lg transition-all duration-200"
              title={isRightPanelOpen ? 'Сховати панель' : 'Показати панель'}>

              {isRightPanelOpen ?
              <X size={18} strokeWidth={2} /> :

              <PanelRightOpen size={18} strokeWidth={2} />
              }
            </button>
          </div>
        </header>

        {/* Mobile Header */}
        <header className="lg:hidden flex items-center justify-between px-4 py-2.5 border-b border-claude-border bg-white/80 backdrop-blur-md sticky top-0 z-30">
          <button
            onClick={() => setIsSidebarOpen(true)}
            className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-lg transition-all duration-200">

            <img
              src="/Image_1.jpg"
              alt="Menu"
              className="w-6 h-6 object-contain" />

          </button>
          <div className="flex items-center">
            {pageTitle ?
            <h1 className="text-base font-sans text-claude-text font-medium">
                {pageTitle}
              </h1> :

            <img
              src="/Image.jpg"
              alt="Lex"
              className="h-10 w-auto object-contain" />

            }
          </div>
          <button
            onClick={() => setIsRightPanelOpen(true)}
            className="p-2 text-claude-subtext hover:text-claude-text hover:bg-claude-subtext/8 rounded-lg transition-all duration-200">

            <PanelRightOpen size={20} strokeWidth={2} />
          </button>
        </header>

        <div className="flex-1 flex flex-col relative overflow-hidden">
          {renderContent()}
        </div>
      </main>

      {/* Right Panel */}
      <div className={`${isRightPanelOpen ? 'block' : 'hidden'}`}>
        <RightPanel
          isOpen={isRightPanelOpen}
          onClose={() => setIsRightPanelOpen(false)}
          decisions={allDecisions}
          citations={allCitations}
          documents={allDocuments}
        />
      </div>
    </div>);

}