/**
 * Client Query Hooks
 * React Query hooks for client management
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  clientService,
  CreateClientRequest,
  UpdateClientRequest,
  SearchClientsRequest,
} from '../../services/api/ClientService';
import { queryKeys } from '../../lib/react-query';

/**
 * Get clients list
 */
export function useClients(params?: SearchClientsRequest) {
  return useQuery({
    queryKey: queryKeys.clients.list(params),
    queryFn: () => clientService.getClients(params),
    staleTime: 2 * 60 * 1000, // Fresh for 2 minutes
  });
}

/**
 * Get client by ID
 */
export function useClient(clientId: string) {
  return useQuery({
    queryKey: queryKeys.clients.detail(clientId),
    queryFn: () => clientService.getClientById(clientId),
    enabled: !!clientId,
    staleTime: 5 * 60 * 1000, // Fresh for 5 minutes
  });
}

/**
 * Create new client
 */
export function useCreateClient() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateClientRequest) => clientService.createClient(data),
    onSuccess: () => {
      // Invalidate clients list
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.all });
    },
  });
}

/**
 * Update client
 */
export function useUpdateClient() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateClientRequest }) =>
      clientService.updateClient(id, data),
    onSuccess: (_, variables) => {
      // Invalidate specific client and list
      queryClient.invalidateQueries({
        queryKey: queryKeys.clients.detail(variables.id),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.all });
    },
  });
}

/**
 * Delete client
 */
export function useDeleteClient() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (clientId: string) => clientService.deleteClient(clientId),
    onSuccess: () => {
      // Invalidate clients list
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.all });
    },
  });
}

/**
 * Send message to clients
 */
export function useSendClientMessage() {
  return useMutation({
    mutationFn: ({
      clientIds,
      message,
    }: {
      clientIds: string[];
      message: string;
    }) => clientService.sendMessage(clientIds, message),
  });
}
