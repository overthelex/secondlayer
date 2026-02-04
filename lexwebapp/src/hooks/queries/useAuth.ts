/**
 * Auth Query Hooks
 * React Query hooks for authentication operations
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authService } from '../../services';
import { queryKeys } from '../../lib/react-query';
import { UpdateProfileRequest } from '../../types/api';
import { User } from '../../types/models';

/**
 * Get current user
 */
export function useUser() {
  return useQuery({
    queryKey: queryKeys.auth.me,
    queryFn: () => authService.getMe(),
    staleTime: 10 * 60 * 1000, // User data fresh for 10 minutes
    retry: false, // Don't retry on 401
  });
}

/**
 * Update user profile
 */
export function useUpdateProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: UpdateProfileRequest) =>
      authService.updateProfile(data),
    onMutate: async (newData) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: queryKeys.auth.me });

      // Snapshot previous value
      const previousUser = queryClient.getQueryData<User>(queryKeys.auth.me);

      // Optimistically update
      if (previousUser) {
        queryClient.setQueryData<User>(queryKeys.auth.me, {
          ...previousUser,
          ...newData,
        });
      }

      return { previousUser };
    },
    onError: (err, newData, context) => {
      // Rollback on error
      if (context?.previousUser) {
        queryClient.setQueryData(queryKeys.auth.me, context.previousUser);
      }
    },
    onSettled: () => {
      // Refetch after mutation
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.me });
    },
  });
}

/**
 * Refresh token
 */
export function useRefreshToken() {
  return useMutation({
    mutationFn: () => authService.refreshToken(),
  });
}

/**
 * Logout
 */
export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => authService.logout(),
    onSuccess: () => {
      // Clear all queries on logout
      queryClient.clear();
    },
  });
}
