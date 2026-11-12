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
  SHARED: '/shared/:token',

  // Referral
  REFERRAL: '/referral',
  REFERRAL_LANDING: '/r/:code',

  // Profile & Settings
  PROFILE: '/profile',
  BILLING: '/billing',
  BILLING_OVERVIEW: '/billing/overview',
  BILLING_TARIFFS: '/billing/tariffs',
  BILLING_HISTORY: '/billing/history',
  BILLING_ANALYTICS: '/billing/analytics',
  BILLING_SETTINGS: '/billing/settings',
  USAGE: '/usage',
  TEAM: '/team',
  MCP_CONNECT: '/mcp-connect',
  DEVELOPER_DOCS: '/developer/docs',
  MY_CONTRACTS: '/my-contracts',

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
  DOCUMENTS_FOLDER: '/documents/folders/*',

  // Cases & Decisions
  CASE_ANALYSIS: '/case-analysis',
  DECISIONS_SEARCH: '/decisions',

  // Payment Results (Monobank redirects)
  PAYMENT_SUCCESS: '/payment/success',
  PAYMENT_ERROR: '/payment/error',

  // Public Offer & Legal
  OFFER: '/:lang/offer',
  ATTORNEY_OFFER: '/:lang/attorney-offer',
  MARKETPLACE_RULES: '/:lang/marketplace-rules',
  DEVELOPER_OFFER: '/:lang/developer-offer',
  OFERTA: '/oferta',
  TERMS: '/:lang/terms',
  PRIVACY: '/:lang/privacy',
  DPA: '/:lang/dpa',
  AI_USAGE: '/:lang/ai-usage',
  AI_TRANSPARENCY: '/:lang/ai-transparency',
  REFUND_POLICY: '/:lang/refund-policy',
  AUP: '/:lang/aup',
  API_TERMS: '/:lang/api-terms',

  // Abuse report (public)
  ABUSE_REPORT: '/abuse',

  // Blog
  BLOG: '/blog',
  BLOG_ARTICLE: '/blog/:slug',
  BLOG_ARTICLE_LANG: '/blog/:lang/:slug',

  // Career
  CAREER: '/career',
  CISO_ACADEMY: '/cisoacademy',

  // About / Product (public marketing surfaces)
  ABOUT: '/about',
  ABOUT_TEAM: '/about/team',
  PRODUCT: '/product',

  // Investor
  INVESTOR_LETTER: '/investor',
  UK_INVESTOR: '/uk_investor',
  UK_INVESTOR_SIMPLIFIED: '/uk_investor_simplified',

  // Data sources hub
  DATA_SOURCES: '/data-sources',

  // Country-specific public pages
  US_DATA_SOURCES: '/us/data-sources',
  UK_DATA_SOURCES: '/uk/data-sources',
  DE_DATA_SOURCES: '/de/data-sources',
  FR_DATA_SOURCES: '/fr/data-sources',
  NL_DATA_SOURCES: '/nl/data-sources',
  EE_DATA_SOURCES: '/ee/data-sources',
  UA_DATA_SOURCES: '/ua/data-sources',
  EU_COMPARISON: '/eu/comparison',

  // News
  NEWS: '/news',

  // History
  HISTORY: '/history',

  // Legislation & Analysis
  LEGISLATION_MONITORING: '/legislation/monitoring',
  LEGAL_CODES_LIBRARY: '/legislation/library',
  COURT_PRACTICE_ANALYSIS: '/analysis/court-practice',

  // Attorney Consultations
  ATTORNEYS: '/attorneys',
  ATTORNEY_DETAIL: '/attorneys/:id',
  ATTORNEY_PROFILE_EDIT: '/attorney/profile',
  ATTORNEY_CLIENTS: '/attorney/clients',
  CONSULTATIONS: '/consultations',
  CONSULTATIONS_PAYOUTS: '/consultations/payouts',
  CONSULTATION_DETAIL: '/consultations/:id',

  // Workflows
  WORKFLOWS: '/workflows',
  WORKFLOW_SET_DETAIL: '/workflows/:id',

  // Admin
  ADMIN_OVERVIEW: '/admin/overview',
  ADMIN_MONITORING: '/admin/monitoring',
  ADMIN_USERS: '/admin/users',
  ADMIN_COSTS: '/admin/costs',
  ADMIN_BILLING: '/admin/billing',
  ADMIN_INFRASTRUCTURE: '/admin/infrastructure',
  ADMIN_CONTAINERS: '/admin/containers',
  ADMIN_CONFIG: '/admin/config',
  ADMIN_SERVICE_PRICING: '/admin/service-pricing',
  ADMIN_TERMINAL: '/admin/terminal',
  ADMIN_USER_ACTIVITY: '/admin/user-activity',
  ADMIN_ZO_STATS: '/admin/zo-stats',
  ADMIN_BULK_SCRAPE: '/admin/bulk-scrape',
  ADMIN_LIMITS: '/admin/limits',
  ADMIN_SESSION_REPLAY: '/admin/session-replay',
} as const;

// Helper function to generate dynamic routes
export const generateRoute = {
  judgeDetail: (id: string) => `/judges/${encodeURIComponent(id)}`,
  lawyerDetail: (id: string) => `/lawyers/${id}`,
  clientDetail: (id: string) => `/clients/${id}`,
  matterDetail: (id: string) => `/matters/${id}`,
  attorneyDetail: (id: string) => `/attorneys/${id}`,
  consultationDetail: (id: string) => `/consultations/${id}`,
};
