/**
 * Types for Dynamic Template System
 */

// Question classification result
export interface QuestionClassification {
  intent: string;
  confidence: number; // 0-1
  category: string;
  entities: Record<string, any>;
  keywords: string[];
  reasoning: string;
  alternatives: ClassificationAlternative[];
  executionTimeMs: number;
  costUsd: number;
}

export interface ClassificationAlternative {
  intent: string;
  category: string;
  confidence: number; // 0-1
  reasoning: string;
}

// Template match result
export interface TemplateMatchResult {
  templateId: string;
  templateName: string;
  matchScore: number; // 0-1
  qualityScore?: number; // 0-100
  successRate?: number; // 0-100
  userSatisfaction?: number; // 0-5
  reasoning: string;
  shouldGenerateNew: boolean; // true if score < 0.65
}

// Template generation request
export interface TemplateGenerationRequest {
  questionText: string;
  classification: QuestionClassification;
  userId: string;
  questionId: string;
}

// Generated template (pending approval)
export interface GeneratedTemplate {
  id: string;
  name: string;
  category: string;
  promptTemplate: string; // Mustache template with {{variables}}
  inputSchema: Record<string, any>; // JSON schema
  outputSchema: Record<string, any>; // JSON schema
  instructions: string;
  exampleInput: Record<string, any>;
  exampleOutput: Record<string, any>;
  intentKeywords: string[];
  generationModel: string;
  generationCostUsd: number;
  generationDurationMs: number;
  validationStatus: 'pending' | 'valid' | 'invalid';
  validationErrors?: string[];
}

// Template version record
export interface TemplateVersion {
  versionNumber: string; // e.g. "1.0.0"
  changeType: 'initial' | 'major' | 'minor' | 'patch';
  changeDescription: string;
  releasedAt: string;
  isCurrent: boolean;
  isSupported: boolean;
}

// Template recommendation
export interface TemplateRecommendation {
  templateId: string;
  templateName: string;
  strategy: 'frequency' | 'trending' | 'collaborative' | 'seasonal' | 'cost_optimized';
  strategyScore: number; // 0-100
  combinedScore: number; // 0-100
  reason: string;
  confidence: number; // 0-1
}

// Template execution result
export interface TemplateExecutionResult {
  templateId: string;
  templateVersion: string;
  result: Record<string, any>;
  executionTimeMs: number;
  executionCostUsd: number;
}

// User feedback on template
export interface TemplateFeedback {
  rating: 1 | 2 | 3 | 4 | 5;
  wasHelpful: boolean;
  improvementSuggestion?: string;
  accuracyIssue?: string;
  missingInformation?: string;
}

// Template quality metrics
export interface TemplateMetrics {
  templateId: string;
  templateName: string;
  qualityScore: number; // 0-100
  successRate: number; // 0-100
  userSatisfaction: number; // 0-5
  totalUses: number;
  generationCostUsd: number;
  avgExecutionCostUsd: number;
  avgRating: number;
  positiveRatings: number;
  negativeRatings: number;
  feedbackCount: number;
}

// Template usage stats
export interface TemplateUsageStats {
  templateId: string;
  uses30d: number;
  avgRating30d: number;
  avgCost30d: number;
  totalCost30d: number;
  totalTimeSaved30d: number;
  roi30d: number;
}
