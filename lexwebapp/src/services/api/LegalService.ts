/**
 * Legal Service
 * Handles all legal-related API calls
 */

import { BaseService } from '../base/BaseService';
import { Message, ThinkingStep, Decision, Citation } from '../../types/models';
import {
  GetLegalAdviceRequest,
  GetLegalAdviceResponse,
  SearchCourtCasesRequest,
} from '../../types/api';

export class LegalService extends BaseService {
  private readonly API_URL: string;
  private readonly API_KEY: string;

  constructor() {
    super();
    this.API_URL = import.meta.env.VITE_API_URL || 'https://dev.legal.org.ua/api';
    this.API_KEY =
      import.meta.env.VITE_API_KEY ||
      'c3462787ee0a9b45a1102cc195a65f8ce82c7609242aab5628d4a111c52727b4';
  }

  /**
   * Get legal advice from AI
   */
  async getLegalAdvice(request: GetLegalAdviceRequest): Promise<Message> {
    try {
      const response = await fetch(`${this.API_URL}/tools/get_legal_advice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.API_KEY}`,
        },
        body: JSON.stringify({
          query: request.query,
          max_precedents: request.max_precedents || 5,
        }),
      });

      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }

      const data = await response.json();

      // Parse the response
      const parsedResult = this.parseBackendResponse(data);

      // Transform to Message format
      return this.transformToMessage(parsedResult);
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Parse backend response structure
   */
  private parseBackendResponse(data: any): GetLegalAdviceResponse {
    let parsedResult: any = {};

    try {
      // Backend returns result in content[0].text as JSON string
      if (data.result?.content?.[0]?.text) {
        parsedResult = JSON.parse(data.result.content[0].text);
      }
    } catch (e) {
      console.warn('Failed to parse result content:', e);
    }

    return {
      answer:
        parsedResult.summary ||
        parsedResult.answer ||
        data.result?.answer ||
        data.answer ||
        'Відповідь отримано від backend.',
      summary: parsedResult.summary,
      reasoning_chain: parsedResult.reasoning_chain,
      precedent_chunks: parsedResult.precedent_chunks,
      source_attribution: parsedResult.source_attribution,
    };
  }

  /**
   * Transform API response to Message model
   */
  private transformToMessage(response: GetLegalAdviceResponse): Message {
    return {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: response.answer,
      isStreaming: false,
      thinkingSteps: this.transformThinkingSteps(response.reasoning_chain),
      decisions: this.transformDecisions(response.precedent_chunks),
      citations: this.transformCitations(response.source_attribution),
    };
  }

  /**
   * Transform reasoning chain to thinking steps
   */
  private transformThinkingSteps(
    reasoningChain?: any[]
  ): ThinkingStep[] | undefined {
    if (!reasoningChain || reasoningChain.length === 0) {
      return undefined;
    }

    return reasoningChain.map((step, index) => ({
      id: `s${index + 1}`,
      title: `Крок ${step.step || index + 1}: ${step.action || 'Обробка'}`,
      content: step.output
        ? JSON.stringify(step.output, null, 2)
        : step.explanation || '',
      isComplete: true,
    }));
  }

  /**
   * Transform precedent chunks to decisions
   */
  private transformDecisions(precedentChunks?: any[]): Decision[] | undefined {
    if (!precedentChunks || precedentChunks.length === 0) {
      return undefined;
    }

    return precedentChunks.map((prec, index) => ({
      id: `d${index + 1}`,
      number: prec.case_number || prec.number || `Справа ${index + 1}`,
      court: prec.court || 'Невідомий суд',
      date: prec.date || '',
      summary: prec.summary || prec.reasoning || prec.content || '',
      relevance: Math.round((prec.similarity || prec.relevance || 0.5) * 100),
      status: 'active',
    }));
  }

  /**
   * Transform source attribution to citations
   */
  private transformCitations(
    sourceAttribution?: any[]
  ): Citation[] | undefined {
    if (!sourceAttribution || sourceAttribution.length === 0) {
      return undefined;
    }

    return sourceAttribution.map((src, index) => ({
      text: src.text || src.content || '',
      source: src.citation || src.source || `Джерело ${index + 1}`,
    }));
  }

  /**
   * Search court cases
   */
  async searchCourtCases(request: SearchCourtCasesRequest): Promise<any> {
    try {
      const response = await this.client.post('/api/tools/search_court_cases', request);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Get document text
   */
  async getDocumentText(documentId: string): Promise<any> {
    try {
      const response = await this.client.post('/api/tools/get_document_text', {
        document_id: documentId,
      });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }
}

// Export singleton instance
export const legalService = new LegalService();
