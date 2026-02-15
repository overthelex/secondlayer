/**
 * Application Routes
 * Centralized route path constants
 */

export const ROUTES = {
  // Auth
  LOGIN: '/login',

  // Main
  HOME: '/',
  CHAT: '/chat',

  // Profile & Settings
  PROFILE: '/profile',
  BILLING: '/billing',
  TEAM: '/team',

  // Legal Entities
  JUDGES: '/judges',
  JUDGE_DETAIL: '/judges/:id',
  LAWYERS: '/lawyers',
  LAWYER_DETAIL: '/lawyers/:id',
  CLIENTS: '/clients',
  CLIENT_DETAIL: '/clients/:id',
  CLIENT_MESSAGING: '/clients/messaging',

  // Matters
  MATTERS: '/matters',
  MATTER_DETAIL: '/matters/:id',

  // Time Tracking & Billing
  TIME_ENTRIES: '/time-entries',
  INVOICES: '/invoices',
  CALENDAR: '/calendar',

  // Documents
  DOCUMENTS: '/documents',

  // Cases & Decisions
  CASE_ANALYSIS: '/case-analysis',
  DECISIONS_SEARCH: '/decisions',

  // Payment Results (Fondy redirects)
  PAYMENT_SUCCESS: '/payment/success',
  PAYMENT_ERROR: '/payment/error',

  // Public Offer (Fondy requirement)
  OFFER: '/:lang/offer',

  // Country-specific public pages
  US_DATA_SOURCES: '/us/data-sources',
  UK_DATA_SOURCES: '/uk/data-sources',
  DE_DATA_SOURCES: '/de/data-sources',
  FR_DATA_SOURCES: '/fr/data-sources',
  NL_DATA_SOURCES: '/nl/data-sources',
  EE_DATA_SOURCES: '/ee/data-sources',
  EU_COMPARISON: '/eu/comparison',

  // History
  HISTORY: '/history',

  // Legislation & Analysis
  LEGISLATION_MONITORING: '/legislation/monitoring',
  LEGISLATION_STATISTICS: '/legislation/statistics',
  LEGAL_INITIATIVES: '/legislation/initiatives',
  LEGAL_CODES_LIBRARY: '/legislation/library',
  VOTING_ANALYSIS: '/legislation/voting',
  HISTORICAL_ANALYSIS: '/legislation/historical',
  COURT_PRACTICE_ANALYSIS: '/analysis/court-practice',
} as const;

// Helper function to generate dynamic routes
export const generateRoute = {
  judgeDetail: (id: string) => `/judges/${id}`,
  lawyerDetail: (id: string) => `/lawyers/${id}`,
  clientDetail: (id: string) => `/clients/${id}`,
  matterDetail: (id: string) => `/matters/${id}`,
};
