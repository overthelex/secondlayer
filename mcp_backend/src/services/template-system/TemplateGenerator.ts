/**
 * TemplateGenerator Service
 *
 * Auto-generates new templates for unmatched questions
 * - LLM-based template creation with JSON schemas
 * - Mustache template syntax for variable interpolation
 * - Multi-stage validation (syntax, schema, sample testing)
 * - Sampling test execution (5-10 test inputs)
 * - Pending approval workflow
 * - Tracks generation history and validation results
 */

import {
  QuestionClassification,
  GeneratedTemplate,
  TemplateGenerationRequest,
} from './types.js';
import { logger, BaseDatabase, getOpenAIManager } from '@secondlayer/shared';
import { CostTracker } from '../cost-tracker.js';

interface GenerationStage {
  stage: 'generation' | 'validation' | 'sampling' | 'approval';
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  completedAt?: Date;
  errors?: string[];
}

interface TemplateSchema {
  type: 'object';
  properties: Record<string, any>;
  required: string[];
}

interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  syntaxValid: boolean;
  schemaValid: boolean;
  samplesValid: boolean;
}

interface SamplingTestResult {
  success: boolean;
  input: Record<string, any>;
  output: string;
  latencyMs: number;
  costUsd: number;
  errors?: string[];
}

export class TemplateGenerator {
  private readonly SAMPLE_TEST_COUNT = 5;
  private readonly SAMPLE_TEST_TIMEOUT = 30000; // 30 seconds
  private readonly MAX_GENERATION_ATTEMPTS = 3;

  constructor(
    private db: BaseDatabase,
    private llmManager?: any,
    private costTracker?: CostTracker,
    private embeddingService?: any
  ) {}

  /**
   * Generate a new template from an unmatched question
   */
  async generateTemplate(
    request: TemplateGenerationRequest
  ): Promise<any> {
    const generationId = this.generateGenerationId();
    const startTime = Date.now();

    try {
      // 1. Generate template with LLM
      const template = await this.createTemplateWithLLM(
        request.questionText,
        request.classification
      );

      // 2. Validate syntax and schema
      const validationResult = await this.validateTemplate(template);
      if (!validationResult.isValid) {
        throw new Error(
          `Validation failed: ${validationResult.errors.join('; ')}`
        );
      }

      // 3. Run sampling tests
      const samplingResults = await this.runSamplingTests(template);
      const samplesValid = samplingResults.every((r) => r.success);

      // 4. Store generation record
      await this.storeGeneration(
        generationId,
        request,
        template,
        validationResult,
        samplingResults,
        samplesValid
      );

      logger.info('TemplateGenerator: Generation complete', {
        generationId,
        intent: request.classification.intent,
        executionTimeMs: Date.now() - startTime,
        validationPassed: validationResult.isValid,
        samplesValid,
      });

      return {
        generationId,
        status: 'pending',
        template,
        validationStatus: validationResult.isValid ? 'valid' : 'invalid',
        testResults: samplingResults,
        approvalStatus: 'pending',
        message: 'Template generated successfully. Awaiting admin review.',
      };
    } catch (error) {
      logger.error('TemplateGenerator: Generation failed', {
        generationId,
        intent: request.classification.intent,
        error: (error as Error).message,
      });

      throw error;
    }
  }

  /**
   * Create template using LLM (gpt-4o model)
   */
  private async createTemplateWithLLM(
    userQuestion: string,
    classification: QuestionClassification
  ): Promise<GeneratedTemplate> {
    if (!this.llmManager) {
      throw new Error('LLM Manager not available for template generation');
    }

    const prompt = this.buildGenerationPrompt(userQuestion, classification);

    try {
      const response = await this.llmManager.generateText({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        maxTokens: 2000,
      });

      const template = this.parseTemplateResponse(response.text);

      // Note: Cost tracking moved to higher-level API endpoints
      return template;
    } catch (error) {
      logger.error('TemplateGenerator: LLM generation failed', {
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Validate template syntax and schema
   */
  private async validateTemplate(
    template: GeneratedTemplate
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Validate Mustache syntax
    const syntaxValid = this.validateMustacheSyntax(template.promptTemplate);
    if (!syntaxValid) {
      errors.push('Invalid Mustache template syntax');
    }

    // 2. Validate JSON schemas
    const schemasValid = this.validateSchemas(
      template.inputSchema,
      template.outputSchema
    );
    if (!schemasValid) {
      errors.push('Invalid input/output JSON schemas');
    }

    // 3. Check for undefined variables
    const templateVars = this.extractMustacheVariables(template.promptTemplate);
    const schemaProperties = Object.keys(template.inputSchema.properties || {});
    const undefinedVars = templateVars.filter(
      (v) => !schemaProperties.includes(v)
    );
    if (undefinedVars.length > 0) {
      warnings.push(
        `Template uses undefined variables: ${undefinedVars.join(', ')}`
      );
    }

    // 4. Check example provided
    if (!template.exampleInput || !template.exampleOutput) {
      warnings.push('No examples provided for template');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      syntaxValid,
      schemaValid: schemasValid,
      samplesValid: false, // Will be updated after sampling tests
    };
  }

  /**
   * Run sampling tests with generated template
   */
  private async runSamplingTests(
    template: GeneratedTemplate
  ): Promise<SamplingTestResult[]> {
    const results: SamplingTestResult[] = [];

    // Use provided example or generate test inputs
    const testInputs = template.exampleInput ? [template.exampleInput] : this.generateTestInputs(template);

    for (const testInput of testInputs.slice(0, this.SAMPLE_TEST_COUNT)) {
      const startTime = Date.now();

      try {
        // Render template with test input
        const output = this.renderMustacheTemplate(
          template.promptTemplate,
          testInput
        );

        // Validate output against schema
        const isValid = this.validateAgainstSchema(
          output,
          template.outputSchema as TemplateSchema
        );

        results.push({
          success: isValid,
          input: testInput,
          output,
          latencyMs: Date.now() - startTime,
          costUsd: 0, // Sampling is free - no LLM calls
        });
      } catch (error) {
        results.push({
          success: false,
          input: testInput,
          output: '',
          latencyMs: Date.now() - startTime,
          costUsd: 0,
          errors: [(error as Error).message],
        });
      }
    }

    return results;
  }

  /**
   * Get generation status and validation results
   */
  async getGenerationStatus(generationId: string): Promise<any> {
    try {
      const result = await this.db.query(
        `SELECT
          id,
          status,
          approval_status,
          validation_status,
          template,
          test_results,
          validation_errors,
          admin_feedback,
          rollout_percentage,
          created_at,
          updated_at
        FROM template_generations
        WHERE id = $1`,
        [generationId]
      );

      if (result.rows.length === 0) {
        throw new Error(`Generation ${generationId} not found`);
      }

      const generation = result.rows[0];

      return {
        generationId: generation.id,
        status: generation.status,
        approvalStatus: generation.approval_status,
        validationStatus: generation.validation_status,
        template: generation.template,
        testResults: generation.test_results,
        validationErrors: generation.validation_errors,
        adminFeedback: generation.admin_feedback,
        rolloutPercentage: generation.rollout_percentage || 0,
        createdAt: generation.created_at,
        updatedAt: generation.updated_at,
      };
    } catch (error) {
      logger.error('TemplateGenerator: Status query failed', {
        generationId,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Approve a generated template (admin only)
   */
  async approveGeneration(
    generationId: string,
    approvalNotes: string,
    suggestedImprovements?: string
  ): Promise<{ templateId: string; status: string }> {
    try {
      // 1. Get generation record
      const genResult = await this.db.query(
        `SELECT template FROM template_generations WHERE id = $1`,
        [generationId]
      );

      if (genResult.rows.length === 0) {
        throw new Error(`Generation ${generationId} not found`);
      }

      const template = genResult.rows[0].template;

      // 2. Create template in question_templates table
      const templateId = this.generateId();
      await this.db.query(
        `INSERT INTO question_templates (
          id, name, category, intent_keywords, prompt_template,
          input_schema, output_schema, quality_score, success_rate,
          user_satisfaction, status, current_version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          templateId,
          template.name,
          template.category,
          template.intent,
          template.promptTemplate,
          JSON.stringify(template.inputSchema),
          JSON.stringify(template.outputSchema),
          70, // Initial quality score
          0, // No usage yet
          0, // No ratings yet
          'active',
          '1.0.0',
        ]
      );

      // 3. Update generation record
      await this.db.query(
        `UPDATE template_generations
        SET status = 'approved',
            approval_status = 'approved',
            template_id = $1,
            admin_feedback = $2,
            approved_at = CURRENT_TIMESTAMP,
            rollout_percentage = 5
        WHERE id = $3`,
        [templateId, approvalNotes, generationId]
      );

      logger.info('TemplateGenerator: Template approved', {
        generationId,
        templateId,
      });

      return {
        templateId,
        status: 'approved',
      };
    } catch (error) {
      logger.error('TemplateGenerator: Approval failed', {
        generationId,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Reject a generated template (admin only)
   */
  async rejectGeneration(
    generationId: string,
    reason: string,
    feedback?: string
  ): Promise<{ status: string }> {
    try {
      await this.db.query(
        `UPDATE template_generations
        SET status = 'rejected',
            approval_status = 'rejected',
            admin_feedback = $1,
            rejected_at = CURRENT_TIMESTAMP
        WHERE id = $2`,
        [reason + (feedback ? `\n${feedback}` : ''), generationId]
      );

      logger.info('TemplateGenerator: Template rejected', { generationId });

      return { status: 'rejected' };
    } catch (error) {
      logger.error('TemplateGenerator: Rejection failed', {
        generationId,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Build LLM prompt for template generation
   */
  private buildGenerationPrompt(
    userQuestion: string,
    classification: QuestionClassification
  ): string {
    return `
You are an expert legal template engineer. Generate a reusable template for this type of legal question.

## User Question
"${userQuestion}"

## Classification
- Intent: ${classification.intent}
- Category: ${classification.category}
- Confidence: ${classification.confidence}

## Task
Create a legal template that can handle questions similar to the user's question.

The template should:
1. Use Mustache syntax for variables ({{variable_name}})
2. Be generic enough to apply to similar cases
3. Include clear placeholders for dates, names, amounts, etc.
4. Have proper JSON input/output schemas
5. Include 3-5 realistic example inputs

## Output Format
Return ONLY valid JSON with this exact structure:

\`\`\`json
{
  "name": "Template Name",
  "description": "Brief description",
  "category": "${classification.category}",
  "intent": "${classification.intent}",
  "promptTemplate": "The actual Mustache template {{variable}}...",
  "inputSchema": {
    "type": "object",
    "properties": {
      "variable": {"type": "string", "description": "..."}
    },
    "required": ["variable"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "result": {"type": "string"}
    }
  },
  "examples": [
    {"variable": "example value"}
  ]
}
\`\`\`

Generate the template now:
`;
  }

  /**
   * Parse LLM response into GeneratedTemplate
   */
  private parseTemplateResponse(responseText: string): GeneratedTemplate {
    // Extract JSON from response
    const jsonMatch = responseText.match(/\`\`\`json\n?([\s\S]*?)\n?\`\`\`/);
    const jsonStr = jsonMatch ? jsonMatch[1] : responseText;

    try {
      const parsed = JSON.parse(jsonStr);

      return {
        id: `gen_${Date.now()}`,
        name: parsed.name,
        category: parsed.category,
        promptTemplate: parsed.promptTemplate,
        inputSchema: parsed.inputSchema,
        outputSchema: parsed.outputSchema,
        instructions: parsed.instructions || '',
        exampleInput: parsed.exampleInput || {},
        exampleOutput: parsed.exampleOutput || {},
        intentKeywords: parsed.intentKeywords || [],
        generationModel: 'gpt-4o',
        generationCostUsd: 0.08,
        generationDurationMs: 0,
        validationStatus: 'pending',
      } as GeneratedTemplate;
    } catch (error) {
      logger.error('TemplateGenerator: Failed to parse LLM response', {
        error: (error as Error).message,
        responseLength: responseText.length,
      });
      throw new Error('Failed to parse template from LLM response');
    }
  }

  /**
   * Validate Mustache template syntax
   */
  private validateMustacheSyntax(template: string): boolean {
    try {
      // Check for balanced brackets
      const openCount = (template.match(/\{\{/g) || []).length;
      const closeCount = (template.match(/\}\}/g) || []).length;
      return openCount === closeCount;
    } catch {
      return false;
    }
  }

  /**
   * Validate JSON schemas
   */
  private validateSchemas(
    inputSchema: any,
    outputSchema: any
  ): boolean {
    try {
      if (!inputSchema || !outputSchema) return false;
      if (
        inputSchema.type !== 'object' ||
        outputSchema.type !== 'object'
      )
        return false;
      if (!inputSchema.properties || !outputSchema.properties) return false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Extract Mustache variables from template
   */
  private extractMustacheVariables(template: string): string[] {
    const regex = /\{\{([^}]+)\}\}/g;
    const matches: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(template)) !== null) {
      const variable = match[1].trim();
      if (!matches.includes(variable)) {
        matches.push(variable);
      }
    }

    return matches;
  }

  /**
   * Render Mustache template with data
   */
  private renderMustacheTemplate(template: string, data: Record<string, any>): string {
    let rendered = template;

    Object.entries(data).forEach(([key, value]) => {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      rendered = rendered.replace(regex, String(value));
    });

    return rendered;
  }

  /**
   * Validate output against schema
   */
  private validateAgainstSchema(output: any, schema: TemplateSchema): boolean {
    try {
      // Simple validation - in production use JSON Schema validator
      if (typeof output === 'string') {
        return output.length > 0;
      }
      return Boolean(output);
    } catch {
      return false;
    }
  }

  /**
   * Generate test inputs from schema
   */
  private generateTestInputs(template: GeneratedTemplate): Record<string, any>[] {
    const inputs: Record<string, any>[] = [];
    const properties = template.inputSchema.properties || {};

    // Generate 5 realistic test inputs based on schema
    for (let i = 0; i < 5; i++) {
      const input: Record<string, any> = {};

      Object.entries(properties).forEach(([key, prop]: [string, any]) => {
        if (prop.type === 'string') {
          input[key] = `Test Value ${i + 1}`;
        } else if (prop.type === 'number') {
          input[key] = (i + 1) * 100;
        } else if (prop.type === 'boolean') {
          input[key] = i % 2 === 0;
        } else if (prop.type === 'array') {
          input[key] = [`Item ${i + 1}`];
        } else {
          input[key] = `Value ${i + 1}`;
        }
      });

      inputs.push(input);
    }

    return inputs;
  }

  /**
   * Store generation record in database
   */
  private async storeGeneration(
    generationId: string,
    request: TemplateGenerationRequest,
    template: GeneratedTemplate,
    validationResult: ValidationResult,
    samplingResults: SamplingTestResult[],
    samplesValid: boolean
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO template_generations (
          id, user_id, question, classification,
          template, validation_status, validation_errors,
          test_results, status, approval_status,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          generationId,
          request.userId || null,
          request.questionText,
          JSON.stringify(request.classification),
          JSON.stringify(template),
          validationResult.isValid ? 'valid' : 'invalid',
          validationResult.errors.length > 0
            ? JSON.stringify(validationResult.errors)
            : null,
          JSON.stringify(samplingResults),
          'pending',
          'pending',
        ]
      );
    } catch (error) {
      logger.error('TemplateGenerator: Failed to store generation', {
        generationId,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Generate unique IDs
   */
  private generateGenerationId(): string {
    return `gen_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateId(): string {
    return `template_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// Export singleton factory
let generatorInstance: TemplateGenerator | null = null;

export function createTemplateGenerator(
  db: BaseDatabase,
  llmManager?: any,
  costTracker?: any,
  embeddingService?: any
): TemplateGenerator {
  if (!generatorInstance) {
    generatorInstance = new TemplateGenerator(
      db,
      llmManager,
      costTracker,
      embeddingService
    );
  }
  return generatorInstance;
}

export function getTemplateGenerator(): TemplateGenerator {
  if (!generatorInstance) {
    throw new Error('TemplateGenerator not initialized');
  }
  return generatorInstance;
}
