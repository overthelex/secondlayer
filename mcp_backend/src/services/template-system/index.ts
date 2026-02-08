/**
 * Dynamic Template System Services
 * Exports all services for the self-learning template system
 */

export { TemplateClassifier, createTemplateClassifier, getTemplateClassifier } from './TemplateClassifier.js';
export { TemplateMatcher } from './TemplateMatcher.js';
export { TemplateGenerator } from './TemplateGenerator.js';
export { TemplateStorage, getTemplateStorage } from './TemplateStorage.js';
export { TemplateVersionManager, getTemplateVersionManager } from './TemplateVersionManager.js';
export type {
  QuestionClassification,
  ClassificationAlternative,
  TemplateMatchResult,
  TemplateGenerationRequest,
  GeneratedTemplate,
  TemplateRecommendation,
  TemplateExecutionResult,
  TemplateFeedback,
  TemplateMetrics,
  TemplateUsageStats,
} from './types.js';
export type {
  VersionMetrics,
  PromotionRequest,
  PromotionEligibility,
} from './TemplateVersionManager.js';
