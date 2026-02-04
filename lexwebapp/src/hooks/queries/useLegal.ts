/**
 * Legal Query Hooks
 * React Query hooks for legal service operations
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { legalService } from '../../services';
import { queryKeys } from '../../lib/react-query';
import {
  GetLegalAdviceRequest,
  SearchCourtCasesRequest,
} from '../../types/api';
import { Message } from '../../types/models';

/**
 * Get legal advice (mutation, not query - each request is unique)
 */
export function useGetLegalAdvice() {
  return useMutation({
    mutationFn: (request: GetLegalAdviceRequest) =>
      legalService.getLegalAdvice(request),
    onSuccess: (data: Message) => {
      // Optionally cache the result by query
      // queryClient.setQueryData(queryKeys.legal.advice(query), data);
    },
  });
}

/**
 * Search court cases
 */
export function useSearchCourtCases(request: SearchCourtCasesRequest) {
  return useQuery({
    queryKey: queryKeys.legal.cases(request),
    queryFn: () => legalService.searchCourtCases(request),
    enabled: !!request.query, // Only fetch if query exists
  });
}

/**
 * Get document text
 */
export function useGetDocumentText(documentId: string) {
  return useQuery({
    queryKey: queryKeys.legal.document(documentId),
    queryFn: () => legalService.getDocumentText(documentId),
    enabled: !!documentId,
    staleTime: 30 * 60 * 1000, // Document text rarely changes - 30 min
  });
}
