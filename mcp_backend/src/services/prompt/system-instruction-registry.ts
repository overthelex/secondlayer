/**
 * ADR-002: SystemInstructionRegistry
 *
 * Central registry for versioned, reusable system instructions.
 * Loads instructions from markdown files with YAML front matter.
 */

import fs from 'fs';
import path from 'path';
import type { SystemInstruction, PromptIntent } from '../../types/prompt.js';

export class SystemInstructionRegistry {
  private instructions: Map<string, SystemInstruction> = new Map();

  constructor(instructionsPath?: string) {
    // Default to src/prompts/system-instructions relative to project root
    const defaultPath = path.join(process.cwd(), 'src/prompts/system-instructions');
    const resolvedPath = instructionsPath || defaultPath;

    this.loadInstructions(resolvedPath);
  }

  /**
   * Load all .md files from instructions directory
   */
  private loadInstructions(directoryPath: string): void {
    if (!fs.existsSync(directoryPath)) {
      console.warn(`System instructions directory not found: ${directoryPath}`);
      console.warn('Creating directory...');
      fs.mkdirSync(directoryPath, { recursive: true });
      return;
    }

    const files = fs.readdirSync(directoryPath).filter(f => f.endsWith('.md'));

    for (const file of files) {
      try {
        const filePath = path.join(directoryPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const instruction = this.parseInstruction(content, file);

        if (instruction) {
          const key = `${instruction.id}@${instruction.version}`;
          this.instructions.set(key, instruction);
          // Also store without version for easy lookup
          this.instructions.set(instruction.id, instruction);
        }
      } catch (error) {
        console.error(`Error loading instruction file ${file}:`, error);
      }
    }

    console.log(`Loaded ${this.instructions.size / 2} system instructions from ${directoryPath}`);
  }

  /**
   * Parse instruction file with YAML front matter
   */
  private parseInstruction(content: string, filename: string): SystemInstruction | null {
    // Extract YAML front matter
    const frontMatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
    const match = content.match(frontMatterRegex);

    if (!match) {
      console.warn(`No front matter found in ${filename}`);
      return null;
    }

    const [, frontMatter, text] = match;

    // Parse YAML front matter (simple key-value parser)
    const metadata: any = {};
    const lines = frontMatter.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Handle simple key: value
      if (!trimmed.startsWith('[') && !trimmed.startsWith('-')) {
        const colonIndex = trimmed.indexOf(':');
        if (colonIndex > 0) {
          const key = trimmed.substring(0, colonIndex).trim();
          const value = trimmed.substring(colonIndex + 1).trim();
          metadata[key] = value;
        }
      }
      // Handle arrays
      else if (trimmed.startsWith('[')) {
        // Find the key from previous line or current line
        const arrayMatch = trimmed.match(/\[(.*?)\]/);
        if (arrayMatch) {
          const arrayContent = arrayMatch[1];
          const items = arrayContent.split(',').map(s => s.trim().replace(/['"]/g, ''));
          // Look for the key
          const keyLine = lines[lines.indexOf(line) - 1];
          if (keyLine) {
            const keyMatch = keyLine.match(/^(\w+):\s*$/);
            if (keyMatch) {
              metadata[keyMatch[1]] = items;
            }
          }
        }
      }
    }

    // Handle inline arrays like "scope: ['legal_reasoning', 'hallucination_check']"
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value === 'string' && value.startsWith('[')) {
        const arrayMatch = value.match(/\[(.*?)\]/);
        if (arrayMatch) {
          const items = arrayMatch[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
          metadata[key] = items;
        }
      }
    }

    // Convert priority to number
    if (metadata.priority) {
      metadata.priority = parseInt(metadata.priority, 10);
    }

    return {
      id: metadata.id || path.basename(filename, '.md'),
      scope: Array.isArray(metadata.scope) ? metadata.scope : [metadata.scope],
      text: text.trim(),
      version: metadata.version || '1.0.0',
      priority: metadata.priority || 10
    };
  }

  /**
   * Get instructions for specific intent
   */
  getForIntent(intent: PromptIntent['name']): SystemInstruction[] {
    return Array.from(this.instructions.values())
      .filter(instr => instr.scope.includes(intent))
      .filter((instr, index, self) =>
        // Remove duplicates (same id appears twice due to versioned/unversioned storage)
        index === self.findIndex(i => i.id === instr.id)
      )
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Get specific instruction by id
   */
  getById(id: string, version?: string): SystemInstruction | undefined {
    const key = version ? `${id}@${version}` : id;
    return this.instructions.get(key);
  }

  /**
   * Compose multiple instructions
   */
  compose(ids: string[]): string {
    return ids
      .map(id => this.getById(id))
      .filter((instr): instr is SystemInstruction => instr !== undefined)
      .map(instr => instr.text)
      .join('\n\n');
  }

  /**
   * Get all loaded instruction IDs
   */
  listInstructions(): string[] {
    return Array.from(this.instructions.values())
      .filter((instr, index, self) =>
        index === self.findIndex(i => i.id === instr.id)
      )
      .map(instr => `${instr.id}@${instr.version}`);
  }
}
