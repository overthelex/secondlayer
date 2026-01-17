import { QueryIntent, SectionType } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { getOpenAIManager } from '../utils/openai-client.js';
import { ModelSelector } from '../utils/model-selector.js';

export class QueryPlanner {
  private openaiManager = getOpenAIManager();
  private intentMapping: Map<string, string[]> = new Map();

  constructor() {

    // Initialize intent to endpoint mapping
    this.intentMapping.set('consumer_penalty_delay', ['court', 'npa']);
    this.intentMapping.set('tax_dispute', ['court', 'npa']);
    this.intentMapping.set('labor_dispute', ['court', 'echr']);
    this.intentMapping.set('property_dispute', ['court']);
    this.intentMapping.set('general_search', ['court', 'npa', 'echr']);
  }

  async classifyIntent(query: string, budget: 'quick' | 'standard' | 'deep' = 'standard'): Promise<QueryIntent> {
    // For quick budget, use simple keyword matching
    if (budget === 'quick') {
      return this.quickIntentClassification(query);
    }

    // For standard/deep, use LLM
    try {
      const response = await this.openaiManager.executeWithRetry(async (client) => {
        // Select model based on budget
        const model = ModelSelector.getChatModel(budget);
        const supportsJsonMode = ModelSelector.supportsJsonMode(model);
        
        const requestConfig: any = {
          model: model,
          messages: [
            {
              role: 'system',
              content: `Ти експерт з класифікації юридичних запитів. Проаналізуй запит та визнач:
1. Intent (наприклад: consumer_penalty_delay, tax_dispute, labor_dispute)
2. Домени (court, npa, echr)
3. Необхідні сутності (law_article, seller, consumer, etc.)
4. Типи секцій (FACTS, CLAIMS, COURT_REASONING, DECISION, LAW_REFERENCES, AMOUNTS)
5. Часовий діапазон (якщо вказано)

Поверни ТІЛЬКИ валідний JSON без додаткового тексту з полями: intent, confidence, domains, required_entities, sections, time_range (опціонально), reasoning_budget.`,
            },
            {
              role: 'user',
              content: query,
            },
          ],
          temperature: 0.3,
          max_tokens: 500,
        };

        if (supportsJsonMode) {
          requestConfig.response_format = { type: 'json_object' };
        }

        return await client.chat.completions.create(requestConfig);
      });

      let content = response.choices[0].message.content || '{}';
      
      // Extract JSON from markdown code blocks if present
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      if (jsonMatch) {
        content = jsonMatch[1];
      }
      
      // Try to extract JSON object from text
      const jsonObjectMatch = content.match(/\{[\s\S]*\}/);
      if (jsonObjectMatch) {
        content = jsonObjectMatch[0];
      }
      
      const result = JSON.parse(content);
      
      return {
        intent: result.intent || 'general_search',
        confidence: result.confidence || 0.7,
        domains: result.domains || ['court'],
        required_entities: result.required_entities || [],
        sections: (result.sections || ['COURT_REASONING', 'DECISION']).map((s: string) => s as SectionType),
        time_range: result.time_range,
        reasoning_budget: budget,
      };
    } catch (error) {
      logger.error('Intent classification error:', error);
      return this.quickIntentClassification(query);
    }
  }

  private quickIntentClassification(query: string): QueryIntent {
    const lowerQuery = query.toLowerCase();
    
    let intent = 'general_search';
    const domains: string[] = [];
    const sections: SectionType[] = [SectionType.COURT_REASONING, SectionType.DECISION];

    if (lowerQuery.includes('споживач') || lowerQuery.includes('затримка') || lowerQuery.includes('доставка')) {
      intent = 'consumer_penalty_delay';
      domains.push('court', 'npa');
    } else if (lowerQuery.includes('податк') || lowerQuery.includes('налог')) {
      intent = 'tax_dispute';
      domains.push('court', 'npa');
    } else if (lowerQuery.includes('прац') || lowerQuery.includes('трудов')) {
      intent = 'labor_dispute';
      domains.push('court', 'echr');
    } else {
      domains.push('court');
    }

    return {
      intent,
      confidence: 0.6,
      domains: domains.length > 0 ? domains : ['court'],
      required_entities: [],
      sections,
      reasoning_budget: 'quick',
    };
  }

  buildQueryParams(intent: QueryIntent, searchQuery?: string): any {
    const where: any[] = [];
    const meta: any = {};

    // Always use text search - API handles case numbers well in full-text mode
    if (searchQuery) {
      meta.search = searchQuery;
    }

    // Add domain-specific filters
    if (intent.domains.includes('court')) {
      // Court-specific filters can be added here if needed
      // Note: API doesn't require type filter for court decisions endpoint
    }

    // Add time range if specified
    if (intent.time_range) {
      where.push({
        field: 'date_publ',
        operator: '$gte',
        value: intent.time_range.from,
      });
      where.push({
        field: 'date_publ',
        operator: '$lte',
        value: intent.time_range.to,
      });
    }

    // Add required entities as search terms
    if (intent.required_entities.length > 0) {
      meta.search_entities = intent.required_entities;
    }

    // Default order by publication date descending
    meta.order = { date_publ: 'desc' };

    return {
      where,
      meta,
      limit: 50,
      offset: 0,
    };
  }

  selectEndpoints(intent: QueryIntent): string[] {
    const endpoints: string[] = [];
    
    if (intent.domains.includes('court')) {
      endpoints.push('court');
    }
    if (intent.domains.includes('npa')) {
      endpoints.push('npa');
    }
    if (intent.domains.includes('echr')) {
      endpoints.push('echr');
    }

    return endpoints.length > 0 ? endpoints : ['court'];
  }
}
