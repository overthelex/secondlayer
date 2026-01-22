/**
 * ADR-002: PromptBuilder
 *
 * Central assembly point for all prompts. Single source of truth.
 * Uses SystemInstructionRegistry and PromptTemplateRegistry to build
 * complete, versioned prompt instances.
 */

import { SystemInstructionRegistry } from './system-instruction-registry.js';
import { PromptTemplateRegistry } from './prompt-template-registry.js';
import type {
  PromptIntent,
  PromptContext,
  PromptPolicy,
  PromptInstance,
  SourceBlock
} from '../../types/prompt.js';

export class PromptBuilder {
  private systemRegistry: SystemInstructionRegistry;
  private templateRegistry: PromptTemplateRegistry;

  constructor(
    systemInstructionsPath?: string,
    templatesPath?: string
  ) {
    this.systemRegistry = new SystemInstructionRegistry(systemInstructionsPath);
    this.templateRegistry = new PromptTemplateRegistry(templatesPath);
  }

  /**
   * Build a complete prompt instance
   * This is the ONLY place where prompts are assembled
   */
  build(
    intent: PromptIntent,
    context: PromptContext,
    policy: PromptPolicy
  ): PromptInstance {
    // 1. Get system instructions for intent
    const systemInstructions = this.systemRegistry.getForIntent(intent.name);

    // 2. Get template for intent
    const template = this.templateRegistry.getForIntent(intent.name);
    if (!template) {
      throw new Error(`No template found for intent: ${intent.name}`);
    }

    // 3. Build user message from template
    const userMessage = this.buildUserMessage(template.id, context);

    // 4. Inject sources (CRITICAL: ONLY in user context, NEVER in system)
    const sourcesText = this.formatSources(context.sources);
    const fullUserMessage = sourcesText
      ? `${userMessage}\n\n${sourcesText}`
      : userMessage;

    // 5. Create prompt instance
    const instance: PromptInstance = {
      intent,
      system: systemInstructions,
      user: fullUserMessage,
      sources: context.sources,
      constraints: policy,
      metadata: {
        version: template.version,
        template_id: template.id,
        assembled_at: new Date(),
        instance_id: this.generateInstanceId()
      }
    };

    return instance;
  }

  /**
   * Build user message from template and context
   */
  private buildUserMessage(templateId: string, context: PromptContext): string {
    // Extract variables from context
    const variables: Record<string, any> = {
      user_query: context.user_query || '',
      request_id: context.metadata.request_id,
      user_id: context.metadata.user_id || '',
      tool_name: context.metadata.tool_name || ''
    };

    return this.templateRegistry.render(templateId, variables);
  }

  /**
   * Format sources for injection into user message
   * CRITICAL: Sources NEVER go into system messages
   */
  private formatSources(sources: SourceBlock[]): string {
    if (sources.length === 0) {
      return '';
    }

    let result = '--- КОНТЕКСТ ---\n\n';

    for (const source of sources) {
      switch (source.type) {
        case 'raw_text':
          result += `Текст документу:\n${source.payload}\n\n`;
          break;

        case 'section':
          result += `Секція "${source.payload.type}":\n${source.payload.text}\n\n`;
          break;

        case 'citation':
          result += `Цитата зі справи ${source.payload.case_number}:\n${source.payload.text}\n\n`;
          break;

        case 'legal_article':
          result += `Стаття закону ${source.payload.article_number}:\n${source.payload.text}\n\n`;
          break;

        case 'pattern':
          result += `Судова практика:\n${JSON.stringify(source.payload, null, 2)}\n\n`;
          break;

        default:
          result += `Джерело:\n${JSON.stringify(source.payload, null, 2)}\n\n`;
      }
    }

    return result.trim();
  }

  /**
   * Generate unique instance ID
   */
  private generateInstanceId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 9);
    return `prompt_${timestamp}_${random}`;
  }

  /**
   * Get loaded registries for inspection
   */
  getRegistries() {
    return {
      system: this.systemRegistry,
      templates: this.templateRegistry
    };
  }
}
