import React, { useState } from 'react';
import { Sidebar } from './Sidebar';
import { RightPanel } from './RightPanel';
import { ChatInput } from './ChatInput';
import { MessageThread } from './MessageThread';
import { EmptyState } from './EmptyState';
import { MessageProps } from './Message';
import { ProfilePage } from './ProfilePage';
import { JudgesPage } from './JudgesPage';
import { LawyersPage } from './LawyersPage';
import { ClientsPage } from './ClientsPage';
import { CasesPage } from './CasesPage';
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
  PanelLeftOpen,
  FileText,
  Share2,
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
  name: string;
  company: string;
  email: string;
  phone: string;
  activeCases: number;
  status: 'active' | 'inactive';
  lastContact: string;
  type: 'individual' | 'corporate';
}
export function ChatLayout() {
  const { logout } = useAuth();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(true);
  const [messages, setMessages] = useState<MessageProps[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentView, setCurrentView] = useState<ViewState>('chat');
  const [selectedPerson, setSelectedPerson] = useState<SelectedPerson | null>(
    null
  );
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [messagingClientIds, setMessagingClientIds] = useState<string[]>([]);
  const handleSend = async (content: string) => {
    const API_URL = import.meta.env.VITE_API_URL || 'https://dev.legal.org.ua/api';
    const API_KEY = import.meta.env.VITE_API_KEY || 'c3462787ee0a9b45a1102cc195a65f8ce82c7609242aab5628d4a111c52727b4';

    const userMessage: MessageProps = {
      id: Date.now().toString(),
      role: 'user',
      content
    };
    setMessages((prev) => [...prev, userMessage]);
    setIsStreaming(true);

    try {
      const response = await fetch(`${API_URL}/tools/get_legal_advice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          query: content,
          max_precedents: 5
        })
      });

      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }

      const data = await response.json();

      // Parse the backend response structure
      let parsedResult: any = {};
      try {
        // Backend returns result in content[0].text as JSON string
        if (data.result?.content?.[0]?.text) {
          parsedResult = JSON.parse(data.result.content[0].text);
        }
      } catch (e) {
        console.warn('Failed to parse result content:', e);
      }

      // Extract answer from summary or fallback messages
      const answerText = parsedResult.summary ||
                        parsedResult.answer ||
                        data.result?.answer ||
                        data.answer ||
                        'Відповідь отримано від backend.';

      const aiMessage: MessageProps = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: answerText,
        isStreaming: false,
        thinkingSteps: parsedResult.reasoning_chain?.map((step: any, index: number) => ({
          id: `s${index + 1}`,
          title: `Крок ${step.step || index + 1}: ${step.action || 'Обробка'}`,
          content: step.output ? JSON.stringify(step.output, null, 2) : step.explanation || '',
          isComplete: true
        })) || [],
        decisions: parsedResult.precedent_chunks?.map((prec: any, index: number) => ({
          id: `d${index + 1}`,
          number: prec.case_number || prec.number || `Справа ${index + 1}`,
          court: prec.court || 'Невідомий суд',
          date: prec.date || '',
          summary: prec.summary || prec.reasoning || prec.content || '',
          relevance: Math.round((prec.similarity || prec.relevance || 0.5) * 100),
          status: 'active'
        })) || [],
        citations: parsedResult.source_attribution?.map((src: any, index: number) => ({
          text: src.text || src.content || '',
          source: src.citation || src.source || `Джерело ${index + 1}`
        })) || []
      };

      setMessages((prev) => [...prev, aiMessage]);
      setIsStreaming(false);
    } catch (error) {
      console.error('API Error:', error);
      const errorMessage: MessageProps = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Помилка при зверненні до API: ${error instanceof Error ? error.message : 'Невідома помилка'}. Будь ласка, спробуйте пізніше.`,
        isStreaming: false
      };
      setMessages((prev) => [...prev, errorMessage]);
      setIsStreaming(false);
    }
  };
  const handleNewChat = () => {
    setMessages([]);
    setIsStreaming(false);
    setCurrentView('chat');
    setSelectedPerson(null);
    setSelectedClient(null);
    setMessagingClientIds([]);
  };
  const handleLogout = () => {
    // Clear local state
    setMessages([]);
    setIsStreaming(false);
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
    if (selectedClient) return selectedClient.name;
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
            }}
            onSendMessage={(clientIds) => {
              setMessagingClientIds(clientIds);
              setCurrentView('client-messaging');
            }} />

        </div>);

    }
    if (currentView === 'cases') {
      return (
        <div className="flex-1 overflow-hidden relative">
          <button
            onClick={() => setCurrentView('chat')}
            className="absolute top-4 right-4 z-10 p-2 bg-white rounded-full shadow-sm border border-claude-border text-claude-subtext hover:text-claude-text transition-colors">

            <X size={20} />
          </button>
          <CasesPage />
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
          client={selectedClient}
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

        <MessageThread messages={messages} />
        }
        <div className="w-full bg-gradient-to-t from-white via-white to-transparent pt-6 pb-4 z-20 border-t border-claude-border/30">
          <ChatInput onSend={handleSend} disabled={isStreaming} />
        </div>
      </>);

  };
  const pageTitle = getPageTitle();
  return (
    <div className="flex h-screen bg-claude-bg overflow-hidden">
      {/* Sidebar */}
      <div className={`${isSidebarOpen ? 'block' : 'hidden'} h-full`}>
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
          onClose={() => setIsRightPanelOpen(false)} />

      </div>
    </div>);

}