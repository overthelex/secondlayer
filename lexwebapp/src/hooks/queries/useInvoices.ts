/**
 * Invoice Query Hooks
 * React Query hooks for invoice management
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  invoiceService,
  InvoiceFilters,
  RecordPaymentParams,
  AddLineItemParams,
} from '../../services/api/InvoiceService';
import { GenerateInvoiceParams } from '../../types/models';
import { queryKeys } from '../../lib/react-query';

/**
 * Get invoices list
 */
export function useInvoices(filters?: InvoiceFilters) {
  return useQuery({
    queryKey: queryKeys.invoices.list(filters),
    queryFn: () => invoiceService.getInvoices(filters),
    staleTime: 2 * 60 * 1000, // Fresh for 2 minutes
  });
}

/**
 * Get invoice by ID with details
 */
export function useInvoice(invoiceId: string) {
  return useQuery({
    queryKey: queryKeys.invoices.detail(invoiceId),
    queryFn: () => invoiceService.getInvoiceById(invoiceId),
    enabled: !!invoiceId,
    staleTime: 1 * 60 * 1000, // Fresh for 1 minute
  });
}

/**
 * Generate invoice from time entries
 */
export function useGenerateInvoice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: GenerateInvoiceParams) => invoiceService.generateInvoice(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.timeEntries.all });
    },
  });
}

/**
 * Download invoice PDF
 */
export function useDownloadInvoicePDF() {
  return useMutation({
    mutationFn: ({ id, invoiceNumber }: { id: string; invoiceNumber: string }) =>
      invoiceService.downloadInvoiceFile(id, invoiceNumber),
  });
}

/**
 * Send invoice to client
 */
export function useSendInvoice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => invoiceService.sendInvoice(id),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.detail(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.all });
    },
  });
}

/**
 * Record payment for invoice
 */
export function useRecordPayment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, params }: { id: string; params: RecordPaymentParams }) =>
      invoiceService.recordPayment(id, params),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.detail(variables.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.all });
    },
  });
}

/**
 * Void invoice
 */
export function useVoidInvoice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => invoiceService.voidInvoice(id),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.detail(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.timeEntries.all });
    },
  });
}

/**
 * Add manual line item to invoice
 */
export function useAddLineItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, params }: { id: string; params: AddLineItemParams }) =>
      invoiceService.addLineItem(id, params),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.detail(variables.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.all });
    },
  });
}
