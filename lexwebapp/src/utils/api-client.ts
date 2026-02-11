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
    getBalance: () => apiClient.get('/billing/balance'),
    getSettings: () => apiClient.get('/billing/settings'),
    getHistory: (params?: { limit?: number; offset?: number; type?: string }) =>
      apiClient.get('/billing/history', { params }),
    updateSettings: (data: {
      daily_limit_usd?: number;
      monthly_limit_usd?: number;
      email_notifications?: boolean;
      notify_low_balance?: boolean;
      notify_payment_success?: boolean;
      notify_payment_failure?: boolean;
      notify_monthly_report?: boolean;
      low_balance_threshold_usd?: number;
    }) => apiClient.put('/billing/settings', data),
    getEmailPreferences: () => apiClient.get('/billing/email-preferences'),
    getInvoices: (params?: { limit?: number; offset?: number }) =>
      apiClient.get('/billing/invoices', { params }),
    downloadInvoicePDF: (invoiceNumber: string) =>
      apiClient.get(`/billing/invoices/${invoiceNumber}/pdf`, { responseType: 'blob' }),
    testEmail: () => apiClient.post('/billing/test-email'),
    getStatistics: (period: string = '30d') =>
      apiClient.get(`/billing/statistics?period=${period}`),
    getUsageChart: (days: number = 30) =>
      apiClient.get(`/billing/usage-chart?days=${days}`),
    getPaymentMethods: () => apiClient.get('/billing/payment-methods'),
    addPaymentMethod: (data: any) =>
      apiClient.post('/billing/payment-methods', data),
    removePaymentMethod: (id: string) =>
      apiClient.delete(`/billing/payment-methods/${id}`),
    setPrimaryPaymentMethod: (id: string) =>
      apiClient.put(`/billing/payment-methods/${id}/primary`, {}),
    upgradePlan: (planId: string) =>
      apiClient.post('/billing/upgrade', { planId }),
    getPricingInfo: () => apiClient.get('/billing/pricing-info'),
  },

  // Payments
  payment: {
    createStripe: (data: { amount_usd: number; metadata?: any }) =>
      apiClient.post('/billing/payment/stripe/create', data),
    createFondy: (data: { amount_uah: number }) =>
      apiClient.post('/billing/payment/fondy/create', data),
    getStatus: (provider: string, paymentId: string) =>
      apiClient.get(`/billing/payment/${provider}/${paymentId}/status`),
  },

  // Team Management
  team: {
    getMembers: () => apiClient.get('/team/members'),
    getStats: () => apiClient.get('/team/stats'),
    inviteMember: (email: string, role: string) =>
      apiClient.post('/team/invite', { email, role }),
    updateMember: (memberId: string, data: any) =>
      apiClient.put(`/team/members/${memberId}`, data),
    removeMember: (memberId: string) =>
      apiClient.delete(`/team/members/${memberId}`),
    resendInvite: (memberId: string) =>
      apiClient.post(`/team/members/${memberId}/resend-invite`, {}),
  },

  // Tools
  tools: {
    execute: (toolName: string, params: any) =>
      apiClient.post(`/tools/${toolName}`, params),
  },

  // Conversations
  conversations: {
    create: (title?: string) => apiClient.post('/conversations', { title }),
    list: (params?: { limit?: number; offset?: number }) =>
      apiClient.get('/conversations', { params }),
    get: (id: string) => apiClient.get(`/conversations/${id}`),
    rename: (id: string, title: string) =>
      apiClient.put(`/conversations/${id}`, { title }),
    delete: (id: string) => apiClient.delete(`/conversations/${id}`),
    addMessage: (conversationId: string, message: {
      role: 'user' | 'assistant';
      content: string;
      thinking_steps?: any[];
      decisions?: any[];
      citations?: any[];
    }) => apiClient.post(`/conversations/${conversationId}/messages`, message),
    getMessages: (conversationId: string, params?: { limit?: number; offset?: number }) =>
      apiClient.get(`/conversations/${conversationId}/messages`, { params }),
  },

  // GDPR
  gdpr: {
    requestExport: () => apiClient.post('/gdpr/export'),
    getExport: (id: string) => apiClient.get(`/gdpr/export/${id}`),
    requestDeletion: (confirmation: string) =>
      apiClient.post('/gdpr/delete', { confirmation }),
    listRequests: () => apiClient.get('/gdpr/requests'),
  },
};
