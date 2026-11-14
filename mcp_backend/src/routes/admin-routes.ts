/**
 * Admin Routes — Thin orchestrator that mounts domain-specific sub-routers.
 * All handlers are split into files under ./admin/ for maintainability.
 * Requires admin authentication (applied once at the top level).
 */

import express from 'express';
import { BillingService } from '../services/billing-service.js';
import type { IDatabase } from '../domain/ports/index.js';
import { UserPreferencesService } from '../services/user-preferences-service.js';
import { PrometheusService } from '../services/prometheus-service.js';
import { PricingService } from '../services/pricing-service.js';
import { SubscriptionService } from '../services/subscription-service.js';
import { ConfigService } from '../services/config-service.js';
import type { AuditService } from '../services/audit-service.js';
import type { EmailService } from '../services/email-service.js';

import {
  createRequireAdmin,
  createLogAdminAction,
  createAdminStatsRoutes,
  createAdminUsersRoutes,
  createAdminTransactionsRoutes,
  createAdminBillingRoutes,
  createAdminConfigRoutes,
  createAdminMetricsRoutes,
  createAdminDataSourcesRoutes,
  createAdminScrapingRoutes,
  createAdminImportRoutes,
  createAdminLimitsRoutes,
  createAdminWelcomeBonusRoutes,
} from './admin/index.js';

export function createAdminRoutes(
  db: IDatabase,
  billingService: BillingService,
  preferencesService: UserPreferencesService,
  prometheus: PrometheusService,
  pricing: PricingService,
  subscriptions: SubscriptionService,
  configService?: ConfigService,
  auditService?: AuditService,
  emailService?: EmailService,
): express.Router {
  const router = express.Router();

  // Apply admin auth once at the top level
  const requireAdmin = createRequireAdmin(db);
  const logAdminAction = createLogAdminAction(db);
  router.use(requireAdmin);

  // Mount all domain sub-routers (no path prefix — handlers define their own paths)
  router.use(createAdminStatsRoutes(db, logAdminAction));
  router.use(createAdminUsersRoutes(db, logAdminAction, emailService));
  router.use(createAdminTransactionsRoutes(db, logAdminAction, auditService));
  router.use(createAdminBillingRoutes(db, logAdminAction, pricing, subscriptions));
  router.use(createAdminConfigRoutes(db, logAdminAction, preferencesService, pricing, configService));
  router.use(createAdminMetricsRoutes(db, prometheus));
  router.use(createAdminDataSourcesRoutes(db));
  router.use(createAdminScrapingRoutes(db));
  router.use(createAdminImportRoutes(db));
  router.use(createAdminLimitsRoutes(db));
  router.use(createAdminWelcomeBonusRoutes(db, logAdminAction, billingService));

  return router;
}
