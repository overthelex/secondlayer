/**
 * API Client Utility
 * Axios instance with authentication and error handling
 */

import axios, { AxiosError, AxiosInstance } from 'axios';
import toast from 'react-hot-toast';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// Create axios instance
const apiClient: AxiosInstance = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000, // 30 seconds
});

// Request interceptor - attach JWT token
apiClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('auth_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor - handle errors
apiClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError<any>) => {
    // Network error
    if (!error.response) {
      toast.error('Network error. Please check your connection.');
      return Promise.reject(error);
    }

    const { status, data } = error.response;

    // 401 Unauthorized - redirect to login
    if (status === 401) {
      const message = data?.message || 'Session expired. Please login again.';
      toast.error(message);

      // Clear token and redirect to login
      localStorage.removeItem('auth_token');
      localStorage.removeItem('user');
      window.location.href = '/login';

      return Promise.reject(error);
    }

    // 402 Payment Required - insufficient balance
    if (status === 402) {
      const message = data?.message || 'Insufficient balance. Please top up your account.';
      toast.error(message, {
        duration: 5000,
        action: {
          label: 'Top Up',
          onClick: () => {
            window.location.href = '/billing?tab=topup';
          },
        },
      } as any);

      return Promise.reject(error);
    }

    // 429 Too Many Requests - rate limit exceeded
    if (status === 429) {
      // Skip toast for upload endpoints — UploadManager handles 429 retry internally
      const url = error.config?.url || '';
      if (!url.includes('/upload/')) {
        const message = data?.message || 'Rate limit exceeded. Please try again later.';
        toast.error(message);
      }
      return Promise.reject(error);
    }

    // 500+ Server errors
    if (status >= 500) {
      toast.error('Server error. Please try again later.');
      return Promise.reject(error);
    }

    // Other errors - show message from server
    if (data?.message) {
      toast.error(data.message);
    } else {
      toast.error('An error occurred. Please try again.');
    }

    return Promise.reject(error);
  }
);

export default apiClient;

/**
 * API Service Object
 * Centralized API methods for auth, billing, payments, team, and tools
 */
export const api = {
  // Auth
  auth: {
    getMe: () => apiClient.get('/auth/me'),
    logout: () => apiClient.post('/auth/logout'),
    refreshToken: () => apiClient.post('/auth/refresh'),
    updateProfile: (data: { name?: string; picture?: string }) =>
      apiClient.put('/auth/profile', data),
  },

  // Billing
  billing: {
    getBalance: () => apiClient.get('/api/billing/balance'),
    getSettings: () => apiClient.get('/api/billing/settings'),
    getHistory: (params?: { limit?: number; offset?: number; type?: string }) =>
      apiClient.get('/api/billing/history', { params }),
    updateSettings: (data: {
      daily_limit_usd?: number;
      monthly_limit_usd?: number;
      email_notifications?: boolean;
      notify_low_balance?: boolean;
      notify_payment_success?: boolean;
      notify_payment_failure?: boolean;
      notify_monthly_report?: boolean;
      low_balance_threshold_usd?: number;
    }) => apiClient.put('/api/billing/settings', data),
    getEmailPreferences: () => apiClient.get('/api/billing/email-preferences'),
    getInvoices: (params?: { limit?: number; offset?: number }) =>
      apiClient.get('/api/billing/invoices', { params }),
    downloadInvoicePDF: (invoiceNumber: string) =>
      apiClient.get(`/api/billing/invoices/${invoiceNumber}/pdf`, { responseType: 'blob' }),
    testEmail: () => apiClient.post('/api/billing/test-email'),
    getStatistics: (period: string = '30d') =>
      apiClient.get(`/api/billing/statistics?period=${period}`),
    getUsageChart: (days: number = 30) =>
      apiClient.get(`/api/billing/usage-chart?days=${days}`),
    getPaymentMethods: () => apiClient.get('/api/billing/payment-methods'),
    addPaymentMethod: (data: any) =>
      apiClient.post('/api/billing/payment-methods', data),
    removePaymentMethod: (id: string) =>
      apiClient.delete(`/api/billing/payment-methods/${id}`),
    setPrimaryPaymentMethod: (id: string) =>
      apiClient.put(`/api/billing/payment-methods/${id}/primary`, {}),
    upgradePlan: (planId: string) =>
      apiClient.put('/api/billing/settings', { pricingTier: planId }),
    getPricingInfo: () => apiClient.get('/api/billing/pricing-info'),
  },

  // Payments
  payment: {
    createStripe: (data: { amount_usd: number; metadata?: any }) =>
      apiClient.post('/api/billing/payment/stripe/create', data),
    createMetaMask: (data: { amount_usd: number; network: string; token: string }) =>
      apiClient.post('/api/billing/payment/metamask/create', data),
    verifyMetaMask: (data: { paymentIntentId: string; txHash: string }) =>
      apiClient.post('/api/billing/payment/metamask/verify', data),
    createBinancePay: (data: { amount_usd: number }) =>
      apiClient.post('/api/billing/payment/binance-pay/create', data),
    getAvailableProviders: () =>
      apiClient.get('/api/billing/payment/available-providers'),
    getStatus: (provider: string, paymentId: string) =>
      apiClient.get(`/api/billing/payment/${provider}/${paymentId}/status`),
  },

  // Team Management
  team: {
    getMembers: () => apiClient.get('/api/team/members'),
    getStats: () => apiClient.get('/api/team/stats'),
    getOrganization: () => apiClient.get('/api/team/organization'),
    createOrganization: (data: { name: string; taxId?: string; contactEmail?: string; description?: string }) =>
      apiClient.post('/api/team/organization', data),
    inviteMember: (email: string, role: string) =>
      apiClient.post('/api/team/invite', { email, role }),
    updateMember: (memberId: string, data: any) =>
      apiClient.put(`/api/team/members/${memberId}`, data),
    removeMember: (memberId: string) =>
      apiClient.delete(`/api/team/members/${memberId}`),
    resendInvite: (memberId: string) =>
      apiClient.post(`/api/team/members/${memberId}/resend-invite`, {}),
  },

  // Tools
  tools: {
    execute: (toolName: string, params: any) =>
      apiClient.post(`/api/tools/${toolName}`, params),
  },

  // Conversations
  conversations: {
    create: (title?: string) => apiClient.post('/api/conversations', { title }),
    list: (params?: { limit?: number; offset?: number }) =>
      apiClient.get('/api/conversations', { params }),
    get: (id: string) => apiClient.get(`/api/conversations/${id}`),
    rename: (id: string, title: string) =>
      apiClient.put(`/api/conversations/${id}`, { title }),
    delete: (id: string) => apiClient.delete(`/api/conversations/${id}`),
    addMessage: (conversationId: string, message: {
      role: 'user' | 'assistant';
      content: string;
      thinking_steps?: any[];
      decisions?: any[];
      citations?: any[];
    }) => apiClient.post(`/api/conversations/${conversationId}/messages`, message),
  },

  // Documents
  documents: {
    getFolders: (prefix?: string) =>
      apiClient.get('/api/documents/folders', { params: { prefix } }),
  },

  // Admin
  admin: {
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
    getUploadMetrics: () => apiClient.get('/api/admin/upload-metrics'),
    getRecentCourtDocs: (days: number = 30, limit: number = 5) =>
      apiClient.get('/api/admin/court-documents/recent', { params: { days, limit } }),
    runDocumentCompletenessCheck: () =>
      apiClient.post('/api/admin/document-completeness-check'),
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
    updateBillingTier: (idOrKey: string, data: any) =>
      apiClient.put(`/api/admin/billing/tiers/${idOrKey}`, data),
    setDefaultTier: (id: string) =>
      apiClient.put(`/api/admin/billing/tiers/${id}/default`),
    deleteBillingTier: (id: string) =>
      apiClient.delete(`/api/admin/billing/tiers/${id}`),
    getVolumeDiscounts: () =>
      apiClient.get('/api/admin/billing/volume-discounts'),
    updateVolumeDiscounts: (thresholds: any[]) =>
      apiClient.put('/api/admin/billing/volume-discounts', { thresholds }),
    getOrganizations: () =>
      apiClient.get('/api/admin/billing/organizations'),
    getOrganization: (id: string) =>
      apiClient.get(`/api/admin/billing/organizations/${id}`),
    updateOrganization: (id: string, data: any) =>
      apiClient.put(`/api/admin/billing/organizations/${id}`, data),
    getSubscriptions: (params?: { limit?: number; offset?: number; status?: string; tier?: string }) =>
      apiClient.get('/api/admin/billing/subscriptions', { params }),
    createSubscription: (data: any) =>
      apiClient.post('/api/admin/billing/subscriptions', data),
    updateSubscription: (id: string, data: any) =>
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

    // System configuration
    getConfig: () => apiClient.get('/api/admin/config'),
    updateConfig: (key: string, value: string) =>
      apiClient.put(`/api/admin/config/${key}`, { value }),
    resetConfig: (key: string) =>
      apiClient.delete(`/api/admin/config/${key}`),
  },

  // GDPR
  gdpr: {
    requestExport: () => apiClient.post('/api/gdpr/export'),
    getExport: (id: string) => apiClient.get(`/api/gdpr/export/${id}`),
    requestDeletion: (confirmation: string) =>
      apiClient.post('/api/gdpr/delete', { confirmation }),
    listRequests: () => apiClient.get('/api/gdpr/requests'),
  },
};
