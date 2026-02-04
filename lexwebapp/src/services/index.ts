/**
 * Services Index
 * Export all services from a single entry point
 */

export { legalService } from './api/LegalService';
export { authService } from './api/AuthService';
export { billingService } from './api/BillingService';
export { clientService } from './api/ClientService';

// Export service classes for testing
export { LegalService } from './api/LegalService';
export { AuthService } from './api/AuthService';
export { BillingService } from './api/BillingService';
export { ClientService } from './api/ClientService';

// Export base service
export { BaseService } from './base/BaseService';
export type { ServiceError } from './base/BaseService';
