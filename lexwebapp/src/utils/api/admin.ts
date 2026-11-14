import apiClient from './client';

export const adminApi = {
  getDataSources: (section?: string) =>
    apiClient.get('/api/admin/data-sources', { params: section ? { section } : undefined }),
  getOverview: () => apiClient.get('/api/admin/stats/overview'),
  getRevenueChart: (days: number = 30) =>
    apiClient.get(`/api/admin/stats/revenue-chart?days=${days}`),
  getTierDistribution: () => apiClient.get('/api/admin/stats/tier-distribution'),
  getUsers: (params?: { limit?: number; offset?: number; search?: string; tier?: string; status?: string }) =>
    apiClient.get('/api/admin/users', { params }),
  getUser: (id: string) => apiClient.get(`/api/admin/users/${id}`),
  updateUserTier: (id: string, tier: string) =>
    apiClient.put(`/api/admin/users/${id}/tier`, { tier }),
  adjustBalance: (id: string, amount: number, reason: string) =>
    apiClient.post(`/api/admin/users/${id}/adjust-balance`, { amount, reason }),
  updateLimits: (id: string, limits: { dailyLimitUsd?: number; monthlyLimitUsd?: number }) =>
    apiClient.put(`/api/admin/users/${id}/limits`, limits),
  getTransactions: (params?: { limit?: number; offset?: number; type?: string; status?: string; userId?: string }) =>
    apiClient.get('/api/admin/transactions', { params }),
  refundTransaction: (id: string, reason: string) =>
    apiClient.post(`/api/admin/transactions/${id}/refund`, { reason }),
  getUsageAnalytics: (days: number = 30) =>
    apiClient.get(`/api/admin/analytics/usage?days=${days}`),
  getCohorts: () => apiClient.get('/api/admin/analytics/cohorts'),
  getCostBreakdown: (days: number = 30) =>
    apiClient.get('/api/admin/stats/cost-breakdown', { params: { days } }),
  getUsersCostsSummary: (days: number = 30) =>
    apiClient.get('/api/admin/stats/users-costs', { params: { days } }),
  getUserActivity: (params?: { hours?: number; limit?: number; recent?: number }) =>
    apiClient.get('/api/admin/users/activity', { params }),
  getUserRequests: (userId: string, params?: { limit?: number; offset?: number; days?: number }) =>
    apiClient.get(`/api/admin/users/${userId}/requests`, { params }),
  getUploadMetrics: () => apiClient.get('/api/admin/upload-metrics'),
  getRecentCourtDocs: (days: number = 30, limit: number = 5) =>
    apiClient.get('/api/admin/court-documents/recent', { params: { days, limit } }),
  runDocumentCompletenessCheck: () =>
    apiClient.post('/api/admin/document-completeness-check'),
  startBackfillFulltext: (params?: { justice_kind_code?: string; limit?: number; concurrency?: number; proxy?: string }) =>
    apiClient.post('/api/admin/backfill-fulltext', params),
  getBackfillStatus: (jobId?: string) =>
    jobId
      ? apiClient.get(`/api/admin/backfill-fulltext/${jobId}`)
      : apiClient.get('/api/admin/backfill-fulltext'),
  stopBackfill: (jobId: string) =>
    apiClient.post(`/api/admin/backfill-fulltext/${jobId}/stop`),
  deleteBackfillJob: (jobId: string) =>
    apiClient.delete(`/api/admin/backfill-fulltext/${jobId}`),
  getTrafficMetrics: (range: string = '1h') =>
    apiClient.get('/api/admin/metrics/traffic', { params: { range } }),
  getLatencyMetrics: (range: string = '1h') =>
    apiClient.get('/api/admin/metrics/latency', { params: { range } }),
  getServicesHealth: () =>
    apiClient.get('/api/admin/metrics/services'),
  getSystemMetrics: () =>
    apiClient.get('/api/admin/metrics/system'),

  // Billing management
  getBillingTiers: () =>
    apiClient.get('/api/admin/billing/tiers'),
  updateBillingTier: (idOrKey: string, data: Record<string, unknown>) =>
    apiClient.put(`/api/admin/billing/tiers/${idOrKey}`, data),
  setDefaultTier: (id: string) =>
    apiClient.put(`/api/admin/billing/tiers/${id}/default`),
  deleteBillingTier: (id: string) =>
    apiClient.delete(`/api/admin/billing/tiers/${id}`),
  getVolumeDiscounts: () =>
    apiClient.get('/api/admin/billing/volume-discounts'),
  updateVolumeDiscounts: (thresholds: Array<Record<string, unknown>>) =>
    apiClient.put('/api/admin/billing/volume-discounts', { thresholds }),
  getOrganizations: () =>
    apiClient.get('/api/admin/billing/organizations'),
  getPendingWelcomeBonuses: () =>
    apiClient.get('/api/admin/welcome-bonus/pending'),
  reviewWelcomeBonus: (userId: string, action: 'approve' | 'reject') =>
    apiClient.post(`/api/admin/welcome-bonus/${userId}/${action}`),
  getOrganization: (id: string) =>
    apiClient.get(`/api/admin/billing/organizations/${id}`),
  updateOrganization: (id: string, data: Record<string, unknown>) =>
    apiClient.put(`/api/admin/billing/organizations/${id}`, data),
  getSubscriptions: (params?: { limit?: number; offset?: number; status?: string; tier?: string }) =>
    apiClient.get('/api/admin/billing/subscriptions', { params }),
  createSubscription: (data: Record<string, unknown>) =>
    apiClient.post('/api/admin/billing/subscriptions', data),
  updateSubscription: (id: string, data: Record<string, unknown>) =>
    apiClient.put(`/api/admin/billing/subscriptions/${id}`, data),
  deleteSubscription: (id: string) =>
    apiClient.delete(`/api/admin/billing/subscriptions/${id}`),
  cancelSubscription: (id: string, reason: string) =>
    apiClient.put(`/api/admin/billing/subscriptions/${id}/cancel`, { reason }),
  activateSubscription: (id: string) =>
    apiClient.put(`/api/admin/billing/subscriptions/${id}/activate`),
  getSubscriptionStats: () =>
    apiClient.get('/api/admin/billing/subscription-stats'),

  // Container metrics (cAdvisor)
  getContainerMetrics: (range: string = '1h') =>
    apiClient.get('/api/admin/metrics/containers', { params: { range } }),

  // Infrastructure dashboards
  getInfrastructureMetrics: (range: string = '1h') =>
    apiClient.get('/api/admin/metrics/infrastructure', { params: { range } }),
  getUploadPipelineMetrics: (range: string = '1h') =>
    apiClient.get('/api/admin/metrics/upload-pipeline', { params: { range } }),
  getBackendDetailMetrics: (range: string = '1h') =>
    apiClient.get('/api/admin/metrics/backend-detail', { params: { range } }),
  getCostRealtimeMetrics: (range: string = '6h') =>
    apiClient.get('/api/admin/metrics/cost-realtime', { params: { range } }),
  getUserTags: (userId: string) =>
    apiClient.get(`/api/admin/users/${userId}/tags`),
  toggleCryptoTag: (userId: string, enable: boolean) =>
    enable
      ? apiClient.put(`/api/admin/users/${userId}/tags/crypto`)
      : apiClient.delete(`/api/admin/users/${userId}/tags/crypto`),
  toggleTestTag: (userId: string, enable: boolean) =>
    enable
      ? apiClient.put(`/api/admin/users/${userId}/tags/test`)
      : apiClient.delete(`/api/admin/users/${userId}/tags/test`),
  createTestUser: (data: { email: string; name?: string; password: string; credits: number }) =>
    apiClient.post('/api/admin/test-users', data),
  resetUserPassword: (id: string) =>
    apiClient.post(`/api/admin/users/${id}/reset-password`),

  getImportSamples: (hours: number = 24, limit: number = 5) =>
    apiClient.get('/api/admin/import-samples', { params: { hours, limit } }),

  // System configuration
  getConfig: () => apiClient.get('/api/admin/config'),
  updateConfig: (key: string, value: string) =>
    apiClient.put(`/api/admin/config/${key}`, { value }),
  resetConfig: (key: string) =>
    apiClient.delete(`/api/admin/config/${key}`),
  // Court registry scraper
  startCourtScraper: (params?: {
    justice_kind?: string;
    justice_kind_id?: string;
    doc_form?: string;
    date_from?: string;
    max_docs?: number;
    concurrency?: number;
    proxy?: string;
  }) => apiClient.post('/api/admin/scrape-court-registry', params),
  getCourtScraperStatus: (jobId?: string) =>
    jobId
      ? apiClient.get(`/api/admin/scrape-court-registry/${jobId}`)
      : apiClient.get('/api/admin/scrape-court-registry'),
  stopCourtScraper: (jobId: string) =>
    apiClient.post(`/api/admin/scrape-court-registry/${jobId}/stop`),
  deleteCourtScraperJob: (jobId: string) =>
    apiClient.delete(`/api/admin/scrape-court-registry/${jobId}`),
  getAllScraperJobs: () =>
    apiClient.get('/api/admin/scrape-court-registry/all'),
  getRegistryCoverageMap: (years?: number) =>
    apiClient.get(`/api/admin/registry-coverage-map${years ? `?years=${years}` : ''}`),

  // Service pricing
  getServicePricing: () =>
    apiClient.get('/api/admin/service-pricing'),
  updateServicePricing: (id: string, data: { price_usd: number; notes?: string; is_active?: boolean }) =>
    apiClient.put(`/api/admin/service-pricing/${id}`, data),

  // Tool pricing
  getToolPricing: () =>
    apiClient.get('/api/admin/tool-pricing'),
  updateToolPricing: (toolName: string, data: { base_cost_usd?: number; markup_percent?: number; notes?: string; is_active?: boolean }) =>
    apiClient.put(`/api/admin/tool-pricing/${toolName}`, data),
  bulkMarkupToolPricing: (data: { markup_percent: number; service?: string }) =>
    apiClient.post('/api/admin/tool-pricing/bulk-markup', data),
  getZOStats: (params: { yearFrom: number; yearTo: number; justiceKind: string }) =>
    apiClient.get('/api/admin/zo-stats', { params }),
  getBulkScrapeStatus: () =>
    apiClient.get('/api/admin/bulk-scrape-status'),
  getInfrastructureHealth: () =>
    apiClient.get('/api/admin/infrastructure-health'),

  // Attorney profile management
  getAttorneyProfile: (userId: string) =>
    apiClient.get(`/api/admin/users/${userId}/attorney-profile`),
  createAttorneyProfile: (userId: string, data: Record<string, unknown>) =>
    apiClient.post(`/api/admin/users/${userId}/attorney-profile`, data),
  updateAttorneyProfile: (userId: string, data: Record<string, unknown>) =>
    apiClient.put(`/api/admin/users/${userId}/attorney-profile`, data),
  deleteAttorneyProfile: (userId: string) =>
    apiClient.delete(`/api/admin/users/${userId}/attorney-profile`),

  // System limits
  getLimits: () =>
    apiClient.get('/api/admin/limits'),
  getToolUsage: (days: number = 30) =>
    apiClient.get('/api/admin/stats/tool-usage', { params: { days } }),
};
