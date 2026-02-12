/**
 * Time Entry Query Hooks
 * React Query hooks for time tracking and timers
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  timeEntryService,
  TimeEntriesListResponse,
} from '../../services/api/TimeEntryService';
import {
  CreateTimeEntryParams,
  UpdateTimeEntryParams,
  TimeEntryFilters,
  TimeEntry,
  ActiveTimer,
} from '../../types/models';
import { queryKeys } from '../../lib/react-query';

/**
 * Get time entries list
 */
export function useTimeEntries(filters?: TimeEntryFilters) {
  return useQuery({
    queryKey: queryKeys.timeEntries.list(filters),
    queryFn: () => timeEntryService.getTimeEntries(filters),
    staleTime: 1 * 60 * 1000, // Fresh for 1 minute
  });
}

/**
 * Create new time entry
 */
export function useCreateTimeEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateTimeEntryParams) => timeEntryService.createTimeEntry(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.timeEntries.all });
    },
  });
}

/**
 * Update time entry
 */
export function useUpdateTimeEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateTimeEntryParams }) =>
      timeEntryService.updateTimeEntry(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.timeEntries.all });
    },
  });
}

/**
 * Delete time entry
 */
export function useDeleteTimeEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => timeEntryService.deleteTimeEntry(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.timeEntries.all });
    },
  });
}

/**
 * Submit time entry for approval
 */
export function useSubmitTimeEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => timeEntryService.submitTimeEntry(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.timeEntries.all });
    },
  });
}

/**
 * Approve time entry
 */
export function useApproveTimeEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => timeEntryService.approveTimeEntry(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.timeEntries.all });
    },
  });
}

/**
 * Reject time entry
 */
export function useRejectTimeEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, notes }: { id: string; notes?: string }) =>
      timeEntryService.rejectTimeEntry(id, notes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.timeEntries.all });
    },
  });
}

// ============================================================================
// Timer Hooks
// ============================================================================

/**
 * Get active timers
 */
export function useActiveTimers() {
  return useQuery({
    queryKey: queryKeys.timeEntries.timers,
    queryFn: () => timeEntryService.getActiveTimers(),
    staleTime: 30 * 1000, // Fresh for 30 seconds
    refetchInterval: 30 * 1000, // Refetch every 30 seconds
  });
}

/**
 * Start timer
 */
export function useStartTimer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ matter_id, description }: { matter_id: string; description?: string }) =>
      timeEntryService.startTimer(matter_id, description),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.timeEntries.timers });
    },
  });
}

/**
 * Stop timer
 */
export function useStopTimer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ matter_id, create_entry }: { matter_id: string; create_entry?: boolean }) =>
      timeEntryService.stopTimer(matter_id, create_entry),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.timeEntries.timers });
      queryClient.invalidateQueries({ queryKey: queryKeys.timeEntries.all });
    },
  });
}

/**
 * Ping timer (keep-alive)
 */
export function usePingTimer() {
  return useMutation({
    mutationFn: (matter_id: string) => timeEntryService.pingTimer(matter_id),
  });
}

// ============================================================================
// Billing Rate Hooks
// ============================================================================

/**
 * Get user's current billing rate
 */
export function useUserRate(userId: string, date?: string) {
  return useQuery({
    queryKey: ['userRate', userId, date],
    queryFn: () => timeEntryService.getUserRate(userId, date),
    enabled: !!userId,
    staleTime: 10 * 60 * 1000, // Fresh for 10 minutes
  });
}

/**
 * Set user billing rate
 */
export function useSetUserRate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      user_id,
      hourly_rate_usd,
      effective_from,
      effective_to,
      is_default,
    }: {
      user_id: string;
      hourly_rate_usd: number;
      effective_from?: string;
      effective_to?: string;
      is_default?: boolean;
    }) =>
      timeEntryService.setUserRate(
        user_id,
        hourly_rate_usd,
        effective_from,
        effective_to,
        is_default
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['userRate', variables.user_id] });
    },
  });
}
