import apiClient from './client';

export const billingApi = {
  getBalance: () => apiClient.get('/api/billing/balance'),
  getSettings: () => apiClient.get('/api/billing/settings'),
  getHistory: (params?: { limit?: number; offset?: number; type?: string }) =>
    apiClient.get('/api/billing/history', { params }),
  updateSettings: (data: {
    daily_limit_usd?: number;
    monthly_limit_usd?: number;
    email_notifications?: boolean;
    notify_low_balance?: boolean;
    notify_payment_success?: boolean;
    notify_payment_failure?: boolean;
    notify_monthly_report?: boolean;
    low_balance_threshold_usd?: number;
  }) => apiClient.put('/api/billing/settings', data),
  getEmailPreferences: () => apiClient.get('/api/billing/email-preferences'),
  getInvoices: (params?: { limit?: number; offset?: number }) =>
    apiClient.get('/api/billing/invoices', { params }),
  downloadInvoicePDF: (invoiceNumber: string) =>
    apiClient.get(`/api/billing/invoices/${invoiceNumber}/pdf`, { responseType: 'blob' }),
  testEmail: () => apiClient.post('/api/billing/test-email'),
  getStatistics: (period: string = '30d') =>
    apiClient.get(`/api/billing/statistics?period=${period}`),
  getUsageChart: (days: number = 30) =>
    apiClient.get(`/api/billing/usage-chart?days=${days}`),
  getBillingInfo: () => apiClient.get('/api/billing/billing-info'),
  updateBillingInfo: (data: {
    companyName?: string;
    edrpou?: string;
    address?: string;
    city?: string;
    postalCode?: string;
    country?: string;
    email?: string;
    phone?: string;
  }) => apiClient.put('/api/billing/billing-info', data),
  getPaymentMethods: () => apiClient.get('/api/billing/payment-methods'),
  addPaymentMethod: (data: Record<string, unknown>) =>
    apiClient.post('/api/billing/payment-methods', data),
  removePaymentMethod: (id: string) =>
    apiClient.delete(`/api/billing/payment-methods/${id}`),
  setPrimaryPaymentMethod: (id: string) =>
    apiClient.put(`/api/billing/payment-methods/${id}/primary`, {}),
  upgradePlan: (planId: string) =>
    apiClient.put('/api/billing/settings', { pricingTier: planId }),
  getPricingInfo: () => apiClient.get('/api/billing/pricing-info'),
};

export const b2bInvoiceApi = {
  create: (data: { invoice_type: string; tier_key?: string; billing_cycle?: string; amount_uah?: number; notes?: string }) =>
    apiClient.post('/api/b2b-invoices', data),
  list: (params?: { status?: string; limit?: number; offset?: number }) =>
    apiClient.get('/api/b2b-invoices', { params }),
  get: (id: string) =>
    apiClient.get(`/api/b2b-invoices/${id}`),
  downloadPDF: (id: string) =>
    apiClient.get(`/api/b2b-invoices/${id}/pdf`, { responseType: 'blob' }),
  cancel: (id: string, reason?: string) =>
    apiClient.post(`/api/b2b-invoices/${id}/cancel`, { reason }),
  getOrgInfo: () =>
    apiClient.get('/api/b2b-invoices/org-info'),
  updateOrgInfo: (data: { edrpou?: string; legal_address?: string; name?: string; billing_email?: string }) =>
    apiClient.patch('/api/b2b-invoices/org-info', data),
};

export const paymentApi = {
  createMonobank: (data: { amount_uah: number; redirect_url?: string }) =>
    apiClient.post('/api/billing/payment/monobank/create', data),
  getWelcomeBonus: () =>
    apiClient.get('/api/billing/payment/welcome-bonus'),
  createCardVerify: () =>
    apiClient.post('/api/billing/payment/monobank/card-verify'),
  createMetaMask: (data: { amount_usd: number; network: string; token: string }) =>
    apiClient.post('/api/billing/payment/metamask/create', data),
  verifyMetaMask: (data: { paymentIntentId: string; txHash: string }) =>
    apiClient.post('/api/billing/payment/metamask/verify', data),
  createBinancePay: (data: { amount_usd: number }) =>
    apiClient.post('/api/billing/payment/binance-pay/create', data),
  getAvailableProviders: () =>
    apiClient.get('/api/billing/payment/available-providers'),
  getStatus: (provider: string, paymentId: string) =>
    apiClient.get(`/api/billing/payment/${provider}/${paymentId}/status`),
};
