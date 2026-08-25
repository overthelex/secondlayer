/**
 * Axios instance with authentication, token refresh, and error handling
 */

import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { showToast } from '../toast';
import { toastT } from '../../i18n/toast-i18n';

// Base URL and its validation live in one place — see ./base
import { API_BASE } from './base';

export const API_URL = API_BASE;

// Token refresh state
let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (error: unknown) => void;
}> = [];

function processQueue(error: unknown, token: string | null = null) {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) {
      reject(error);
    } else {
      resolve(token!);
    }
  });
  failedQueue = [];
}

// Public routes that must remain accessible even when a stored token is invalid.
// Keep in sync with the non-AuthGuard branch of router/index.tsx.
const PUBLIC_ROUTE_PATTERNS: RegExp[] = [
  /^\/login$/,
  /^\/verify-email/,
  /^\/reset-password/,
  /^\/payment\//,
  /^\/oferta$/,
  /^\/[a-z]{2}\/(offer|attorney-offer|developer-offer|marketplace-rules|terms|privacy|dpa|ai-usage|ai-transparency|refund-policy|data-sources)/,
  /^\/eu\/comparison/,
  /^\/blog(\/|$)/,
  /^\/news$/,
  /^\/career(\/|$)/,
  /^\/investor(\/|$)/,
  /^\/uk_investor/,
  /^\/r\//,
  /^\/developer\/docs/,
];

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTE_PATTERNS.some((p) => p.test(pathname));
}

function forceLogout() {
  localStorage.removeItem('auth_token');
  localStorage.removeItem('user');
  if (!isPublicRoute(window.location.pathname)) {
    window.location.href = '/login';
  }
}

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

// Response interceptor - handle errors with token refresh
apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<{ message?: string }>) => {
    // Network error
    if (!error.response) {
      showToast.error(toastT('networkError'));
      return Promise.reject(error);
    }

    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    const { status, data } = error.response;

    // 401 Unauthorized - attempt token refresh before logging out
    if (status === 401) {
      // Skip refresh for auth endpoints to avoid infinite loops
      const url = originalRequest?.url || '';
      if (url.includes('/auth/refresh') || url.includes('/auth/login')) {
        forceLogout();
        return Promise.reject(error);
      }

      // Already retried this request — give up
      if (originalRequest._retry) {
        forceLogout();
        return Promise.reject(error);
      }

      // If a refresh is already in progress, queue this request
      if (isRefreshing) {
        return new Promise<string>((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then((token) => {
          originalRequest.headers.Authorization = `Bearer ${token}`;
          return apiClient(originalRequest);
        }).catch((err) => {
          return Promise.reject(err);
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const { data: refreshData } = await axios.post(
          `${API_URL}/auth/refresh`,
          {},
          {
            headers: {
              Authorization: `Bearer ${localStorage.getItem('auth_token')}`,
              'Content-Type': 'application/json',
            },
            timeout: 10000,
          }
        );

        const newToken = refreshData.token;
        localStorage.setItem('auth_token', newToken);

        // Retry all queued requests with the new token
        processQueue(null, newToken);

        // Retry the original request
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return apiClient(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);
        if (!isPublicRoute(window.location.pathname)) {
          showToast.error(toastT('sessionExpired'));
        }
        forceLogout();
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    // 402 Payment Required - insufficient balance
    if (status === 402) {
      const message = data?.message || 'Insufficient balance. Please top up your account.';
      showToast.error(message, 5000);

      return Promise.reject(error);
    }

    // 403 BETA_RESTRICTED - app is restricted to beta testers and users with a Monobank top-up
    if (status === 403 && (data as { code?: string } | undefined)?.code === 'BETA_RESTRICTED') {
      // Lazy import to avoid a hard cycle between api/client and the store.
      import('../../stores/accessGateStore')
        .then((m) => m.useAccessGateStore.getState().markRestricted())
        .catch(() => {
          // If the store can't load for any reason, surface a toast so the
          // user still sees a clear message rather than a silent failure.
          showToast.error(
            (data as { message?: string } | undefined)?.message ||
              'Доступ обмежено для бета-тестування'
          );
        });
      return Promise.reject(error);
    }

    // 429 Too Many Requests - rate limit exceeded
    if (status === 429) {
      // Skip toast for upload endpoints — UploadManager handles 429 retry internally
      const url = error.config?.url || '';
      if (!url.includes('/upload/')) {
        const message = data?.message || 'Rate limit exceeded. Please try again later.';
        showToast.error(message);
      }
      return Promise.reject(error);
    }

    // 500+ Server errors
    if (status >= 500) {
      showToast.error(toastT('serverError'));
      return Promise.reject(error);
    }

    // Other errors - show message from server
    if (data?.message) {
      showToast.error(data.message);
    } else {
      showToast.error(toastT('genericError'));
    }

    return Promise.reject(error);
  }
);

export default apiClient;
