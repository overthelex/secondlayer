/**
 * Dynamic Template System Services
 * Exports all services for the self-learning template system
 */

export { TemplateClassifier, createTemplateClassifier, getTemplateClassifier } from './TemplateClassifier';
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
} from './types';
