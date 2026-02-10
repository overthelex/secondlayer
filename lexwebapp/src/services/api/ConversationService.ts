/**
 * Conversation Service - HTTP client for server-side chat persistence
 */

import { BaseService } from '../base/BaseService';

export interface Conversation {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking_steps?: any[];
  decisions?: any[];
  citations?: any[];
  tool_calls?: any[];
  cost_tracking_id?: string;
  created_at: string;
}

export interface ConversationWithMessages extends Conversation {
  messages: ConversationMessage[];
}

export class ConversationService extends BaseService {
  async create(title?: string): Promise<Conversation> {
    try {
      const response = await this.client.post<Conversation>('/conversations', { title });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async list(params?: { limit?: number; offset?: number }): Promise<{
    conversations: Conversation[];
    total: number;
  }> {
    try {
      const response = await this.client.get('/conversations', { params });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async get(id: string): Promise<ConversationWithMessages> {
    try {
      const response = await this.client.get<ConversationWithMessages>(`/conversations/${id}`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async rename(id: string, title: string): Promise<void> {
    try {
      await this.client.put(`/conversations/${id}`, { title });
    } catch (error) {
      return this.handleError(error);
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await this.client.delete(`/conversations/${id}`);
    } catch (error) {
      return this.handleError(error);
    }
  }

  async addMessage(
    conversationId: string,
    message: {
      role: 'user' | 'assistant';
      content: string;
      thinking_steps?: any[];
      decisions?: any[];
      citations?: any[];
      tool_calls?: any[];
      cost_tracking_id?: string;
    }
  ): Promise<ConversationMessage> {
    try {
      const response = await this.client.post<ConversationMessage>(
        `/conversations/${conversationId}/messages`,
        message
      );
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async getMessages(
    conversationId: string,
    params?: { limit?: number; offset?: number }
  ): Promise<{ messages: ConversationMessage[] }> {
    try {
      const response = await this.client.get(`/conversations/${conversationId}/messages`, {
        params,
      });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }
}

export const conversationService = new ConversationService();
