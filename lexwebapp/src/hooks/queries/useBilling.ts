/**
 * Billing Query Hooks
 * React Query hooks for billing operations
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { billingService } from '../../services';
import { queryKeys } from '../../lib/react-query';
import {
  UpdateBillingSettingsRequest,
  GetTransactionHistoryRequest,
} from '../../types/api';

/**
 * Get account balance
 */
export function useBalance() {
  return useQuery({
    queryKey: queryKeys.billing.balance,
    queryFn: () => billingService.getBalance(),
    staleTime: 2 * 60 * 1000, // Balance fresh for 2 minutes
    refetchInterval: 5 * 60 * 1000, // Auto-refetch every 5 minutes
  });
}

/**
 * Get transaction history
 */
export function useTransactionHistory(params?: GetTransactionHistoryRequest) {
  return useQuery({
    queryKey: queryKeys.billing.transactions(params),
    queryFn: () => billingService.getTransactionHistory(params),
    staleTime: 1 * 60 * 1000, // Fresh for 1 minute
  });
}

/**
 * Get billing settings
 */
export function useBillingSettings() {
  return useQuery({
    queryKey: queryKeys.billing.settings,
    queryFn: async () => {
      // Assuming there's a getSettings method
      // For now, return empty settings
      return {
        daily_limit_usd: undefined,
        monthly_limit_usd: undefined,
      };
    },
    staleTime: 10 * 60 * 1000, // Settings fresh for 10 minutes
  });
}

/**
 * Update billing settings
 */
export function useUpdateBillingSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: UpdateBillingSettingsRequest) =>
      billingService.updateSettings(data),
    onSuccess: () => {
      // Invalidate settings query
      queryClient.invalidateQueries({ queryKey: queryKeys.billing.settings });
    },
  });
}

/**
 * Create Monobank invoice
 */
export function useCreateMonobankInvoice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ amountUah }: { amountUah: number }) =>
      billingService.createMonobankInvoice(amountUah),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.billing.balance });
      queryClient.invalidateQueries({ queryKey: queryKeys.billing.transactions() });
    },
  });
}

/**
 * Send test email
 */
export function useSendTestEmail() {
  return useMutation({
    mutationFn: () => billingService.sendTestEmail(),
  });
}
