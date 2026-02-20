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
import { HistoryPage } from '../components/HistoryPage';
import { DecisionsSearchPage } from '../components/DecisionsSearchPage';
import { PersonDetailPage } from '../pages/PersonDetailPage';
import { ClientDetailPage } from '../pages/ClientDetailPage';
import { ClientMessagingPage } from '../pages/ClientMessagingPage';
import { MattersPage } from '../pages/MattersPage';
import { MatterDetailPage } from '../pages/MatterDetailPage';
import { CaseAnalysisPage } from '../components/CaseAnalysisPage';
import { LegislationMonitoringPage } from '../components/LegislationMonitoringPage';
import { CourtPracticeAnalysisPage } from '../components/CourtPracticeAnalysisPage';
import { LegalInitiativesPage } from '../components/LegalInitiativesPage';
import { LegislationStatisticsPage } from '../components/LegislationStatisticsPage';
import { VotingAnalysisPage } from '../components/VotingAnalysisPage';
import { LegalCodesLibraryPage } from '../components/LegalCodesLibraryPage';
import { HistoricalAnalysisPage } from '../components/HistoricalAnalysisPage';
import { AdminMonitoringPage } from '../pages/AdminMonitoringPage';
import { AdminOverviewPage } from '../pages/AdminOverviewPage';
import { AdminUsersPage } from '../pages/AdminUsersPage';
import { AdminCostsPage } from '../pages/AdminCostsPage';
import { AdminDataSourcesPage } from '../pages/AdminDataSourcesPage';
import { AdminBillingPage } from '../pages/AdminBillingPage';
import { AdminInfrastructurePage } from '../pages/AdminInfrastructurePage';
import { AdminContainersPage } from '../pages/AdminContainersPage';
import { AdminConfigPage } from '../pages/AdminConfigPage';
import { AdminDBComparePage } from '../pages/AdminDBComparePage';
import { AdminServicePricingPage } from '../pages/AdminServicePricingPage';
import { AdminTerminalPage } from '../pages/AdminTerminalPage';
import { DocumentsPage } from '../pages/DocumentsPage';
import { TimeEntriesPage } from '../pages/TimeEntriesPage';
import { InvoicesPage } from '../pages/InvoicesPage';
import { PaymentSuccessPage } from '../pages/PaymentSuccessPage';
import { PaymentErrorPage } from '../pages/PaymentErrorPage';
import { OfferPage } from '../pages/OfferPage';
import { USDataSourcesPage } from '../pages/USDataSourcesPage';
import { UKDataSourcesPage } from '../pages/UKDataSourcesPage';
import { DEDataSourcesPage } from '../pages/DEDataSourcesPage';
import { FRDataSourcesPage } from '../pages/FRDataSourcesPage';
import { NLDataSourcesPage } from '../pages/NLDataSourcesPage';
import { EEDataSourcesPage } from '../pages/EEDataSourcesPage';
import { UADataSourcesPage } from '../pages/UADataSourcesPage';
import { EUComparisonPage } from '../pages/EUComparisonPage';

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
    path: ROUTES.PAYMENT_SUCCESS,
    element: <PaymentSuccessPage />,
  },
  {
    path: ROUTES.PAYMENT_ERROR,
    element: <PaymentErrorPage />,
  },
  {
    path: ROUTES.OFFER,
    element: <OfferPage />,
  },
  {
    path: ROUTES.US_DATA_SOURCES,
    element: <USDataSourcesPage />,
  },
  {
    path: ROUTES.UK_DATA_SOURCES,
    element: <UKDataSourcesPage />,
  },
  {
    path: ROUTES.DE_DATA_SOURCES,
    element: <DEDataSourcesPage />,
  },
  {
    path: ROUTES.FR_DATA_SOURCES,
    element: <FRDataSourcesPage />,
  },
  {
    path: ROUTES.NL_DATA_SOURCES,
    element: <NLDataSourcesPage />,
  },
  {
    path: ROUTES.EE_DATA_SOURCES,
    element: <EEDataSourcesPage />,
  },
  {
    path: ROUTES.UA_DATA_SOURCES,
    element: <UADataSourcesPage />,
  },
  {
    path: ROUTES.EU_COMPARISON,
    element: <EUComparisonPage />,
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
            path: ROUTES.MATTERS,
            element: <MattersPage />,
          },
          {
            path: ROUTES.MATTER_DETAIL,
            element: <MatterDetailPage />,
          },
          {
            path: ROUTES.TIME_ENTRIES,
            element: <TimeEntriesPage />,
          },
          {
            path: ROUTES.INVOICES,
            element: <InvoicesPage />,
          },
          {
            path: ROUTES.DOCUMENTS,
            element: <DocumentsPage />,
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
          {
            path: ROUTES.ADMIN_OVERVIEW,
            element: <AdminOverviewPage />,
          },
          {
            path: ROUTES.ADMIN_MONITORING,
            element: <AdminMonitoringPage />,
          },
          {
            path: ROUTES.ADMIN_USERS,
            element: <AdminUsersPage />,
          },
          {
            path: ROUTES.ADMIN_COSTS,
            element: <AdminCostsPage />,
          },
          {
            path: ROUTES.ADMIN_DATA_SOURCES,
            element: <AdminDataSourcesPage />,
          },
          {
            path: ROUTES.ADMIN_BILLING,
            element: <AdminBillingPage />,
          },
          {
            path: ROUTES.ADMIN_INFRASTRUCTURE,
            element: <AdminInfrastructurePage />,
          },
          {
            path: ROUTES.ADMIN_CONTAINERS,
            element: <AdminContainersPage />,
          },
          {
            path: ROUTES.ADMIN_CONFIG,
            element: <AdminConfigPage />,
          },
          {
            path: ROUTES.ADMIN_DB_COMPARE,
            element: <AdminDBComparePage />,
          },
          {
            path: ROUTES.ADMIN_SERVICE_PRICING,
            element: <AdminServicePricingPage />,
          },
          {
            path: ROUTES.ADMIN_TERMINAL,
            element: <AdminTerminalPage />,
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
