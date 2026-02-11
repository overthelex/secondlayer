import { getLLMManager } from '@secondlayer/shared';
import { logger } from '../utils/logger.js';

export interface ExtractedMetadata {
  documentDate: string | null;
  tags: string[];
  parties: string[];
  jurisdiction: string | null;
  documentSubtype: string | null;
}

const EMPTY_METADATA: ExtractedMetadata = {
  documentDate: null,
  tags: [],
  parties: [],
  jurisdiction: null,
  documentSubtype: null,
};

/**
 * LLM-based metadata extractor for documents.
 * Uses 'quick' tier (gpt-4o-mini) to extract structured metadata
 * from the first 4000 chars of document text.
 */
export class MetadataExtractor {
  /**
   * Extract structured metadata from document text using LLM.
   */
  async extract(
    text: string,
    docType: string,
    title: string
  ): Promise<ExtractedMetadata> {
    if (!text || text.trim().length < 20) {
      return EMPTY_METADATA;
    }

    const snippet = text.slice(0, 4000);

    try {
      const llm = getLLMManager();

      const response = await llm.chatCompletion(
        {
          messages: [
            {
              role: 'system',
              content: `Ти — юридичний асистент. Проаналізуй наданий текст документа і поверни JSON з такими полями:
- "documentDate": дата документа у форматі ISO 8601 (YYYY-MM-DD), або null якщо не знайдено
- "tags": масив до 5 ключових тегів українською (наприклад: "оренда", "нерухомість", "трудовий спір")
- "parties": масив назв сторін/учасників (компанії, особи), до 5
- "jurisdiction": юрисдикція або суд (наприклад: "Господарський суд м. Києва"), або null
- "documentSubtype": підтип документа (наприклад: "договір оренди", "позовна заява", "постанова"), або null

Відповідай ТІЛЬКИ валідним JSON без markdown.`,
            },
            {
              role: 'user',
              content: `Тип документа: ${docType}\nНазва: ${title}\n\nТекст:\n${snippet}`,
            },
          ],
          temperature: 0.1,
          max_tokens: 500,
          response_format: { type: 'json_object' },
        },
        'quick'
      );

      const parsed = JSON.parse(response.content);

      const result: ExtractedMetadata = {
        documentDate: parsed.documentDate || null,
        tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5) : [],
        parties: Array.isArray(parsed.parties) ? parsed.parties.slice(0, 5) : [],
        jurisdiction: parsed.jurisdiction || null,
        documentSubtype: parsed.documentSubtype || null,
      };

      logger.info('[MetadataExtractor] Extracted metadata', {
        title,
        docType,
        documentDate: result.documentDate,
        tagsCount: result.tags.length,
        partiesCount: result.parties.length,
      });

      return result;
    } catch (error: any) {
      logger.warn('[MetadataExtractor] Extraction failed, using defaults', {
        title,
        error: error.message,
      });
      return EMPTY_METADATA;
    }
  }
}
