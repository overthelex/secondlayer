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

    // Task-based intents for court/procedure use cases
    this.intentMapping.set('supreme_court_position', ['court']);
    this.intentMapping.set('procedural_deadlines', ['court', 'npa']);
    this.intentMapping.set('admissibility_and_formal_requirements', ['court', 'npa']);
    this.intentMapping.set('jurisdiction_and_competence', ['court', 'npa']);
    this.intentMapping.set('evidence_and_standards', ['court', 'npa']);
    this.intentMapping.set('interim_measures', ['court', 'npa']);
    this.intentMapping.set('amounts_and_costs', ['court', 'npa']);
    this.intentMapping.set('two_sided_practice', ['court']);
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

Додатково (якщо можливо витягнути з тексту):
6. Task-based intent для судів/процесу: supreme_court_position | procedural_deadlines | admissibility_and_formal_requirements | jurisdiction_and_competence | evidence_and_standards | interim_measures | amounts_and_costs | two_sided_practice
7. Слоти (optional):
   - procedure_code: ЦПК|ГПК|КАС|КПК
   - court_level: first_instance|appeal|cassation|SC|GrandChamber
   - case_category (строка)
   - law_article (строка)
   - section_focus (масив секцій)
   - money_terms: {penalty,inflation,three_percent,legal_fees}
   - desired_output: теза|чеклист|таблиця|підбірка|порівняння

Поверни ТІЛЬКИ валідний JSON без додаткового тексту з полями: intent, confidence, domains, required_entities, sections, time_range (опціонально), reasoning_budget, slots (опціонально).`,
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
        slots: result.slots,
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
    let sections: SectionType[] = [SectionType.COURT_REASONING, SectionType.DECISION];
    const slots: any = {};

    // Slots: procedure_code
    if (lowerQuery.includes('цпк')) slots.procedure_code = 'ЦПК';
    if (lowerQuery.includes('гпк')) slots.procedure_code = 'ГПК';
    if (lowerQuery.includes('кас')) slots.procedure_code = 'КАС';
    if (lowerQuery.includes('кпк')) slots.procedure_code = 'КПК';

    // Slots: desired_output
    if (lowerQuery.includes('чеклист')) slots.desired_output = 'чеклист';
    if (lowerQuery.includes('таблиц')) slots.desired_output = 'таблиця';
    if (lowerQuery.includes('порівня')) slots.desired_output = 'порівняння';
    if (lowerQuery.includes('підбірк') || lowerQuery.includes('підбірка')) slots.desired_output = 'підбірка';

    // Slots: money_terms
    if (lowerQuery.includes('пеня') || lowerQuery.includes('штраф')) {
      slots.money_terms = { ...(slots.money_terms || {}), penalty: true };
    }
    if (lowerQuery.includes('інфляц')) {
      slots.money_terms = { ...(slots.money_terms || {}), inflation: true };
    }
    if (lowerQuery.includes('3%') || lowerQuery.includes('три відсотк') || lowerQuery.includes('три проц')) {
      slots.money_terms = { ...(slots.money_terms || {}), three_percent: true };
    }
    if (lowerQuery.includes('судов') && lowerQuery.includes('витрат')) {
      slots.money_terms = { ...(slots.money_terms || {}), legal_fees: true };
    }

    // Task-based intent hints (courts/procedure)
    if (
      lowerQuery.includes('позиці') ||
      lowerQuery.includes('позиция') ||
      lowerQuery.includes('правов') ||
      lowerQuery.includes('правовой') ||
      (lowerQuery.includes('вс') && lowerQuery.includes('виснов')) ||
      lowerQuery.includes('верховн')
    ) {
      intent = 'supreme_court_position';
      domains.push('court');
      sections = [SectionType.COURT_REASONING];
    } else if (
      lowerQuery.includes('строк') ||
      lowerQuery.includes('поновлен') ||
      lowerQuery.includes('пропуск')
    ) {
      intent = 'procedural_deadlines';
      domains.push('court', 'npa');
      sections = [SectionType.COURT_REASONING, SectionType.DECISION, SectionType.LAW_REFERENCES];
    } else if (
      lowerQuery.includes('без рух') ||
      lowerQuery.includes('повернен') ||
      lowerQuery.includes('без розгляд') ||
      lowerQuery.includes('закритт')
    ) {
      intent = 'admissibility_and_formal_requirements';
      domains.push('court', 'npa');
      sections = [SectionType.COURT_REASONING, SectionType.DECISION, SectionType.LAW_REFERENCES];
    } else if (
      lowerQuery.includes('підсудн') ||
      lowerQuery.includes('юрисдикц') ||
      lowerQuery.includes('підвідомч')
    ) {
      intent = 'jurisdiction_and_competence';
      domains.push('court', 'npa');
      sections = [SectionType.COURT_REASONING, SectionType.LAW_REFERENCES];
    } else if (
      lowerQuery.includes('доказ') ||
      lowerQuery.includes('належн') ||
      lowerQuery.includes('допустим') ||
      lowerQuery.includes('тягар доказ') ||
      lowerQuery.includes('експертиз') ||
      lowerQuery.includes('електронн')
    ) {
      intent = 'evidence_and_standards';
      domains.push('court', 'npa');
      sections = [SectionType.FACTS, SectionType.COURT_REASONING];
    } else if (
      lowerQuery.includes('забезпечен') && (lowerQuery.includes('позов') || lowerQuery.includes('доказ'))
    ) {
      intent = 'interim_measures';
      domains.push('court', 'npa');
      sections = [SectionType.COURT_REASONING, SectionType.LAW_REFERENCES];
    } else if (
      lowerQuery.includes('пеня') ||
      lowerQuery.includes('інфляц') ||
      lowerQuery.includes('3%') ||
      (lowerQuery.includes('судов') && lowerQuery.includes('витрат'))
    ) {
      intent = 'amounts_and_costs';
      domains.push('court', 'npa');
      sections = [SectionType.AMOUNTS, SectionType.COURT_REASONING];
    } else if (
      lowerQuery.includes('за/проти') ||
      lowerQuery.includes('дві ліні') ||
      lowerQuery.includes('две лини') ||
      lowerQuery.includes('неоднорід')
    ) {
      intent = 'two_sided_practice';
      domains.push('court');
      sections = [SectionType.COURT_REASONING, SectionType.DECISION];
    } else if (lowerQuery.includes('споживач') || lowerQuery.includes('затримка') || lowerQuery.includes('доставка')) {
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
      slots: Object.keys(slots).length > 0 ? slots : undefined,
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
    const mapped = this.intentMapping.get(intent.intent);
    if (mapped && mapped.length > 0) {
      return mapped;
    }

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
