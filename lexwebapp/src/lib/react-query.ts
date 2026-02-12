/**
 * React Query Configuration
 * Global configuration for React Query client
 */

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Stale time: Data considered fresh for 5 minutes
      staleTime: 5 * 60 * 1000,

      // Cache time: Keep unused data in cache for 10 minutes
      gcTime: 10 * 60 * 1000,

      // Retry failed requests
      retry: (failureCount, error: any) => {
        // Don't retry on 4xx errors
        if (error?.status >= 400 && error?.status < 500) {
          return false;
        }
        // Retry up to 2 times for other errors
        return failureCount < 2;
      },

      // Refetch on window focus for important data
      refetchOnWindowFocus: false,

      // Refetch on reconnect
      refetchOnReconnect: true,
    },
    mutations: {
      // Retry failed mutations once
      retry: 1,
    },
  },
});

/**
 * Query Keys
 * Centralized query key factory for type safety and consistency
 */
export const queryKeys = {
  // Auth
  auth: {
    me: ['auth', 'me'] as const,
    profile: (userId: string) => ['auth', 'profile', userId] as const,
  },

  // Legal
  legal: {
    all: ['legal'] as const,
    advice: (query: string) => ['legal', 'advice', query] as const,
    cases: (filters: Record<string, any>) =>
      ['legal', 'cases', filters] as const,
    document: (docId: string) => ['legal', 'document', docId] as const,
  },

  // Billing
  billing: {
    all: ['billing'] as const,
    balance: ['billing', 'balance'] as const,
    transactions: (filters?: Record<string, any>) =>
      ['billing', 'transactions', filters] as const,
    settings: ['billing', 'settings'] as const,
  },

  // Clients
  clients: {
    all: ['clients'] as const,
    list: (filters?: Record<string, any>) =>
      ['clients', 'list', filters] as const,
    detail: (clientId: string) => ['clients', 'detail', clientId] as const,
  },

  // Matters
  matters: {
    all: ['matters'] as const,
    list: (filters?: Record<string, any>) =>
      ['matters', 'list', filters] as const,
    detail: (matterId: string) => ['matters', 'detail', matterId] as const,
    team: (matterId: string) => ['matters', 'team', matterId] as const,
    holds: (matterId: string) => ['matters', 'holds', matterId] as const,
  },

  // Audit
  audit: {
    all: ['audit'] as const,
    list: (filters?: Record<string, any>) =>
      ['audit', 'list', filters] as const,
  },

  // Time Entries
  timeEntries: {
    all: ['timeEntries'] as const,
    list: (filters?: Record<string, any>) =>
      ['timeEntries', 'list', filters] as const,
    timers: ['timeEntries', 'timers'] as const,
  },

  // Invoices
  invoices: {
    all: ['invoices'] as const,
    list: (filters?: Record<string, any>) =>
      ['invoices', 'list', filters] as const,
    detail: (invoiceId: string) => ['invoices', 'detail', invoiceId] as const,
  },
} as const;
