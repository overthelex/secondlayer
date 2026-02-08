/**
 * Router Configuration
 * Defines all application routes and their structure
 */

import React from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { ROUTES } from './routes';
import { AuthGuard } from './guards/AuthGuard';

// Layouts
import { MainLayout } from '../layouts/MainLayout';

// Pages
import { LoginPage } from '../components/LoginPage';
import { VerifyEmailPage } from '../components/VerifyEmailPage';
import { ResetPasswordPage } from '../components/ResetPasswordPage';
import { ChatPage } from '../pages/ChatPage';
import { ProfilePage } from '../components/ProfilePage';
import { BillingDashboard } from '../components/BillingDashboard';
import { TeamPage } from '../components/team/TeamPage';
import { JudgesPage } from '../pages/JudgesPage';
import { LawyersPage } from '../pages/LawyersPage';
import { ClientsPage } from '../pages/ClientsPage';
import { CasesPage } from '../components/CasesPage';
import { HistoryPage } from '../components/HistoryPage';
import { DecisionsSearchPage } from '../components/DecisionsSearchPage';
import { PersonDetailPage } from '../pages/PersonDetailPage';
import { ClientDetailPage } from '../pages/ClientDetailPage';
import { ClientMessagingPage } from '../pages/ClientMessagingPage';
import { CaseAnalysisPage } from '../components/CaseAnalysisPage';
import { LegislationMonitoringPage } from '../components/LegislationMonitoringPage';
import { CourtPracticeAnalysisPage } from '../components/CourtPracticeAnalysisPage';
import { LegalInitiativesPage } from '../components/LegalInitiativesPage';
import { LegislationStatisticsPage } from '../components/LegislationStatisticsPage';
import { VotingAnalysisPage } from '../components/VotingAnalysisPage';
import { LegalCodesLibraryPage } from '../components/LegalCodesLibraryPage';
import { HistoricalAnalysisPage } from '../components/HistoricalAnalysisPage';

export const router = createBrowserRouter([
  {
    path: ROUTES.LOGIN,
    element: <LoginPage />,
  },
  {
    path: '/verify-email',
    element: <VerifyEmailPage />,
  },
  {
    path: '/reset-password',
    element: <ResetPasswordPage />,
  },
  {
    element: <AuthGuard />,
    children: [
      {
        element: <MainLayout />,
        children: [
          {
            path: ROUTES.HOME,
            element: <Navigate to={ROUTES.CHAT} replace />,
          },
          {
            path: ROUTES.CHAT,
            element: <ChatPage />,
          },
          {
            path: ROUTES.PROFILE,
            element: <ProfilePage />,
          },
          {
            path: ROUTES.BILLING,
            element: <BillingDashboard />,
          },
          {
            path: ROUTES.TEAM,
            element: <TeamPage />,
          },
          {
            path: ROUTES.JUDGES,
            element: <JudgesPage />,
          },
          {
            path: ROUTES.JUDGE_DETAIL,
            element: <PersonDetailPage type="judge" />,
          },
          {
            path: ROUTES.LAWYERS,
            element: <LawyersPage />,
          },
          {
            path: ROUTES.LAWYER_DETAIL,
            element: <PersonDetailPage type="lawyer" />,
          },
          {
            path: ROUTES.CLIENTS,
            element: <ClientsPage />,
          },
          {
            path: ROUTES.CLIENT_DETAIL,
            element: <ClientDetailPage />,
          },
          {
            path: ROUTES.CLIENT_MESSAGING,
            element: <ClientMessagingPage />,
          },
          {
            path: ROUTES.CASES,
            element: <CasesPage />,
          },
          {
            path: ROUTES.CASE_ANALYSIS,
            element: <CaseAnalysisPage />,
          },
          {
            path: ROUTES.DECISIONS_SEARCH,
            element: <DecisionsSearchPage />,
          },
          {
            path: ROUTES.HISTORY,
            element: <HistoryPage />,
          },
          {
            path: ROUTES.LEGISLATION_MONITORING,
            element: <LegislationMonitoringPage />,
          },
          {
            path: ROUTES.LEGISLATION_STATISTICS,
            element: <LegislationStatisticsPage />,
          },
          {
            path: ROUTES.LEGAL_INITIATIVES,
            element: <LegalInitiativesPage />,
          },
          {
            path: ROUTES.LEGAL_CODES_LIBRARY,
            element: <LegalCodesLibraryPage />,
          },
          {
            path: ROUTES.VOTING_ANALYSIS,
            element: <VotingAnalysisPage />,
          },
          {
            path: ROUTES.HISTORICAL_ANALYSIS,
            element: <HistoricalAnalysisPage />,
          },
          {
            path: ROUTES.COURT_PRACTICE_ANALYSIS,
            element: <CourtPracticeAnalysisPage />,
          },
        ],
      },
    ],
  },
  {
    path: '*',
    element: <Navigate to={ROUTES.CHAT} replace />,
  },
]);
