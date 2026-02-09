/**
 * Services Index
 * Export all services from a single entry point
 */

export { legalService } from './api/LegalService';
export { authService } from './api/AuthService';
export { billingService } from './api/BillingService';
export { clientService } from './api/ClientService';
export { mcpService } from './api/MCPService';

// Export service classes for testing
export { LegalService } from './api/LegalService';
export { AuthService } from './api/AuthService';
export { BillingService } from './api/BillingService';
export { ClientService } from './api/ClientService';
export { MCPService } from './api/MCPService';
export { SSEClient } from './api/SSEClient';

// Upload service
export { UploadService, uploadService } from './api/UploadService';

// Upload manager
export { UploadManager, uploadManager } from './upload/UploadManager';

// Export base service
export { BaseService } from './base/BaseService';
export type { ServiceError } from './base/BaseService';
