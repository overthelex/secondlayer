/**
 * Matter Query Hooks
 * React Query hooks for matter, team, hold, and audit management
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  matterService,
  SearchMattersParams,
  AuditLogParams,
} from '../../services/api/MatterService';
import {
  CreateMatterRequest,
  UpdateMatterRequest,
  CreateHoldRequest,
  MatterTeamRole,
  MatterAccessLevel,
} from '../../types/models/Matter';
import { queryKeys } from '../../lib/react-query';

// ─── Matters ─────────────────────────────────────────────

export function useMatters(params?: SearchMattersParams) {
  return useQuery({
    queryKey: queryKeys.matters.list(params),
    queryFn: () => matterService.getMatters(params),
    staleTime: 2 * 60 * 1000,
  });
}

export function useMatter(matterId: string) {
  return useQuery({
    queryKey: queryKeys.matters.detail(matterId),
    queryFn: () => matterService.getMatterById(matterId),
    enabled: !!matterId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateMatter() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateMatterRequest) => matterService.createMatter(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.matters.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.all });
    },
  });
}

export function useUpdateMatter() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateMatterRequest }) =>
      matterService.updateMatter(id, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.matters.detail(variables.id),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.matters.all });
    },
  });
}

export function useCloseMatter() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (matterId: string) => matterService.closeMatter(matterId),
    onSuccess: (_, matterId) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.matters.detail(matterId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.matters.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.all });
    },
  });
}

// ─── Team ────────────────────────────────────────────────

export function useMatterTeam(matterId: string) {
  return useQuery({
    queryKey: queryKeys.matters.team(matterId),
    queryFn: () => matterService.getTeamMembers(matterId),
    enabled: !!matterId,
    staleTime: 2 * 60 * 1000,
  });
}

export function useAddTeamMember() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      matterId,
      memberId,
      role,
      accessLevel,
    }: {
      matterId: string;
      memberId: string;
      role?: MatterTeamRole;
      accessLevel?: MatterAccessLevel;
    }) => matterService.addTeamMember(matterId, memberId, role, accessLevel),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.matters.team(variables.matterId),
      });
    },
  });
}

export function useRemoveTeamMember() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ matterId, userId }: { matterId: string; userId: string }) =>
      matterService.removeTeamMember(matterId, userId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.matters.team(variables.matterId),
      });
    },
  });
}

// ─── Legal Holds ─────────────────────────────────────────

export function useMatterHolds(matterId: string) {
  return useQuery({
    queryKey: queryKeys.matters.holds(matterId),
    queryFn: () => matterService.getHolds(matterId),
    enabled: !!matterId,
    staleTime: 2 * 60 * 1000,
  });
}

export function useCreateHold() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ matterId, data }: { matterId: string; data: CreateHoldRequest }) =>
      matterService.createHold(matterId, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.matters.holds(variables.matterId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.matters.detail(variables.matterId),
      });
    },
  });
}

export function useReleaseHold() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ holdId }: { holdId: string; matterId: string }) =>
      matterService.releaseHold(holdId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.matters.holds(variables.matterId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.matters.detail(variables.matterId),
      });
    },
  });
}

// ─── Audit ───────────────────────────────────────────────

export function useAuditLog(params?: AuditLogParams) {
  return useQuery({
    queryKey: queryKeys.audit.list(params),
    queryFn: () => matterService.getAuditLog(params),
    staleTime: 30 * 1000,
  });
}

export function useValidateAuditChain() {
  return useMutation({
    mutationFn: () => matterService.validateAuditChain(),
  });
}
