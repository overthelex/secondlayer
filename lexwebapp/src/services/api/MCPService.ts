/**
 * MCP Service
 * Service for calling all 43 MCP tools (sync + streaming)
 * Supports mcp_backend, mcp_rada, and mcp_openreyestr tools
 */

import { BaseService } from '../base/BaseService';
import { SSEClient } from './SSEClient';
import {
  Message,
  ThinkingStep,
  Decision,
  Citation,
} from '../../types/models';
import {
  SearchCourtCasesParams,
  SearchLegislationParams,
  MCPToolParams,
  MCPToolResult,
  Tool,
} from '../../types/api/mcp-tools';
import { StreamingCallbacks } from '../../types/api/sse';

export interface CitationWarning {
  case_number: string;
  status: 'explicitly_overruled' | 'limited';
  confidence: number;
  affecting_decisions: Array<{ doc_id: string; instance: string; court: string; date?: string; outcome: string; effect: string }>;
  message: string;
}

export interface ChatStreamCallbacks {
  onPlan?: (data: { goal: string; steps: Array<{ id: number; tool: string; params: Record<string, any>; purpose: string; depends_on?: number[] }>; expected_iterations: number }) => void;
  onThinking?: (data: { step: number; tool: string; params: any; description?: string; cost_usd?: number }) => void;
  onToolResult?: (data: { tool: string; result: any; cost_usd?: number }) => void;
  onAnswerDelta?: (data: { text: string }) => void;
  onAnswer?: (data: { text: string; provider: string; model: string }) => void;
  onCitationWarning?: (data: CitationWarning) => void;
  onComplete?: (data: { iterations: number; elapsed_ms: number; tools_used?: string[]; total_cost_usd?: number; credits_deducted?: number }) => void;
  onCostSummary?: (data: { credits_deducted: number; new_balance_credits: number; balance_usd: number | null }) => void;
  onError?: (data: { message: string }) => void;
}

export class MCPService extends BaseService {
  private readonly API_URL: string;
  private readonly API_KEY: string;
  private readonly sseClient: SSEClient;
  private readonly enableSSE: boolean;

  constructor() {
    super();
    const baseUrl = import.meta.env.VITE_API_URL || 'https://stage.legal.org.ua';
    this.API_URL = `${baseUrl}/api`;
    this.API_KEY =
      import.meta.env.VITE_API_KEY ||
      'REDACTED_SL_KEY_STAGE';
    this.enableSSE =
      import.meta.env.VITE_ENABLE_SSE_STREAMING !== 'false';
    this.sseClient = new SSEClient(this.API_URL, this.API_KEY);
  }

  /**
   * Get the current auth token (JWT from localStorage takes priority over API key)
   */
  private getAuthToken(): string {
    return localStorage.getItem('auth_token') || this.API_KEY;
  }

  // ============================================================================
  // Universal Tool Methods
  // ============================================================================

  /**
   * Call any MCP tool synchronously (no streaming)
   */
  async callTool(toolName: string, params: any): Promise<any> {
    try {
      const response = await fetch(`${this.API_URL}/tools/${toolName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.getAuthToken()}`,
        },
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API Error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      return data;
    } catch (error: any) {
      console.error(`Tool ${toolName} error:`, error);
      throw error;
    }
  }

  /**
   * Call any MCP tool with SSE streaming
   */
  async streamTool(
    toolName: string,
    params: any,
    callbacks: StreamingCallbacks
  ): Promise<AbortController> {
    if (!this.enableSSE) {
      // Fallback to sync mode if SSE disabled
      try {
        const result = await this.callTool(toolName, params);
        callbacks.onComplete?.({ result });
        callbacks.onEnd?.();
      } catch (error: any) {
        callbacks.onError?.({ message: error.message, error });
      }
      return new AbortController(); // Return dummy controller
    }

    return this.sseClient.streamToolWithRetry(toolName, params, callbacks, this.getAuthToken());
  }

  /**
   * Stream AI chat (agentic LLM loop with tool calling)
   * POST /api/chat → SSE events: thinking, tool_result, answer, complete
   */
  async streamChat(
    query: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    callbacks: ChatStreamCallbacks,
    budget: string = 'standard',
    conversationId?: string
  ): Promise<AbortController> {
    const controller = new AbortController();

    try {
      const response = await fetch(`${this.API_URL}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.getAuthToken()}`,
        },
        body: JSON.stringify({ query, history, budget, conversationId }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        callbacks.onError?.({ message: `API Error: ${response.status} - ${errorText}` });
        return controller;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        callbacks.onError?.({ message: 'No response body' });
        return controller;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      const processEvents = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Parse SSE events from buffer
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // keep incomplete line in buffer

            let currentEvent = '';
            let currentData = '';

            for (const line of lines) {
              // Skip SSE heartbeat comments
              if (line.startsWith(':')) continue;

              if (line.startsWith('event: ')) {
                currentEvent = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                currentData = line.slice(6);
              } else if (line === '' && currentEvent && currentData) {
                // End of event — dispatch
                try {
                  const data = JSON.parse(currentData);
                  switch (currentEvent) {
                    case 'plan':
                      callbacks.onPlan?.(data);
                      break;
                    case 'thinking':
                      callbacks.onThinking?.(data);
                      break;
                    case 'tool_result':
                      callbacks.onToolResult?.(data);
                      break;
                    case 'answer_delta':
                      callbacks.onAnswerDelta?.(data);
                      break;
                    case 'answer':
                      callbacks.onAnswer?.(data);
                      break;
                    case 'citation_warning':
                      callbacks.onCitationWarning?.(data);
                      break;
                    case 'complete':
                      callbacks.onComplete?.(data);
                      break;
                    case 'cost_summary':
                      callbacks.onCostSummary?.(data);
                      break;
                    case 'error':
                      callbacks.onError?.(data);
                      break;
                  }
                } catch {
                  // skip malformed JSON
                }
                currentEvent = '';
                currentData = '';
              }
            }
          }
        } catch (err: any) {
          if (err.name !== 'AbortError') {
            callbacks.onError?.({ message: err.message });
          }
        }
      };

      processEvents();
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        callbacks.onError?.({ message: err.message });
      }
    }

    return controller;
  }

  /**
   * List all available tools
   */
  async listAvailableTools(): Promise<Tool[]> {
    try {
      const response = await fetch(`${this.API_URL}/tools`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.getAuthToken()}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch tools: ${response.status}`);
      }

      const data = await response.json();
      return data.tools || [];
    } catch (error) {
      console.error('Failed to list tools:', error);
      return [];
    }
  }

  // ============================================================================
  // Type-Safe Wrappers for Popular Tools
  // ============================================================================

  /**
   * Get legal advice (most popular tool)
   */
  async getLegalAdvice(params: GetLegalAdviceParams): Promise<Message> {
    try {
      const response = await this.callTool('get_legal_advice', {
        query: params.query,
        max_precedents: params.max_precedents || 5,
        include_reasoning: params.include_reasoning !== false,
      });

      const parsedResult = this.parseBackendResponse(response);
      return this.transformToMessage(parsedResult, 'get_legal_advice');
    } catch (error) {
      return this.handleErrorAsMessage(error);
    }
  }

  /**
   * Get legal advice with streaming
   */
  async getLegalAdviceStreaming(
    params: GetLegalAdviceParams,
    callbacks: StreamingCallbacks
  ): Promise<AbortController> {
    return this.streamTool(
      'get_legal_advice',
      {
        query: params.query,
        max_precedents: params.max_precedents || 5,
        include_reasoning: params.include_reasoning !== false,
      },
      callbacks
    );
  }

  /**
   * Search court cases
   */
  async searchCourtCases(params: SearchCourtCasesParams): Promise<any> {
    return this.callTool('search_legal_precedents', params);
  }

  /**
   * Search court cases with streaming
   */
  async searchCourtCasesStreaming(
    params: SearchCourtCasesParams,
    callbacks: StreamingCallbacks
  ): Promise<AbortController> {
    return this.streamTool('search_legal_precedents', params, callbacks);
  }

  /**
   * Search legislation
   */
  async searchLegislation(params: SearchLegislationParams): Promise<any> {
    return this.callTool('search_legislation', params);
  }

  /**
   * Search legislation with streaming
   */
  async searchLegislationStreaming(
    params: SearchLegislationParams,
    callbacks: StreamingCallbacks
  ): Promise<AbortController> {
    return this.streamTool('search_legislation', params, callbacks);
  }

  // ============================================================================
  // Response Parsing and Transformation
  // ============================================================================

  /**
   * Parse backend response structure
   */
  private parseBackendResponse(data: any): any {
    let parsedResult: any = {};

    try {
      // Backend returns result in content[0].text as JSON string
      if (data.result?.content?.[0]?.text) {
        parsedResult = JSON.parse(data.result.content[0].text);
      } else if (data.result) {
        parsedResult = data.result;
      } else {
        parsedResult = data;
      }
    } catch (e) {
      console.warn('Failed to parse result content:', e);
      parsedResult = data;
    }

    return parsedResult;
  }

  /**
   * Transform tool result to Message model
   */
  transformToolResultToMessage(toolName: string, result: any): Message {
    const parsedResult = this.parseBackendResponse(result);
    return this.transformToMessage(parsedResult, toolName);
  }

  /**
   * Transform API response to Message model
   */
  private transformToMessage(response: any, toolName: string): Message {
    // Different tools return different structures
    // Adapt based on tool type
    let content = '';
    let thinkingSteps: ThinkingStep[] | undefined;
    let decisions: Decision[] | undefined;
    let citations: Citation[] | undefined;

    // Handle get_legal_advice format
    if (
      toolName === 'get_legal_advice' ||
      toolName === 'packaged_lawyer_answer'
    ) {
      content =
        response.summary ||
        response.answer ||
        response.result?.answer ||
        'Відповідь отримано від backend.';

      thinkingSteps = this.transformThinkingSteps(response.reasoning_chain);
      decisions = this.transformDecisions(response.precedent_chunks);
      citations = this.transformCitations(response.source_attribution);
    }
    // Handle search tools
    else if (
      toolName.includes('search') ||
      toolName.includes('find') ||
      toolName.includes('classify')
    ) {
      content = this.formatSearchResults(response);
    }
    // Handle document tools
    else if (toolName.includes('document') || toolName.includes('parse')) {
      content = this.formatDocumentResults(response);
    }
    // Handle legislation tools
    else if (toolName.includes('legislation')) {
      content = this.formatLegislationResults(response);
    }
    // Default format
    else {
      content = JSON.stringify(response, null, 2);
    }

    return {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content,
      isStreaming: false,
      thinkingSteps,
      decisions,
      citations,
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
   * Format search results for display
   */
  private formatSearchResults(response: any): string {
    if (response.cases && Array.isArray(response.cases)) {
      return `Знайдено справ: ${response.total || response.cases.length}\n\n${response.cases
        .map(
          (c: any, i: number) =>
            `${i + 1}. ${c.case_number || c.number || 'N/A'}\n   Суд: ${c.court || 'N/A'}\n   Дата: ${c.date || 'N/A'}\n   ${c.summary || c.category || ''}`
        )
        .join('\n\n')}`;
    }

    if (response.precedents && Array.isArray(response.precedents)) {
      return `Знайдено прецедентів: ${response.total || response.precedents.length}\n\n${response.precedents
        .map(
          (p: any, i: number) =>
            `${i + 1}. ${p.case_number}\n   Схожість: ${Math.round(p.similarity * 100)}%\n   ${p.summary}`
        )
        .join('\n\n')}`;
    }

    if (response.legislation && Array.isArray(response.legislation)) {
      return `Знайдено законів: ${response.legislation.length}\n\n${response.legislation
        .map((l: any, i: number) => `${i + 1}. ${l.title}\n   Тип: ${l.type}`)
        .join('\n\n')}`;
    }

    return JSON.stringify(response, null, 2);
  }

  /**
   * Format document results for display
   */
  private formatDocumentResults(response: any): string {
    if (response.text) {
      return response.text;
    }

    if (response.sections && Array.isArray(response.sections)) {
      return response.sections
        .map((s: any) => `## ${s.name}\n\n${s.content}`)
        .join('\n\n---\n\n');
    }

    if (response.documents && Array.isArray(response.documents)) {
      return response.documents
        .map((d: any) => `### Документ: ${d.document_id}\n\n${d.text}`)
        .join('\n\n---\n\n');
    }

    return JSON.stringify(response, null, 2);
  }

  /**
   * Format legislation results for display
   */
  private formatLegislationResults(response: any): string {
    if (response.text) {
      return `# ${response.legislation_id} - Стаття ${response.article_number}\n\n${response.text}${response.context ? `\n\n---\n\n${response.context}` : ''}`;
    }

    if (response.content) {
      return `# ${response.legislation_id} - ${response.section_name}\n\n${response.content}`;
    }

    if (response.articles && Array.isArray(response.articles)) {
      return response.articles
        .map(
          (a: any) =>
            `## Стаття ${a.article_number}\n\n${a.text || a.content}`
        )
        .join('\n\n---\n\n');
    }

    return JSON.stringify(response, null, 2);
  }

  /**
   * Handle errors and return error message
   */
  private handleErrorAsMessage(error: any): Message {
    console.error('MCP Service error:', error);
    return {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: `Вибачте, сталася помилка: ${error.message || 'Невідома помилка'}. Будь ласка, спробуйте пізніше.`,
      isStreaming: false,
    };
  }
}

// Export singleton instance
export const mcpService = new MCPService();
