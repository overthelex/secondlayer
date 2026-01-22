/**
 * ADR-002: PromptTemplateRegistry
 *
 * Manages reusable prompt templates with variable substitution.
 * Templates use {{variable}} syntax for placeholders.
 */

import fs from 'fs';
import path from 'path';
import type { PromptTemplate, PromptIntent } from '../../types/prompt.js';

export class PromptTemplateRegistry {
  private templates: Map<string, PromptTemplate> = new Map();

  constructor(templatesPath?: string) {
    // Default to src/prompts/templates relative to project root
    const defaultPath = path.join(process.cwd(), 'src/prompts/templates');
    const resolvedPath = templatesPath || defaultPath;

    this.loadTemplates(resolvedPath);
  }

  /**
   * Load templates from directory
   */
  private loadTemplates(directoryPath: string): void {
    if (!fs.existsSync(directoryPath)) {
      console.warn(`Templates directory not found: ${directoryPath}`);
      console.warn('Creating directory...');
      fs.mkdirSync(directoryPath, { recursive: true });
      return;
    }

    const files = fs.readdirSync(directoryPath).filter(f => f.endsWith('.txt') || f.endsWith('.md'));

    for (const file of files) {
      try {
        const filePath = path.join(directoryPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const template = this.parseTemplate(content, file);

        if (template) {
          this.templates.set(template.id, template);
        }
      } catch (error) {
        console.error(`Error loading template file ${file}:`, error);
      }
    }

    console.log(`Loaded ${this.templates.size} prompt templates from ${directoryPath}`);
  }

  /**
   * Parse template file with YAML front matter
   */
  private parseTemplate(content: string, filename: string): PromptTemplate | null {
    // Extract YAML front matter
    const frontMatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
    const match = content.match(frontMatterRegex);

    if (!match) {
      console.warn(`No front matter found in ${filename}`);
      return null;
    }

    const [, frontMatter, templateText] = match;

    // Parse YAML front matter
    const metadata: any = {};
    const lines = frontMatter.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const colonIndex = trimmed.indexOf(':');
      if (colonIndex > 0) {
        const key = trimmed.substring(0, colonIndex).trim();
        const value = trimmed.substring(colonIndex + 1).trim();
        metadata[key] = value;
      }
    }

    // Handle inline arrays like "variables: ['user_query', 'request_id']"
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value === 'string' && value.startsWith('[')) {
        const arrayMatch = value.match(/\[(.*?)\]/);
        if (arrayMatch) {
          const items = arrayMatch[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
          metadata[key] = items;
        }
      }
    }

    // Extract variables from template
    const variableMatches = templateText.matchAll(/\{\{(\w+)\}\}/g);
    const extractedVars = Array.from(variableMatches, m => m[1]);
    const variables = metadata.variables || extractedVars;

    return {
      id: metadata.id || path.basename(filename, path.extname(filename)),
      intent: metadata.intent,
      template: templateText.trim(),
      variables: Array.isArray(variables) ? variables : [variables],
      version: metadata.version || '1.0.0'
    };
  }

  /**
   * Get template for intent
   */
  getForIntent(intent: PromptIntent['name']): PromptTemplate | undefined {
    return Array.from(this.templates.values())
      .find(t => t.intent === intent);
  }

  /**
   * Get template by ID
   */
  getById(templateId: string): PromptTemplate | undefined {
    return this.templates.get(templateId);
  }

  /**
   * Render template with variables
   */
  render(templateId: string, variables: Record<string, any>): string {
    const template = this.templates.get(templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }

    // Validate required variables
    const missing = template.variables.filter(v => !(v in variables));
    if (missing.length > 0) {
      throw new Error(`Missing required variables: ${missing.join(', ')}`);
    }

    // Simple {{variable}} substitution
    let result = template.template;
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `{{${key}}}`;
      result = result.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), String(value));
    }

    return result;
  }

  /**
   * Get all loaded template IDs
   */
  listTemplates(): Array<{ id: string; intent: string; version: string }> {
    return Array.from(this.templates.values()).map(t => ({
      id: t.id,
      intent: t.intent,
      version: t.version
    }));
  }
}
