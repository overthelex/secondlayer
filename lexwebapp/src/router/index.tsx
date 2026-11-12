/**
 * Router Configuration
 * Defines all application routes and their structure
 * Uses React.lazy() for code splitting — each page loads on demand
 */

import { Suspense, lazy } from 'react';
import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import { ROUTES } from './routes';
import { AuthGuard } from './guards/AuthGuard';
import { useCanonical } from '../hooks/useCanonical';

// Layouts
import { MainLayout } from '../layouts/MainLayout';

// Auth — static import (first page users see)
import { LoginPage } from '../pages/LoginPage';

// Retry dynamic imports — handles stale chunks after deploys
function lazyWithRetry(factory: () => Promise<any>) {
  return lazy(() =>
    factory().catch(() => {
      // Chunk not found (stale hash after deploy) — reload once per page path
      const key = `chunk-reload:${window.location.pathname}`;
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1');
        window.location.reload();
        return new Promise(() => {}); // never resolves — page is reloading
      }
      sessionStorage.removeItem(key);
      return factory(); // second attempt after reload — let it fail naturally
    })
  );
}

// Loading spinner for lazy-loaded pages
const PageLoader = () => (
  <div className="min-h-screen flex items-center justify-center bg-claude-bg">
    <div className="w-10 h-10 border-4 border-claude-accent border-t-transparent rounded-full animate-spin" />
  </div>
);

// Helper to wrap lazy component in Suspense
const S = (Component: React.LazyExoticComponent<React.ComponentType<any>>, props?: Record<string, any>) => (
  <Suspense fallback={<PageLoader />}>
    <Component {...props} />
  </Suspense>
);

// -- Public pages --
const VerifyEmailPage = lazyWithRetry(() => import('../pages/VerifyEmailPage').then(m => ({ default: m.VerifyEmailPage })));
const ResetPasswordPage = lazyWithRetry(() => import('../pages/ResetPasswordPage').then(m => ({ default: m.ResetPasswordPage })));
const PaymentSuccessPage = lazyWithRetry(() => import('../pages/PaymentSuccessPage').then(m => ({ default: m.PaymentSuccessPage })));
const PaymentErrorPage = lazyWithRetry(() => import('../pages/PaymentErrorPage').then(m => ({ default: m.PaymentErrorPage })));
const OfferPage = lazyWithRetry(() => import('../pages/OfferPage').then(m => ({ default: m.OfferPage })));
const AttorneyOfferPage = lazyWithRetry(() => import('../pages/AttorneyOfferPage').then(m => ({ default: m.AttorneyOfferPage })));
const DeveloperOfferPage = lazyWithRetry(() => import('../pages/DeveloperOfferPage').then(m => ({ default: m.DeveloperOfferPage })));
const MarketplaceRulesPage = lazyWithRetry(() => import('../pages/MarketplaceRulesPage').then(m => ({ default: m.MarketplaceRulesPage })));
const TermsPage = lazyWithRetry(() => import('../pages/TermsPage').then(m => ({ default: m.TermsPage })));
const PrivacyPolicyPage = lazyWithRetry(() => import('../pages/PrivacyPolicyPage').then(m => ({ default: m.PrivacyPolicyPage })));
const DpaPage = lazyWithRetry(() => import('../pages/DpaPage').then(m => ({ default: m.DpaPage })));
const AiUsagePolicyPage = lazyWithRetry(() => import('../pages/AiUsagePolicyPage').then(m => ({ default: m.AiUsagePolicyPage })));
const AiTransparencyPage = lazyWithRetry(() => import('../pages/AiTransparencyPage').then(m => ({ default: m.AiTransparencyPage })));
const RefundPolicyPage = lazyWithRetry(() => import('../pages/RefundPolicyPage').then(m => ({ default: m.RefundPolicyPage })));
const AupPage = lazyWithRetry(() => import('../pages/AupPage').then(m => ({ default: m.AupPage })));
const ApiTermsPage = lazyWithRetry(() => import('../pages/ApiTermsPage').then(m => ({ default: m.ApiTermsPage })));
const AbuseReportPage = lazyWithRetry(() => import('../pages/AbuseReportPage').then(m => ({ default: m.AbuseReportPage })));
const BlogPage = lazyWithRetry(() => import('../pages/BlogPage').then(m => ({ default: m.BlogPage })));
const BlogArticlePage = lazyWithRetry(() => import('../pages/BlogPage/BlogArticlePage').then(m => ({ default: m.BlogArticlePage })));
const InvestorLetterPage = lazyWithRetry(() => import('../pages/InvestorLetterPage').then(m => ({ default: m.InvestorLetterPage })));
const CareerPage = lazyWithRetry(() => import('../pages/CareerPage').then(m => ({ default: m.CareerPage })));
const CISOAcademyPage = lazyWithRetry(() => import('../pages/CISOAcademyPage/index').then(m => ({ default: m.CISOAcademyPage })));
const AboutPage = lazyWithRetry(() => import('../pages/AboutPage').then(m => ({ default: m.AboutPage })));
const AboutTeamPage = lazyWithRetry(() => import('../pages/AboutPage').then(m => ({ default: m.AboutTeamPage })));
const ProductPage = lazyWithRetry(() => import('../pages/ProductPage').then(m => ({ default: m.ProductPage })));
const UKInvestorPage = lazyWithRetry(() => import('../pages/UKInvestorPage').then(m => ({ default: m.UKInvestorPage })));
const InvestorDeckPage = lazyWithRetry(() => import('../pages/InvestorDeckPage').then(m => ({ default: m.InvestorDeckPage })));

// -- Data Sources (hub + country pages) --
const DataSourcesPage = lazyWithRetry(() => import('../pages/DataSourcesPage').then(m => ({ default: m.DataSourcesPage })));
const USDataSourcesPage = lazyWithRetry(() => import('../pages/USDataSourcesPage').then(m => ({ default: m.USDataSourcesPage })));
const UKDataSourcesPage = lazyWithRetry(() => import('../pages/UKDataSourcesPage').then(m => ({ default: m.UKDataSourcesPage })));
const DEDataSourcesPage = lazyWithRetry(() => import('../pages/DEDataSourcesPage').then(m => ({ default: m.DEDataSourcesPage })));
const FRDataSourcesPage = lazyWithRetry(() => import('../pages/FRDataSourcesPage').then(m => ({ default: m.FRDataSourcesPage })));
const NLDataSourcesPage = lazyWithRetry(() => import('../pages/NLDataSourcesPage').then(m => ({ default: m.NLDataSourcesPage })));
const EEDataSourcesPage = lazyWithRetry(() => import('../pages/EEDataSourcesPage').then(m => ({ default: m.EEDataSourcesPage })));
const UADataSourcesPage = lazyWithRetry(() => import('../pages/UADataSourcesPage').then(m => ({ default: m.UADataSourcesPage })));
const EUComparisonPage = lazyWithRetry(() => import('../pages/EUComparisonPage').then(m => ({ default: m.EUComparisonPage })));

// -- Core app pages --
const ChatPage = lazyWithRetry(() => import('../pages/ChatPage').then(m => ({ default: m.ChatPage })));
const SharedConversationPage = lazyWithRetry(() => import('../pages/SharedConversationPage').then(m => ({ default: m.SharedConversationPage })));
const ProfilePage = lazyWithRetry(() => import('../pages/ProfilePage').then(m => ({ default: m.ProfilePage })));
const BillingDashboard = lazyWithRetry(() => import('../pages/BillingDashboard').then(m => ({ default: m.BillingDashboard })));
const BillingOverviewTab = lazyWithRetry(() => import('../components/billing/OverviewTab').then(m => ({ default: m.OverviewTab })));
const BillingTariffsTab = lazyWithRetry(() => import('../components/billing/TariffsTab').then(m => ({ default: m.TariffsTab })));
const BillingHistoryTab = lazyWithRetry(() => import('../components/billing/HistoryTab').then(m => ({ default: m.HistoryTab })));
const BillingAnalyticsTab = lazyWithRetry(() => import('../components/billing/AnalyticsTab').then(m => ({ default: m.AnalyticsTab })));
const BillingSettingsTab = lazyWithRetry(() => import('../components/billing/SettingsTab').then(m => ({ default: m.SettingsTab })));
const B2BInvoicesTab = lazyWithRetry(() => import('../components/billing/B2BInvoicesTab').then(m => ({ default: m.B2BInvoicesTab })));
const TeamPage = lazyWithRetry(() => import('../pages/TeamPage').then(m => ({ default: m.TeamPage })));
const DocumentsPage = lazyWithRetry(() => import('../pages/DocumentsPage').then(m => ({ default: m.DocumentsPage })));
const HistoryPage = lazyWithRetry(() => import('../pages/HistoryPage').then(m => ({ default: m.HistoryPage })));

// -- Legal entities --
const JudgesPage = lazyWithRetry(() => import('../pages/JudgesPage').then(m => ({ default: m.JudgesPage })));
const LawyersPage = lazyWithRetry(() => import('../pages/LawyersPage').then(m => ({ default: m.LawyersPage })));
const ClientsPage = lazyWithRetry(() => import('../pages/ClientsPage').then(m => ({ default: m.ClientsPage })));
const PersonDetailPage = lazyWithRetry(() => import('../pages/PersonDetailPage').then(m => ({ default: m.PersonDetailPage })));
const ClientDetailPage = lazyWithRetry(() => import('../pages/ClientDetailPage').then(m => ({ default: m.ClientDetailPage })));
const ClientMessagingPage = lazyWithRetry(() => import('../pages/ClientMessagingPage').then(m => ({ default: m.ClientMessagingPage })));

// -- Matters & Time --
const MattersPage = lazyWithRetry(() => import('../pages/MattersPage').then(m => ({ default: m.MattersPage })));
const MatterDetailPage = lazyWithRetry(() => import('../pages/MatterDetailPage').then(m => ({ default: m.MatterDetailPage })));
const TimeEntriesPage = lazyWithRetry(() => import('../pages/TimeEntriesPage').then(m => ({ default: m.TimeEntriesPage })));
const InvoicesPage = lazyWithRetry(() => import('../pages/InvoicesPage').then(m => ({ default: m.InvoicesPage })));

// -- Legal analysis --
const CaseAnalysisPage = lazyWithRetry(() => import('../pages/CaseAnalysisPage').then(m => ({ default: m.CaseAnalysisPage })));
const DecisionsSearchPage = lazyWithRetry(() => import('../pages/DecisionsSearchPage').then(m => ({ default: m.DecisionsSearchPage })));
const LegislationMonitoringPage = lazyWithRetry(() => import('../pages/LegislationMonitoringPage').then(m => ({ default: m.LegislationMonitoringPage })));
const CourtPracticeAnalysisPage = lazyWithRetry(() => import('../pages/CourtPracticeAnalysisPage').then(m => ({ default: m.CourtPracticeAnalysisPage })));
const LegalCodesLibraryPage = lazyWithRetry(() => import('../pages/LegalCodesLibraryPage').then(m => ({ default: m.LegalCodesLibraryPage })));

// -- News --
const NewsPage = lazyWithRetry(() => import('../pages/NewsPage').then(m => ({ default: m.NewsPage })));

// -- MCP Connect --
const MCPConnectPage = lazyWithRetry(() => import('../pages/MCPConnectPage').then(m => ({ default: m.MCPConnectPage })));
const ContractsPage = lazyWithRetry(() => import('../pages/ContractsPage').then(m => ({ default: m.ContractsPage })));
const DeveloperDocsPage = lazyWithRetry(() => import('../pages/DeveloperDocsPage').then(m => ({ default: m.DeveloperDocsPage })));

// -- Attorney/Consultations (client-facing) --
const AttorneySearchPage = lazyWithRetry(() => import('../pages/AttorneySearchPage').then(m => ({ default: m.AttorneySearchPage })));
const AttorneyDetailPage = lazyWithRetry(() => import('../pages/AttorneyDetailPage').then(m => ({ default: m.AttorneyDetailPage })));
const AttorneyProfilePage = lazyWithRetry(() => import('../pages/AttorneyProfilePage').then(m => ({ default: m.AttorneyProfilePage })));
const AttorneyClientsPage = lazyWithRetry(() => import('../pages/AttorneyClientsPage').then(m => ({ default: m.AttorneyClientsPage })));
const ConsultationsPage = lazyWithRetry(() => import('../pages/ConsultationsPage').then(m => ({ default: m.ConsultationsPage })));
const ConsultationDetailPage = lazyWithRetry(() => import('../pages/ConsultationDetailPage').then(m => ({ default: m.ConsultationDetailPage })));

// -- Referral --
const ReferralLanding = lazyWithRetry(() => import('../pages/ReferralLanding').then(m => ({ default: m.ReferralLanding })));
const ReferralPage = lazyWithRetry(() => import('../pages/ReferralPage').then(m => ({ default: m.ReferralPage })));

// -- Workflows --
const WorkflowsPage = lazyWithRetry(() => import('../pages/WorkflowsPage').then(m => ({ default: m.WorkflowsPage })));
const WorkflowSetDetailPage = lazyWithRetry(() => import('../pages/WorkflowSetDetailPage').then(m => ({ default: m.WorkflowSetDetailPage })));

// -- Admin --
const AdminOverviewPage = lazyWithRetry(() => import('../pages/AdminOverviewPage').then(m => ({ default: m.AdminOverviewPage })));
const AdminMonitoringPage = lazyWithRetry(() => import('../pages/AdminMonitoringPage').then(m => ({ default: m.AdminMonitoringPage })));
const AdminUsersPage = lazyWithRetry(() => import('../pages/AdminUsersPage').then(m => ({ default: m.AdminUsersPage })));
const AdminCostsPage = lazyWithRetry(() => import('../pages/AdminCostsPage').then(m => ({ default: m.AdminCostsPage })));
const AdminBillingPage = lazyWithRetry(() => import('../pages/AdminBillingPage').then(m => ({ default: m.AdminBillingPage })));
const AdminInfrastructurePage = lazyWithRetry(() => import('../pages/AdminInfrastructurePage').then(m => ({ default: m.AdminInfrastructurePage })));
const AdminContainersPage = lazyWithRetry(() => import('../pages/AdminContainersPage').then(m => ({ default: m.AdminContainersPage })));
const AdminConfigPage = lazyWithRetry(() => import('../pages/AdminConfigPage').then(m => ({ default: m.AdminConfigPage })));
const AdminServicePricingPage = lazyWithRetry(() => import('../pages/AdminServicePricingPage').then(m => ({ default: m.AdminServicePricingPage })));
const AdminTerminalPage = lazyWithRetry(() => import('../pages/AdminTerminalPage').then(m => ({ default: m.AdminTerminalPage })));
const AdminZOStatsPage = lazyWithRetry(() => import('../pages/AdminZOStatsPage').then(m => ({ default: m.AdminZOStatsPage })));
const AdminUserActivityPage = lazyWithRetry(() => import('../pages/AdminUserActivityPage').then(m => ({ default: m.AdminUserActivityPage })));
const AdminBulkScrapePage = lazyWithRetry(() => import('../pages/AdminBulkScrapePage').then(m => ({ default: m.AdminBulkScrapePage })));
const AdminLimitsPage = lazyWithRetry(() => import('../pages/AdminLimitsPage').then(m => ({ default: m.AdminLimitsPage })));
const AdminSessionReplayPage = lazyWithRetry(() => import('../pages/AdminSessionReplayPage').then(m => ({ default: m.AdminSessionReplayPage })));

// Root layout that applies global route-level effects (canonical URL, og:url)
function RootLayout() {
  useCanonical();
  return <Outlet />;
}

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
  {
    path: ROUTES.LOGIN,
    element: <LoginPage />,
  },
  {
    path: '/verify-email',
    element: S(VerifyEmailPage),
  },
  {
    path: '/reset-password',
    element: S(ResetPasswordPage),
  },
  {
    path: ROUTES.PAYMENT_SUCCESS,
    element: S(PaymentSuccessPage),
  },
  {
    path: ROUTES.PAYMENT_ERROR,
    element: S(PaymentErrorPage),
  },
  {
    path: ROUTES.OFFER,
    element: S(OfferPage),
  },
  {
    path: ROUTES.ATTORNEY_OFFER,
    element: S(AttorneyOfferPage),
  },
  {
    path: ROUTES.DEVELOPER_OFFER,
    element: S(DeveloperOfferPage),
  },
  {
    path: ROUTES.MARKETPLACE_RULES,
    element: S(MarketplaceRulesPage),
  },
  {
    path: ROUTES.OFERTA,
    element: <Navigate to="/ua/offer" replace />,
  },
  {
    path: ROUTES.TERMS,
    element: S(TermsPage),
  },
  {
    path: ROUTES.PRIVACY,
    element: S(PrivacyPolicyPage),
  },
  {
    path: ROUTES.DPA,
    element: S(DpaPage),
  },
  {
    path: ROUTES.AI_USAGE,
    element: S(AiUsagePolicyPage),
  },
  {
    path: ROUTES.AI_TRANSPARENCY,
    element: S(AiTransparencyPage),
  },
  {
    path: ROUTES.REFUND_POLICY,
    element: S(RefundPolicyPage),
  },
  {
    path: ROUTES.AUP,
    element: S(AupPage),
  },
  {
    path: ROUTES.API_TERMS,
    element: S(ApiTermsPage),
  },
  {
    path: ROUTES.DATA_SOURCES,
    element: S(DataSourcesPage),
  },
  {
    path: ROUTES.US_DATA_SOURCES,
    element: S(USDataSourcesPage),
  },
  {
    path: ROUTES.UK_DATA_SOURCES,
    element: S(UKDataSourcesPage),
  },
  {
    path: ROUTES.DE_DATA_SOURCES,
    element: S(DEDataSourcesPage),
  },
  {
    path: ROUTES.FR_DATA_SOURCES,
    element: S(FRDataSourcesPage),
  },
  {
    path: ROUTES.NL_DATA_SOURCES,
    element: S(NLDataSourcesPage),
  },
  {
    path: ROUTES.EE_DATA_SOURCES,
    element: S(EEDataSourcesPage),
  },
  {
    path: ROUTES.UA_DATA_SOURCES,
    element: S(UADataSourcesPage),
  },
  {
    path: ROUTES.EU_COMPARISON,
    element: S(EUComparisonPage),
  },
  {
    path: ROUTES.ABUSE_REPORT,
    element: S(AbuseReportPage),
  },
  {
    path: ROUTES.BLOG_ARTICLE_LANG,
    element: S(BlogArticlePage),
  },
  {
    path: ROUTES.BLOG_ARTICLE,
    element: S(BlogArticlePage),
  },
  {
    path: ROUTES.BLOG,
    element: S(BlogPage),
  },
  {
    path: ROUTES.CAREER,
    element: S(CareerPage),
  },
  {
    path: ROUTES.CISO_ACADEMY,
    element: S(CISOAcademyPage),
  },
  {
    path: ROUTES.ABOUT,
    element: S(AboutPage),
  },
  {
    path: ROUTES.ABOUT_TEAM,
    element: S(AboutTeamPage),
  },
  {
    path: ROUTES.PRODUCT,
    element: S(ProductPage),
  },
  {
    path: ROUTES.INVESTOR_LETTER,
    element: S(InvestorLetterPage),
  },
  {
    path: ROUTES.UK_INVESTOR,
    element: S(UKInvestorPage),
  },
  {
    path: ROUTES.UK_INVESTOR_SIMPLIFIED,
    element: S(InvestorDeckPage),
  },
  {
    path: ROUTES.REFERRAL_LANDING,
    element: S(ReferralLanding),
  },
  {
    path: ROUTES.DEVELOPER_DOCS,
    element: S(DeveloperDocsPage),
  },
  {
    element: <AuthGuard />,
    children: [
      {
        path: ROUTES.SHARED,
        element: S(SharedConversationPage),
      },
      {
        element: <MainLayout />,
        children: [
          {
            path: ROUTES.HOME,
            element: <Navigate to={ROUTES.CHAT} replace />,
          },
          {
            path: ROUTES.CHAT,
            element: S(ChatPage),
          },
          {
            path: ROUTES.PROFILE,
            element: S(ProfilePage),
          },
          {
            path: ROUTES.USAGE,
            element: <Navigate to={ROUTES.BILLING_ANALYTICS} replace />,
          },
          {
            path: ROUTES.BILLING,
            element: S(BillingDashboard),
            children: [
              {
                index: true,
                element: <Navigate to="overview" replace />,
              },
              {
                path: 'overview',
                element: S(BillingOverviewTab),
              },
              {
                path: 'tariffs',
                element: S(BillingTariffsTab),
              },
              {
                path: 'history',
                element: S(BillingHistoryTab),
              },
              {
                path: 'analytics',
                element: S(BillingAnalyticsTab),
              },
              {
                path: 'b2b-invoices',
                element: S(B2BInvoicesTab),
              },
              {
                path: 'settings',
                element: S(BillingSettingsTab),
              },
            ],
          },
          {
            path: ROUTES.TEAM,
            element: S(TeamPage),
          },
          {
            path: ROUTES.MCP_CONNECT,
            element: S(MCPConnectPage),
          },
          {
            path: ROUTES.MY_CONTRACTS,
            element: S(ContractsPage),
          },
          {
            path: ROUTES.REFERRAL,
            element: S(ReferralPage),
          },
          {
            path: ROUTES.JUDGES,
            element: S(JudgesPage),
          },
          {
            path: ROUTES.JUDGE_DETAIL,
            element: S(PersonDetailPage, { type: 'judge' }),
          },
          {
            path: ROUTES.LAWYERS,
            element: S(LawyersPage),
          },
          {
            path: ROUTES.LAWYER_DETAIL,
            element: S(PersonDetailPage, { type: 'lawyer' }),
          },
          {
            path: ROUTES.CLIENTS,
            element: S(ClientsPage),
          },
          {
            path: ROUTES.CLIENT_DETAIL,
            element: S(ClientDetailPage),
          },
          {
            path: ROUTES.CLIENT_MESSAGING,
            element: S(ClientMessagingPage),
          },
          {
            path: ROUTES.MATTERS,
            element: S(MattersPage),
          },
          {
            path: ROUTES.MATTER_DETAIL,
            element: S(MatterDetailPage),
          },
          {
            path: ROUTES.TIME_ENTRIES,
            element: S(TimeEntriesPage),
          },
          {
            path: ROUTES.INVOICES,
            element: S(InvoicesPage),
          },
          {
            path: ROUTES.DOCUMENTS,
            element: S(DocumentsPage),
          },
          {
            path: ROUTES.DOCUMENTS_FOLDER,
            element: S(DocumentsPage),
          },
          {
            path: ROUTES.CASE_ANALYSIS,
            element: S(CaseAnalysisPage),
          },
          {
            path: ROUTES.DECISIONS_SEARCH,
            element: S(DecisionsSearchPage),
          },
          {
            path: ROUTES.NEWS,
            element: S(NewsPage),
          },
          {
            path: ROUTES.HISTORY,
            element: S(HistoryPage),
          },
          {
            path: ROUTES.LEGISLATION_MONITORING,
            element: S(LegislationMonitoringPage),
          },
          {
            path: ROUTES.LEGAL_CODES_LIBRARY,
            element: S(LegalCodesLibraryPage),
          },
          {
            path: ROUTES.COURT_PRACTICE_ANALYSIS,
            element: S(CourtPracticeAnalysisPage),
          },
          {
            path: ROUTES.ATTORNEYS,
            element: S(AttorneySearchPage),
          },
          {
            path: ROUTES.ATTORNEY_DETAIL,
            element: S(AttorneyDetailPage),
          },
          {
            path: ROUTES.ATTORNEY_PROFILE_EDIT,
            element: S(AttorneyProfilePage),
          },
          {
            path: ROUTES.ATTORNEY_CLIENTS,
            element: S(AttorneyClientsPage),
          },
          {
            path: ROUTES.CONSULTATIONS,
            element: S(ConsultationsPage),
          },
          {
            path: ROUTES.CONSULTATIONS_PAYOUTS,
            element: S(ConsultationsPage),
          },
          {
            path: ROUTES.CONSULTATION_DETAIL,
            element: S(ConsultationDetailPage),
          },
          {
            path: ROUTES.WORKFLOWS,
            element: S(WorkflowsPage),
          },
          {
            path: ROUTES.WORKFLOW_SET_DETAIL,
            element: S(WorkflowSetDetailPage),
          },
          {
            path: ROUTES.ADMIN_OVERVIEW,
            element: S(AdminOverviewPage),
          },
          {
            path: ROUTES.ADMIN_MONITORING,
            element: S(AdminMonitoringPage),
          },
          {
            path: ROUTES.ADMIN_USERS,
            element: S(AdminUsersPage),
          },
          {
            path: ROUTES.ADMIN_COSTS,
            element: S(AdminCostsPage),
          },
          {
            path: ROUTES.ADMIN_BILLING,
            element: S(AdminBillingPage),
          },
          {
            path: ROUTES.ADMIN_INFRASTRUCTURE,
            element: S(AdminInfrastructurePage),
          },
          {
            path: ROUTES.ADMIN_CONTAINERS,
            element: S(AdminContainersPage),
          },
          {
            path: ROUTES.ADMIN_CONFIG,
            element: S(AdminConfigPage),
          },
          {
            path: ROUTES.ADMIN_SERVICE_PRICING,
            element: S(AdminServicePricingPage),
          },
          {
            path: ROUTES.ADMIN_TERMINAL,
            element: S(AdminTerminalPage),
          },
          {
            path: ROUTES.ADMIN_ZO_STATS,
            element: S(AdminZOStatsPage),
          },
          {
            path: ROUTES.ADMIN_USER_ACTIVITY,
            element: S(AdminUserActivityPage),
          },
          {
            path: ROUTES.ADMIN_BULK_SCRAPE,
            element: S(AdminBulkScrapePage),
          },
          {
            path: ROUTES.ADMIN_LIMITS,
            element: S(AdminLimitsPage),
          },
          {
            path: ROUTES.ADMIN_SESSION_REPLAY,
            element: S(AdminSessionReplayPage),
          },
        ],
      },
    ],
  },
  {
    path: '*',
    element: <Navigate to={ROUTES.CHAT} replace />,
  },
    ],
  },
]);
