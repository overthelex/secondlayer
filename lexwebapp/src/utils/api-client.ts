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
      const message = data?.message || 'Rate limit exceeded. Please try again later.';
      toast.error(message);
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

// Typed API methods
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
    getHistory: (params?: { limit?: number; offset?: number; type?: string }) =>
      apiClient.get('/api/billing/history', { params }),
    updateSettings: (data: { daily_limit_usd?: number; monthly_limit_usd?: number }) =>
      apiClient.put('/api/billing/settings', data),
    testEmail: () => apiClient.post('/api/billing/test-email'),
  },

  // Payments
  payment: {
    createStripe: (data: { amount_usd: number; metadata?: any }) =>
      apiClient.post('/api/billing/payment/stripe/create', data),
    createFondy: (data: { amount_uah: number }) =>
      apiClient.post('/api/billing/payment/fondy/create', data),
    getStatus: (provider: string, paymentId: string) =>
      apiClient.get(`/api/billing/payment/${provider}/${paymentId}/status`),
  },

  // Tools
  tools: {
    execute: (toolName: string, params: any) =>
      apiClient.post(`/api/tools/${toolName}`, params),
  },
};
