import { DocumentSection, SectionType } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { getOpenAIManager } from '../utils/openai-client.js';
import { ModelSelector } from '../utils/model-selector.js';

interface SectionMarker {
  type: SectionType;
  patterns: RegExp[];
  priority: number;
}

export class SemanticSectionizer {
  private openaiManager = getOpenAIManager();
  private markers: SectionMarker[];

  constructor() {

    // Initialize regex markers for Ukrainian legal documents
    this.markers = [
      {
        type: SectionType.FACTS,
        patterns: [
          /встановив[а-яіїє]*/gi,
          /встановлено/gi,
          /фактичні обставини/gi,
        ],
        priority: 1,
      },
      {
        type: SectionType.CLAIMS,
        patterns: [
          /позивач просить/gi,
          /вимагає/gi,
          /позовні вимоги/gi,
        ],
        priority: 2,
      },
      {
        type: SectionType.LAW_REFERENCES,
        patterns: [
          /згідно зі ст\./gi,
          /відповідно до/gi,
          /на підставі/gi,
          /ст\.\s*\d+/gi,
        ],
        priority: 3,
      },
      {
        type: SectionType.COURT_REASONING,
        patterns: [
          /суд вважає/gi,
          /суд встановлює/gi,
          /суд приходить до висновку/gi,
          /обґрунтування/gi,
        ],
        priority: 4,
      },
      {
        type: SectionType.DECISION,
        patterns: [
          /ухвалив/gi,
          /постановив/gi,
          /рішення/gi,
          /резолютивна частина/gi,
        ],
        priority: 5,
      },
      {
        type: SectionType.AMOUNTS,
        patterns: [
          /сума\s+\d+/gi,
          /штраф\s+\d+/gi,
          /компенсація\s+\d+/gi,
          /\d+\s+гривень/gi,
        ],
        priority: 6,
      },
    ];
  }

  async extractSections(
    text: string,
    useLLM: boolean = false
  ): Promise<DocumentSection[]> {
    const sections: DocumentSection[] = [];

    // First pass: regex-based extraction
    for (const marker of this.markers.sort((a, b) => a.priority - b.priority)) {
      for (const pattern of marker.patterns) {
        // Reset regex state to prevent infinite loops
        pattern.lastIndex = 0;

        let match;
        let iterationCount = 0;
        const MAX_ITERATIONS = 1000; // Safety limit

        while ((match = pattern.exec(text)) !== null) {
          // Safety check to prevent infinite loops
          if (++iterationCount > MAX_ITERATIONS) {
            logger.warn('Max iterations reached for pattern', {
              pattern: pattern.source,
              type: marker.type
            });
            break;
          }

          const startIndex = match.index;
          const endIndex = this.findSectionEnd(text, startIndex, marker.type);

          // Check for overlap with existing sections
          const overlaps = sections.some(
            (s) =>
              (startIndex >= s.start_index && startIndex < s.end_index) ||
              (endIndex > s.start_index && endIndex <= s.end_index)
          );

          if (!overlaps && endIndex > startIndex) {
            sections.push({
              type: marker.type,
              text: text.substring(startIndex, endIndex),
              start_index: startIndex,
              end_index: endIndex,
              confidence: 0.8,
            });
          }

          // If pattern has no global flag or didn't advance, break to prevent infinite loop
          if (!pattern.global || pattern.lastIndex === 0 || pattern.lastIndex <= startIndex) {
            break;
          }
        }

        // Reset regex state after use
        pattern.lastIndex = 0;
      }
    }

    // Calculate confidence and validate
    for (const section of sections) {
      section.confidence = this.calculateConfidence(section, text);
    }

    // Filter low-confidence sections
    const validSections = sections.filter((s) => s.confidence >= 0.5);

    // If confidence is low and LLM is allowed, use LLM-assisted extraction
    if (useLLM && validSections.length === 0) {
      return await this.llmAssistedExtraction(text);
    }

    return validSections.sort((a, b) => a.start_index - b.start_index);
  }

  private findSectionEnd(text: string, startIndex: number, _sectionType: SectionType): number {
    // Find the end of section based on type
    const maxLength = 5000; // Max section length
    let endIndex = startIndex + maxLength;

    // Look for next section marker or paragraph break
    const nextMarkerIndex = this.findNextMarker(text, startIndex + 100);
    if (nextMarkerIndex > 0 && nextMarkerIndex < endIndex) {
      endIndex = nextMarkerIndex;
    }

    // Look for paragraph breaks
    const paragraphBreak = text.indexOf('\n\n', startIndex + 100);
    if (paragraphBreak > 0 && paragraphBreak < endIndex) {
      endIndex = paragraphBreak;
    }

    // Ensure we don't exceed text length
    return Math.min(endIndex, text.length);
  }

  private findNextMarker(text: string, startIndex: number): number {
    let minIndex = -1;
    for (const marker of this.markers) {
      for (const pattern of marker.patterns) {
        pattern.lastIndex = startIndex;
        const match = pattern.exec(text);
        if (match && (minIndex === -1 || match.index < minIndex)) {
          minIndex = match.index;
        }
      }
    }
    return minIndex;
  }

  private calculateConfidence(section: DocumentSection, _fullText: string): number {
    let confidence = 0.7;

    // Boost confidence if section has expected keywords
    const marker = this.markers.find((m) => m.type === section.type);
    if (marker) {
      const matches = marker.patterns.filter((p) => p.test(section.text));
      confidence += matches.length * 0.1;
    }

    // Reduce confidence if section is too short
    if (section.text.length < 50) {
      confidence -= 0.2;
    }

    // Reduce confidence if section is too long
    if (section.text.length > 10000) {
      confidence -= 0.1;
    }

    return Math.min(1.0, Math.max(0.0, confidence));
  }

  private async llmAssistedExtraction(text: string): Promise<DocumentSection[]> {
    try {
      const response = await this.openaiManager.executeWithRetry(async (client) => {
        // Use deep model for complex section extraction
        const model = ModelSelector.getChatModel('deep');
        return await client.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content: `Ти експерт з аналізу юридичних документів. Розбий текст на семантичні секції:
- FACTS: Фактичні обставини
- CLAIMS: Позовні вимоги
- LAW_REFERENCES: Посилання на норми права
- COURT_REASONING: Судебне обґрунтування
- DECISION: Резолютивна частина
- AMOUNTS: Суми, штрафи, компенсації

Поверни JSON масив з об'єктами: { type, text, start_index, end_index, confidence }`,
          },
          {
            role: 'user',
            content: text.substring(0, 8000), // Limit to avoid token limits
          },
        ],
          ...(ModelSelector.supportsTemperature(model) ? { temperature: 0.2 } : {}),
          max_completion_tokens: 2000,
          response_format: { type: 'json_object' },
        });
      });

      const result = JSON.parse(response.choices[0].message.content || '{}');
      return (result.sections || []).map((s: any) => ({
        type: s.type as SectionType,
        text: s.text,
        start_index: s.start_index || 0,
        end_index: s.end_index || s.text.length,
        confidence: s.confidence || 0.7,
      }));
    } catch (error) {
      logger.error('LLM-assisted extraction error:', error);
      return [];
    }
  }
}
